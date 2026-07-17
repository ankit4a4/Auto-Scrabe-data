const { fetchWithAutoDetect } = require("./renderModeDetector");
const {
  detectPatternFromHtml,
  COMMON_PATTERNS,
} = require("./paginationBuilder");
const { extractPostLinksWithDates } = require("./linkExtractor");
const { extractArticle } = require("./contentExtractor");
const { extractEntities } = require("./entityExtractor");
const { clickThroughPagination } = require("./loadMoreExpander");
const { parseDateSafe, formatDateForLog } = require("../utils/dateUtils");
const config = require("../config");

// Small concurrency-limiter (no extra library needed)
async function runWithLimit(items, limit, worker) {
  const results = [];
  let index = 0;

  async function next() {
    if (index >= items.length) return;
    const currentIndex = index++;
    const item = items[currentIndex];
    try {
      results[currentIndex] = await worker(item);
    } catch (err) {
      results[currentIndex] = { error: err.message, item };
    }
    await next();
  }

  const runners = Array.from({ length: Math.min(limit, items.length) }, next);
  await Promise.all(runners);
  return results;
}

/**
 * Sequentially crawls category pages (page 1, 2, 3, ...) and extracts post
 * links + (if available) date hints from each page.
 *
 * Efficiency trick: if the category listing shows a date (common with
 * WordPress-style themes), and that date is OLDER than startDate, we assume
 * (since listings are chronological) that later pages will have even older
 * posts - so we stop crawling after that page. If the listing doesn't show
 * a date (dateHint is null), we play it safe and keep crawling up to
 * maxPagesToCrawl, with the final decision based on the accurate date
 * fetched from each post's own page.
 */
async function collectPostsInDateRange({
  categoryUrl,
  startDate,
  endDate,
  page1Html,
  log,
}) {
  const seen = new Set();
  const candidates = []; // { url, dateHint }
  const detectedPattern = detectPatternFromHtml(page1Html, categoryUrl);

  let pageNum = 1;
  let html = page1Html;
  let stopAfterThisPage = false;

  while (pageNum <= config.maxPagesToCrawl) {
    if (pageNum > 1) {
      const pageUrl = detectedPattern
        ? detectedPattern(categoryUrl, pageNum)
        : COMMON_PATTERNS[0](categoryUrl, pageNum);

      try {
        const result = await fetchWithAutoDetect(pageUrl);
        html = result.html;
      } catch (err) {
        log(`Page ${pageNum} could not be loaded, stopping: ${err.message}`);
        break;
      }
    }

    const linksWithDates = extractPostLinksWithDates(html, categoryUrl);
    let newOnThisPage = 0;
    let hadAnyDateHint = false;

    for (const { url, dateHint } of linksWithDates) {
      if (seen.has(url)) continue;
      seen.add(url);
      newOnThisPage++;

      const parsedHint = parseDateSafe(dateHint);

      if (parsedHint) {
        hadAnyDateHint = true;
        if (parsedHint < startDate) {
          // Older than range - don't make this a candidate, and the next
          // page will likely be even older too (assuming chronological listing)
          stopAfterThisPage = true;
          continue;
        }
      }

      // Within range, or date unknown (will be confirmed from the post's own page)
      candidates.push({ url, dateHint: parsedHint });
    }

    log(
      `Page ${pageNum}: found ${linksWithDates.length} post links, ${newOnThisPage} new ` +
        `(candidates so far: ${candidates.length}${hadAnyDateHint ? "" : ", no date shown in listing"})`,
    );

    if (pageNum > 1 && newOnThisPage === 0) {
      // URL-based pagination didn't yield anything new. Two possibilities:
      // (a) pagination has genuinely ended, OR
      // (b) this site uses JS-driven pagination where the URL doesn't
      //     change - whether via a "Load More" button (append-style) or a
      //     numbered "Next" arrow (replace-style, as with forbesindia.com) -
      //     it doesn't matter to us what the underlying mechanism is, we
      //     just look for a human-like control and click it.
      // This fallback is only tried the first time (pageNum===2) - if that
      // also yields nothing new, we assume pagination has truly ended.
      if (pageNum === 2) {
        log(
          `No new posts found via Page 2 URL - checking for JS-driven pagination (Load More/Next button)...`,
        );
        try {
          const { candidates: clickCandidates, stepsDone } =
            await clickThroughPagination({
              categoryUrl,
              startDate,
              maxSteps: config.maxLoadMoreClicks,
              onProgress: log,
            });

          let newFromExpansion = 0;
          for (const { url, dateHint } of clickCandidates) {
            if (seen.has(url)) continue;
            seen.add(url);
            newFromExpansion++;

            if (dateHint && dateHint < startDate) {
              continue; // older than range, don't make it a candidate
            }
            candidates.push({ url, dateHint });
          }

          if (stepsDone > 0) {
            log(
              `Click-based pagination found ${newFromExpansion} new posts (candidates so far: ${candidates.length})`,
            );
          } else {
            log(
              `No click-based pagination control found - pagination appears to have ended`,
            );
          }
        } catch (err) {
          log(`Error while trying click-based pagination: ${err.message}`);
        }
      } else {
        log(
          `No new posts found on page ${pageNum}, pagination appears to have ended`,
        );
      }
      break;
    }

    if (stopAfterThisPage) {
      log(
        `Found posts older than the range on page ${pageNum}, stopping further crawling`,
      );
      break;
    }

    pageNum++;
  }

  return candidates;
}

/**
 * Main entry point: takes a category URL + startDate/endDate (JS Date
 * objects, inclusive range). Crawls category pages to find posts in that
 * date range and extracts structured data from them.
 *
 * Date matching is a 2-step process:
 *  1. If the category listing provides a date hint, it's used for
 *     pagination early-stop (for efficiency)
 *  2. The FINAL decision always uses the actual publish-date from the
 *     post's own page (accurate) - the listing hint was just an estimate
 *
 * If a post's date cannot be determined at all (neither from the listing
 * nor the post's own page), it is SKIPPED as "date unknown" - we never guess.
 *
 * Save condition (per company): at least one name in ownerNames AND a
 * businessName - BOTH are required. City is just a bonus field.
 * Business-relevance filter: non-business content (movies/entertainment/
 * general-news) is automatically filtered out by the AI.
 * Partnership case: ownerNames is an ARRAY, so 2+ owners can appear.
 * Multi-company case: a single post/article can yield multiple companies
 * (e.g. roundup articles) as separate entries - they are never mixed together.
 */
async function runScrapePipeline({
  categoryUrl,
  startDate,
  endDate,
  onProgress,
}) {
  const log = (msg) => onProgress && onProgress(msg);

  log(`Loading category page: ${categoryUrl}`);
  const { html: page1Html } = await fetchWithAutoDetect(categoryUrl);

  log(
    `Target date range: ${formatDateForLog(startDate)} to ${formatDateForLog(endDate)}, starting to crawl pages...`,
  );
  const candidates = await collectPostsInDateRange({
    categoryUrl,
    startDate,
    endDate,
    page1Html,
    log,
  });

  if (candidates.length === 0) {
    log(`No posts found around this date range.`);
    return { totalPostsFound: 0, totalSaved: 0, entries: [], skipReasons: {} };
  }

  let targetLinks = candidates;
  if (candidates.length > config.maxDateRangePosts) {
    log(
      `Found ${candidates.length} candidate posts in range, which exceeds the max limit (${config.maxDateRangePosts}). ` +
        `Only the first ${config.maxDateRangePosts} will be processed - try a smaller range or increase MAX_DATE_RANGE_POSTS.`,
    );
    targetLinks = candidates.slice(0, config.maxDateRangePosts);
  }

  log(`${targetLinks.length} posts will be processed for this date range`);

  // Process each post: fetch -> confirm actual date -> extract content -> AI extract -> check conditions
  const skipReasons = {
    noContent: 0,
    aiError: 0,
    noEntities: 0,
    fetchError: 0,
    outOfDateRange: 0,
    dateUnknown: 0,
  };
  const sampleErrors = [];

  const processed = await runWithLimit(
    targetLinks,
    config.concurrency,
    async ({ url: postUrl }) => {
      let html;
      try {
        const result = await fetchWithAutoDetect(postUrl);
        html = result.html;
      } catch (err) {
        skipReasons.fetchError++;
        if (sampleErrors.length < 3)
          sampleErrors.push(`Fetch failed (${postUrl}): ${err.message}`);
        return null;
      }

      const article = extractArticle(html, postUrl);

      if (!article.textContent || article.textContent.length < 50) {
        skipReasons.noContent++;
        return null;
      }

      // FINAL date check - using the actual publish-date from the post's
      // own page (the category listing's date-hint was just an estimate,
      // this is the real one)
      const actualDate = parseDateSafe(article.publishDate);
      if (!actualDate) {
        skipReasons.dateUnknown++;
        return null; // couldn't confirm the date - we never guess, safely skipped
      }
      if (actualDate < startDate || actualDate > endDate) {
        skipReasons.outOfDateRange++;
        return null;
      }

      let companies;
      try {
        companies = await extractEntities(article); // returns an ARRAY - each company is a separate entry
      } catch (err) {
        skipReasons.aiError++;
        if (sampleErrors.length < 3)
          sampleErrors.push(
            `AI extraction failed (${postUrl}): ${err.message}`,
          );
        return null;
      }

      // SAVE CONDITION (per company): at least one owner name AND a business
      // name, both are required. A single post/article can qualify MULTIPLE
      // companies (e.g. a roundup article) - each becomes its own separate entry.
      const validCompanies = (companies || []).filter(
        (c) => (c.ownerNames && c.ownerNames.length > 0) || c.businessName,
      );

      if (validCompanies.length === 0) {
        skipReasons.noEntities++;
        return null;
      }

      return validCompanies.map((c) => ({
        ownerNames: c.ownerNames,
        businessName: c.businessName,
        city: c.city,
        publishDate: formatDateForLog(actualDate),
        sourceUrl: postUrl,
      }));
    },
  );

  const finalEntries = processed
    .filter((result) => Array.isArray(result)) // removes both null (skipped) and {error} entries
    .flat(); // flattens multiple company-entries that came from a single post

  log(
    `Final saved entries (companies): ${finalEntries.length} (from ${targetLinks.length} posts processed - ` +
      `a single post can yield multiple companies)`,
  );
  log(
    `Skip breakdown -> no content: ${skipReasons.noContent}, fetch errors: ${skipReasons.fetchError}, ` +
      `AI errors: ${skipReasons.aiError}, no owner/business found: ${skipReasons.noEntities}, ` +
      `out of date range (confirmed via post's own page): ${skipReasons.outOfDateRange}, ` +
      `date unknown (skipped, never guessed): ${skipReasons.dateUnknown}`,
  );
  sampleErrors.forEach((e) => log(`ERROR SAMPLE: ${e}`));

  return {
    totalPostsFound: targetLinks.length,
    totalSaved: finalEntries.length,
    entries: finalEntries,
    skipReasons,
  };
}

module.exports = { runScrapePipeline };

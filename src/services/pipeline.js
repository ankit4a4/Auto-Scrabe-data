const { fetchWithAutoDetect } = require("./renderModeDetector");
const { detectPatternFromHtml, COMMON_PATTERNS } = require("./paginationBuilder");
const { extractPostLinksWithDates } = require("./linkExtractor");
const { extractArticle } = require("./contentExtractor");
const { extractEntities } = require("./entityExtractor");
const { clickThroughPagination } = require("./loadMoreExpander");
const { parseDateSafe, formatDateForLog } = require("../utils/dateUtils");
const config = require("../config");

// Small concurrency-limiter (without any extra library)
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
 * Crawls category pages sequentially (page 1, 2, 3, ...) and extracts post
 * links + (if available) date hints from each page.
 *
 * Efficiency trick: if the category listing shows a date (common in
 * WordPress-style themes), and that date is OLDER than startDate, we assume
 * (since it's a chronological listing) that the following pages will be
 * even older - so we stop crawling after that page. If the listing doesn't
 * show a date (dateHint is null), we play it safe and keep crawling up to
 * maxPagesToCrawl, and the final decision is made from each post's own page
 * for an accurate date.
 */
async function collectPostsInDateRange({ categoryUrl, startDate, endDate, page1Html, log }) {
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
          // Older than the range - don't make this post a candidate, and
          // the next page will likely be even older too (chronological listing assumption)
          stopAfterThisPage = true;
          continue;
        }
      }

      // Within range, or date unknown (will be confirmed from the post's own page)
      candidates.push({ url, dateHint: parsedHint });
    }

    log(
      `Page ${pageNum}: found ${linksWithDates.length} post links, ${newOnThisPage} new ` +
        `(candidates so far: ${candidates.length}${hadAnyDateHint ? "" : ", no date shown in listing"})`
    );

    if (pageNum > 1 && newOnThisPage === 0) {
      // Nothing new found via URL-based pagination. Two possibilities:
      // (a) pagination genuinely ended, OR
      // (b) this site uses JS-driven pagination where the URL doesn't
      //     change at all - whether it's a "Load More" button (append-style)
      //     or a numbered "Next" arrow (replace-style, like forbesindia.com
      //     has) - it doesn't matter what the underlying mechanism is,
      //     we just find a human-like control and click it.
      // We only try this fallback the first time (pageNum===2) - if
      // nothing new is found there either, we assume pagination truly ended.
      if (pageNum === 2) {
        log(`No new post found via page 2 URL - checking JS-driven pagination (Load More/Next button)...`);
        try {
          const { candidates: clickCandidates, stepsDone } = await clickThroughPagination({
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
              continue; // older than the range, don't make it a candidate
            }
            candidates.push({ url, dateHint });
          }

          if (stepsDone > 0) {
            log(`Found ${newFromExpansion} new posts via click-based pagination (candidates so far: ${candidates.length})`);
          } else {
            log(`No click-based pagination control found - pagination looks like it has ended`);
          }
        } catch (err) {
          log(`Error while trying click-based pagination: ${err.message}`);
        }
      } else {
        log(`No new post found on page ${pageNum}, pagination looks like it has ended`);
      }
      break;
    }

    if (stopAfterThisPage) {
      log(`Found posts older than the range on page ${pageNum}, stopping further crawling`);
      break;
    }

    pageNum++;
  }

  return candidates;
}

/**
 * Main entry point: takes categoryUrl + startDate/endDate (JS Date objects,
 * inclusive range). Crawls the category pages and finds posts within that
 * date range, then extracts structured data from them.
 *
 * Date matching is a 2-step process:
 *  1. If a date-hint is available from the category listing, it's used for
 *     early-stopping the pagination (for efficiency)
 *  2. The FINAL decision is always made from the post's own page's actual
 *     publish-date (accurate) - the listing hint was only an estimate
 *
 * If a post's date can't be determined at all (neither in the listing nor
 * on the post page), that post is SKIPPED as "date unknown" - it is never
 * guessed.
 *
 * Save condition (per company): at least one owner name OR a businessName
 * is required - either one is enough, both are not mandatory. City is just
 * a bonus field.
 * Business-relevance filter: non-business content like movie/entertainment/
 * general-news is filtered out by the AI itself.
 * Partnership case: ownerNames is an ARRAY, so 2+ owners can also come in.
 * Multi-company case: a single post/article can produce multiple companies
 * (roundup articles) as separate entries - they are never mixed together.
 */
async function runScrapePipeline({ categoryUrl, startDate, endDate, onProgress }) {
  const log = (msg) => onProgress && onProgress(msg);

  log(`Loading category page: ${categoryUrl}`);
  const { html: page1Html } = await fetchWithAutoDetect(categoryUrl);

  log(`Target date range: ${formatDateForLog(startDate)} to ${formatDateForLog(endDate)}, starting to crawl pages...`);
  const candidates = await collectPostsInDateRange({ categoryUrl, startDate, endDate, page1Html, log });

  if (candidates.length === 0) {
    log(`No post found around this date range.`);
    return { totalPostsFound: 0, totalSaved: 0, entries: [], skipReasons: {} };
  }

  let targetLinks = candidates;
  if (candidates.length > config.maxDateRangePosts) {
    log(
      `Found ${candidates.length} candidate posts in range, which is more than the max limit (${config.maxDateRangePosts}). ` +
        `Only the first ${config.maxDateRangePosts} will be processed - try a smaller range or increase MAX_DATE_RANGE_POSTS.`
    );
    targetLinks = candidates.slice(0, config.maxDateRangePosts);
  }

  log(`${targetLinks.length} posts will be processed for this date range`);

  // Process each post: fetch -> confirm actual date -> extract content -> AI extract -> condition check
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
        if (sampleErrors.length < 3) sampleErrors.push(`Fetch failed (${postUrl}): ${err.message}`);
        return null;
      }

      const article = extractArticle(html, postUrl);

      if (!article.textContent || article.textContent.length < 50) {
        skipReasons.noContent++;
        return null;
      }

      // FINAL date check - from the post's own page's actual publish-date
      // (the category listing date-hint was only an estimate, this is the real one)
      const actualDate = parseDateSafe(article.publishDate);
      if (!actualDate) {
        skipReasons.dateUnknown++;
        return null; // date could not be confirmed - never guess, skip to be safe
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
        if (sampleErrors.length < 3) sampleErrors.push(`AI extraction failed (${postUrl}): ${err.message}`);
        return null;
      }

      // SAVE CONDITION (per company): at least one owner name OR a business
      // name is enough - either one qualifies, both are not required.
      // A single post/article can qualify MULTIPLE companies (e.g. a roundup
      // article) - each one becomes its own separate entry.
      const validCompanies = (companies || []).filter(
        (c) => (c.ownerNames && c.ownerNames.length > 0) || c.businessName
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
    }
  );

  const finalEntries = processed
    .filter((result) => Array.isArray(result)) // remove both null (skipped) and {error}
    .flat(); // flatten multiple company-entries that came from a single post

  log(
    `Final saved entries (companies): ${finalEntries.length} (from ${targetLinks.length} posts processed - ` +
      `a single post can produce multiple companies)`
  );
  log(
    `Skip breakdown -> no content: ${skipReasons.noContent}, fetch errors: ${skipReasons.fetchError}, ` +
      `AI errors: ${skipReasons.aiError}, no owner/business found: ${skipReasons.noEntities}, ` +
      `out of date range (confirmed from post-page date): ${skipReasons.outOfDateRange}, ` +
      `date unknown (skipped, not guessed): ${skipReasons.dateUnknown}`
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

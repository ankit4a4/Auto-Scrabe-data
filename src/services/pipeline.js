const { fetchWithAutoDetect } = require("./renderModeDetector");
const { detectPatternFromHtml, COMMON_PATTERNS } = require("./paginationBuilder");
const { extractPostLinksWithDates } = require("./linkExtractor");
const { extractArticle } = require("./contentExtractor");
const { extractEntities } = require("./entityExtractor");
const { clickThroughPagination } = require("./loadMoreExpander");
const { parseDateSafe, formatDateForLog } = require("../utils/dateUtils");
const config = require("../config");

// Chhota concurrency-limiter (bina extra library ke)
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
 * Category pages ko sequentially crawl karta hai (page 1, 2, 3, ...) aur har
 * page se post links + (agar mile to) date hints nikalta hai.
 *
 * Efficiency trick: agar category listing me date dikh rahi ho (WordPress
 * jaisi themes me aksar hoti hai), aur wo date startDate se PURANI ho, to
 * hum maan lete hain ki (chronological listing hone ki wajah se) aage ke
 * pages aur bhi purane posts honge - isliye us page ke baad crawl rok dete
 * hain. Agar listing me date na dikhe (dateHint null), to hum safe side
 * lete hain aur maxPagesToCrawl tak crawl karte rehte hain, final decision
 * har post ke apne page se accurate date nikaal ke lete hain.
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
        log(`Page ${pageNum} load nahi ho paya, ruk rahe hain: ${err.message}`);
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
          // Range se purana - is post ko candidate mat banao, aur agla
          // page bhi shayad aur purana hoga (chronological listing maan ke)
          stopAfterThisPage = true;
          continue;
        }
      }

      // Range ke andar hai, ya date pata nahi (post ke apne page se confirm hoga)
      candidates.push({ url, dateHint: parsedHint });
    }

    log(
      `Page ${pageNum}: ${linksWithDates.length} post links mile, ${newOnThisPage} naye ` +
        `(candidates ab tak: ${candidates.length}${hadAnyDateHint ? "" : ", listing me date nahi dikhi"})`
    );

    if (pageNum > 1 && newOnThisPage === 0) {
      // URL-based pagination se kuch naya nahi mila. Do possibilities hain:
      // (a) sach me pagination khatam ho gayi, YA
      // (b) ye site JS-driven pagination use karti hai jahan URL change hi
      //     nahi hota - chahe "Load More" button ho (append-style) ya
      //     numbered "Next" arrow ho (replace-style, jaisa forbesindia.com
      //     pe hai) - hume iske underlying mechanism se farq nahi padta,
      //     hum bas ek human jaisa control dhoondke click karte hain.
      // Sirf pehli baar (pageNum===2) hi ye fallback try karte hain - agar
      // wahan bhi kuch naya na mile, to sach me pagination khatam maan lete hain.
      if (pageNum === 2) {
        log(`Page 2 URL se koi naya post nahi mila - JS-driven pagination (Load More/Next button) check kar rahe hain...`);
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
              continue; // range se purana, candidate mat banao
            }
            candidates.push({ url, dateHint });
          }

          if (stepsDone > 0) {
            log(`Click-based pagination se ${newFromExpansion} naye posts mile (candidates ab tak: ${candidates.length})`);
          } else {
            log(`Koi click-based pagination control nahi mila - pagination end lag raha hai`);
          }
        } catch (err) {
          log(`Click-based pagination try karte waqt error: ${err.message}`);
        }
      } else {
        log(`Page ${pageNum} pe koi naya post nahi mila, pagination end lag raha hai`);
      }
      break;
    }

    if (stopAfterThisPage) {
      log(`Page ${pageNum} pe range se purane posts mil gaye, aage crawl karna band kar rahe hain`);
      break;
    }

    pageNum++;
  }

  return candidates;
}

/**
 * Main entry point: category URL + startDate/endDate (JS Date objects,
 * inclusive range) leta hai. Category pages crawl karke us date-range ke
 * posts dhoondta hai aur unse structured data nikaalta hai.
 *
 * Date matching 2-step hai:
 *  1. Category listing se date-hint milti hai to usse pagination early-stop
 *     hota hai (efficiency ke liye)
 *  2. FINAL decision hamesha post ke apne page ke actual publish-date se
 *     hoti hai (accurate) - listing hint sirf ek estimate thi
 *
 * Agar kisi post ki date bilkul pata na chale (na listing me, na post page
 * pe), to us post ko "date unknown" maan ke SKIP kiya jaata hai - guess
 * kabhi nahi karte.
 *
 * Save condition (per company): ownerNames me se kam se kam ek naam AUR
 * businessName - DONO zaroor hone chahiye. City sirf bonus field hai.
 * Business-relevance filter: movie/entertainment/general-news jaisa
 * non-business content AI khud filter kar deta hai.
 * Partnership case: ownerNames ek ARRAY hai, 2+ owners bhi aa sakte hain.
 * Multi-company case: ek hi post/article se multiple companies (roundup
 * articles) alag-alag entries banati hain, kabhi mix nahi hoti.
 */
async function runScrapePipeline({ categoryUrl, startDate, endDate, onProgress }) {
  const log = (msg) => onProgress && onProgress(msg);

  log(`Category page load ho raha hai: ${categoryUrl}`);
  const { html: page1Html } = await fetchWithAutoDetect(categoryUrl);

  log(`Target date range: ${formatDateForLog(startDate)} se ${formatDateForLog(endDate)} tak, pages crawl karna shuru...`);
  const candidates = await collectPostsInDateRange({ categoryUrl, startDate, endDate, page1Html, log });

  if (candidates.length === 0) {
    log(`Is date range ke aas-paas koi post nahi mila.`);
    return { totalPostsFound: 0, totalSaved: 0, entries: [], skipReasons: {} };
  }

  let targetLinks = candidates;
  if (candidates.length > config.maxDateRangePosts) {
    log(
      `Range me ${candidates.length} candidate posts mile, jo max limit (${config.maxDateRangePosts}) se zyada hai. ` +
        `Sirf pehle ${config.maxDateRangePosts} process honge - chhota range try karo ya MAX_DATE_RANGE_POSTS badhao.`
    );
    targetLinks = candidates.slice(0, config.maxDateRangePosts);
  }

  log(`${targetLinks.length} posts process honge is date range ke liye`);

  // Har post ko process karo: fetch -> actual date confirm -> content extract -> AI extract -> condition check
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

      // FINAL date check - post ke apne page ke actual publish-date se
      // (category listing wali date-hint sirf ek estimate thi, ye asli hai)
      const actualDate = parseDateSafe(article.publishDate);
      if (!actualDate) {
        skipReasons.dateUnknown++;
        return null; // date confirm nahi ho payi - guess nahi karte, safe side skip
      }
      if (actualDate < startDate || actualDate > endDate) {
        skipReasons.outOfDateRange++;
        return null;
      }

      let companies;
      try {
        companies = await extractEntities(article); // ARRAY milta hai - har company alag entry
      } catch (err) {
        skipReasons.aiError++;
        if (sampleErrors.length < 3) sampleErrors.push(`AI extraction failed (${postUrl}): ${err.message}`);
        return null;
      }

      // SAVE CONDITION (per company): kam se kam ek owner name AUR business name,
      // dono zaroori hain. Ek hi post/article se MULTIPLE companies qualify ho
      // sakti hain (jaise roundup article) - har ek apni alag entry banati hai.
      const validCompanies = (companies || []).filter(
        (c) => c.ownerNames && c.ownerNames.length > 0 && c.businessName
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
    .filter((result) => Array.isArray(result)) // null (skip) aur {error} dono hata do
    .flat(); // ek post se aayi multiple company-entries ko flatten karo

  log(
    `Final saved entries (companies): ${finalEntries.length} (from ${targetLinks.length} posts processed - ` +
      `ek post se multiple companies bhi aa sakti hain)`
  );
  log(
    `Skip breakdown -> no content: ${skipReasons.noContent}, fetch errors: ${skipReasons.fetchError}, ` +
      `AI errors: ${skipReasons.aiError}, no owner/business found: ${skipReasons.noEntities}, ` +
      `out of date range (post-page date se confirm hua): ${skipReasons.outOfDateRange}, ` +
      `date unknown (skip kiya, guess nahi kiya): ${skipReasons.dateUnknown}`
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

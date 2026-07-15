const { getNewPage } = require("./browserManager");
const { extractPostLinksWithDates } = require("./linkExtractor");
const { parseDateSafe } = require("../utils/dateUtils");
const config = require("../config");

// "Load More" pattern (new content is APPENDED after the EXISTING content)
const LOAD_MORE_SELECTORS = [
  "button:has-text('Load More')",
  "button:has-text('Load more')",
  "button:has-text('Show More')",
  "button:has-text('Show more')",
  "button:has-text('View More')",
  "a:has-text('Load More')",
  "a:has-text('Show More')",
  "a:has-text('View More')",
  "[class*='load-more']",
  "[class*='loadmore']",
  "[class*='load_more']",
  "[class*='show-more']",
  "[id*='load-more']",
  "[id*='loadmore']",
];

// "Next page" pattern (numbered pagination like forbesindia.com has -
// content is REPLACED, URL doesn't change). We do NOT check what
// mechanism (React state/AJAX/whatever) the site is using -
// we just find a human-like "Next" button/arrow and click it.
const NEXT_PAGE_SELECTORS = [
  "[aria-label='Next']",
  "[aria-label*='Next' i]",
  "[aria-label*='next page' i]",
  "a.next",
  "button.next",
  ".pagination-next",
  "li.next a",
  "[class*='pagination'] [class*='next']",
  "a:has-text('›')",
  "a:has-text('»')",
  "button:has-text('›')",
  "button:has-text('»')",
  "button:has-text('Next')",
  "a:has-text('Next')",
];

// Try each round in the sequence of both arrays - click whichever is found first
const ALL_ADVANCE_SELECTORS = [...LOAD_MORE_SELECTORS, ...NEXT_PAGE_SELECTORS];

function linksSignature(links) {
  return links.map((l) => l.url).join("|");
}

/**
 * When pagination on a category page is JS-driven (URL doesn't change -
 * whether it's a "Load More" button (append-style) or a numbered "Next"
 * arrow (replace-style, like forbesindia.com has) - this function DOESN'T
 * CARE what the underlying mechanism is. It just does this:
 *   1. Capture the "signature" (list of post-links) of the current content
 *   2. Find any advance-control (Load More OR Next arrow) and click it
 *   3. Check whether the content's signature changed or not
 *   4. If it changed -> collect new links, try again
 *   5. If not, or if no control was found at all -> stop
 *
 * Date-aware early stop: if the date-hint of posts found at some step turns
 * out to be older than startDate, we stop clicking further (assuming a
 * chronological listing) - since a category can have up to 100 pages,
 * we shouldn't need to click through all of them.
 */
async function clickThroughPagination({ categoryUrl, startDate, maxSteps, onProgress }) {
  const log = (msg) => onProgress && onProgress(msg);
  const { page, context } = await getNewPage();

  const collected = new Map(); // url -> dateHint (parsed Date | null)
  let stepsDone = 0;
  let stopEarly = false;

  try {
    await page.goto(categoryUrl, {
      waitUntil: "domcontentloaded",
      timeout: config.pageTimeout,
    });
    try {
      await page.waitForLoadState("networkidle", { timeout: 5000 });
    } catch {
      /* persistent background activity - ignore, continue */
    }

    for (let step = 0; step <= maxSteps; step++) {
      const html = await page.content();
      const links = extractPostLinksWithDates(html, categoryUrl);

      let newCount = 0;
      for (const { url, dateHint } of links) {
        if (collected.has(url)) continue;
        const parsedHint = parseDateSafe(dateHint);
        collected.set(url, parsedHint);
        newCount++;

        if (parsedHint && parsedHint < startDate) {
          stopEarly = true;
        }
      }

      log(
        `"Next"/pagination step ${step + 1}: found ${links.length} links, ${newCount} new ` +
          `(total so far: ${collected.size})`
      );

      if (stopEarly) {
        log(`Found posts older than the range, stopping "Next" clicks`);
        break;
      }

      if (step >= maxSteps) break; // safety cap reached

      const signatureBefore = linksSignature(links);
      const urlBefore = page.url();

      let clicked = false;
      let contentActuallyChanged = false;
      let matchedSelector = null;
      let matchedText = null;

      for (const selector of ALL_ADVANCE_SELECTORS) {
        try {
          const btn = page.locator(selector).first();
          const visible = await btn.isVisible({ timeout: 800 }).catch(() => false);
          if (!visible) continue;

          matchedSelector = selector;
          matchedText = (await btn.textContent().catch(() => null))?.trim().slice(0, 40) || null;

          await btn.scrollIntoViewIfNeeded();
          await btn.click({ timeout: 3000 });
          clicked = true;
          stepsDone++;

          // Wait for the content to change - until the signature (post-links
          // list) changes, or max 5 seconds (whichever comes first). This
          // works for both append-style and replace-style pagination.
          contentActuallyChanged = await page
            .waitForFunction(
              (prevSignature) => {
                const articles = document.querySelectorAll("article a, .post a, .entry a");
                const current = Array.from(articles)
                  .map((a) => a.href)
                  .join("|");
                return current !== prevSignature && current.length > 0;
              },
              signatureBefore,
              { timeout: 5000 }
            )
            .then(() => true)
            .catch(() => false);

          await page.waitForTimeout(700); // a bit of extra settle time
          break;
        } catch {
          /* click didn't work with this selector, try the next one */
        }
      }

      const urlAfter = page.url();
      log(
        `  -> click attempt: selector="${matchedSelector || "none"}", text="${matchedText || "N/A"}", ` +
          `content_changed=${contentActuallyChanged}, url_before="${urlBefore}", url_after="${urlAfter}"`
      );

      if (!clicked) {
        log(`No "Load More"/"Next" control found after step ${step + 1} - pagination looks like it has ended`);
        break;
      }

      if (!contentActuallyChanged) {
        // The click happened (element was found, click succeeded), but the
        // content stayed the same - meaning this same element would keep
        // getting clicked repeatedly with no effect (like a disabled button,
        // or a wrong element match). Continuing further won't help, so we stop.
        log(`Click happened but content didn't change - pagination is limited to this point, stopping`);
        break;
      }
    }

    return {
      candidates: Array.from(collected.entries()).map(([url, dateHint]) => ({ url, dateHint })),
      stepsDone,
    };
  } finally {
    await context.close();
  }
}

module.exports = { clickThroughPagination };

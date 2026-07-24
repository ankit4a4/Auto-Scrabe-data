const { getNewPage } = require("./browserManager");
const { extractPostLinksWithDates, CONTAINER_LINK_SELECTOR } = require("./linkExtractor");
const { parseDateSafe } = require("../utils/dateUtils");
const config = require("../config");

// Common cookie-consent / GDPR-banner "accept" buttons. These often sit
// directly on top of the "Load More"/"Next" control and silently block
// Playwright's click (the click "succeeds" on the overlay, not the real
// button) - so we try to dismiss them once before pagination begins.
const COOKIE_DISMISS_SELECTORS = [
  "#onetrust-accept-btn-handler",
  "[id*='cookie'] button:has-text('Accept')",
  "[class*='cookie'] button:has-text('Accept')",
  "button:has-text('Accept All')",
  "button:has-text('Accept all')",
  "button:has-text('I Agree')",
  "button:has-text('I agree')",
  "button:has-text('Got it')",
  "[aria-label='Close']",
  "[class*='consent'] button:has-text('Accept')",
];

async function dismissCookieBanner(page, log) {
  for (const selector of COOKIE_DISMISS_SELECTORS) {
    try {
      const btn = page.locator(selector).first();
      const visible = await btn.isVisible({ timeout: 500 }).catch(() => false);
      if (visible) {
        await btn.click({ timeout: 2000 }).catch(() => {});
        log && log(`Dismissed a cookie/consent banner via "${selector}"`);
        await page.waitForTimeout(300);
        return true;
      }
    } catch {
      /* selector not present, try next */
    }
  }
  return false;
}

// "Load More" pattern (new content is APPENDED after existing content)
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

// "Next page" pattern (numbered pagination like forbesindia.com - content
// is REPLACED, URL doesn't change). We do NOT check which mechanism
// (React state/AJAX/whatever) the site uses - we just look for a
// human-like "Next" button/arrow and click it.
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

// Try both arrays in sequence each round - click whichever is found first
const ALL_ADVANCE_SELECTORS = [...LOAD_MORE_SELECTORS, ...NEXT_PAGE_SELECTORS];

function linksSignature(links) {
  return links.map((l) => l.url).join("|");
}

/**
 * When category-page pagination is JS-driven (URL doesn't change) - whether
 * via a "Load More" button (append-style) or a numbered "Next" arrow
 * (replace-style, as with forbesindia.com) - this function doesn't care
 * about the underlying mechanism. It simply:
 *   1. Captures a "signature" of the current content (list of post-links)
 *   2. Finds any advance-control (Load More OR Next arrow) and clicks it
 *   3. Checks whether the content's signature changed
 *   4. If it changed -> collect the new links, try again
 *   5. If not, or if no control was found -> stop
 *
 * Date-aware early stop: if a step's posts have a date-hint older than
 * startDate, further clicking stops (assuming chronological listing) -
 * since a category can have up to 100 pages, we don't want to click
 * through all of them.
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
      /* persistent background activity - ignore, proceed anyway */
    }

    await dismissCookieBanner(page, log);

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

          // Wait for content to change - the post-links signature changing,
          // or up to 5 seconds (whichever comes first). This works for both
          // append-style and replace-style pagination.
          // IMPORTANT: this selector must match extractPostLinksWithDates's
          // own container logic (CONTAINER_LINK_SELECTOR), otherwise a real
          // content change on a site using e.g. ".post-card"/".entry-item"
          // wrappers would look "unchanged" here and pagination would stop
          // early even though new posts genuinely loaded.
          contentActuallyChanged = await page
            .waitForFunction(
              ({ prevSignature, selector }) => {
                const links = document.querySelectorAll(selector);
                const current = Array.from(links)
                  .map((a) => a.href)
                  .join("|");
                return current !== prevSignature && current.length > 0;
              },
              { prevSignature: signatureBefore, selector: CONTAINER_LINK_SELECTOR },
              { timeout: 5000 }
            )
            .then(() => true)
            .catch(() => false);

          await page.waitForTimeout(700); // a bit of extra settle time
          break;
        } catch {
          /* click via this selector didn't work, try the next one */
        }
      }

      const urlAfter = page.url();
      log(
        `  -> click attempt: selector="${matchedSelector || "none"}", text="${matchedText || "N/A"}", ` +
          `content_changed=${contentActuallyChanged}, url_before="${urlBefore}", url_after="${urlAfter}"`
      );

      if (!clicked) {
        // No button/link control found at all - this can also mean the site
        // uses pure scroll-triggered infinite loading (new posts appear as
        // the user scrolls down, with no "Load More"/"Next" element ever
        // present). Try scrolling to the bottom once and see if that alone
        // brings in new content before giving up.
        log(`No "Load More"/"Next" control found at step ${step + 1} - trying scroll-triggered loading instead`);

        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));

        const scrollChanged = await page
          .waitForFunction(
            ({ prevSignature, selector }) => {
              const links = document.querySelectorAll(selector);
              const current = Array.from(links)
                .map((a) => a.href)
                .join("|");
              return current !== prevSignature && current.length > 0;
            },
            { prevSignature: signatureBefore, selector: CONTAINER_LINK_SELECTOR },
            { timeout: 4000 }
          )
          .then(() => true)
          .catch(() => false);

        if (!scrollChanged) {
          log(`Scrolling didn't load new content either - pagination appears to have ended`);
          break;
        }

        log(`Scroll-triggered loading brought in new content, continuing`);
        await page.waitForTimeout(700);
        stepsDone++;
        continue;
      }

      if (!contentActuallyChanged) {
        // The click happened (element found, click executed), but the
        // content stayed the same - meaning we're likely clicking the same
        // element repeatedly with no effect (e.g. a disabled button, or a
        // wrong element match). Continuing further won't help, so we stop.
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
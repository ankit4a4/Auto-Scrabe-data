const { getNewPage } = require("./browserManager");
const { extractPostLinksWithDates } = require("./linkExtractor");
const { parseDateSafe } = require("../utils/dateUtils");
const config = require("../config");

// "Load More" pattern (naya content EXISTING content ke aage APPEND hota hai)
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

// "Next page" pattern (numbered pagination jaisa forbesindia.com pe hai -
// content REPLACE hota hai, URL change nahi hota). Hum ye NAHI check karte
// ki site kaunsa mechanism (React state/AJAX/whatever) use kar rahi hai -
// bas ek human jaisa "Next" button/arrow dhoondte hain aur click karte hain.
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

// Do arrays ke sequence me har round try karte hain - jo bhi mile pehle usko click karo
const ALL_ADVANCE_SELECTORS = [...LOAD_MORE_SELECTORS, ...NEXT_PAGE_SELECTORS];

function linksSignature(links) {
  return links.map((l) => l.url).join("|");
}

/**
 * Category page pe pagination JS-driven ho (URL change nahi hota - chahe
 * "Load More" button ho (append-style) ya numbered "Next" arrow ho
 * (replace-style, jaisa forbesindia.com pe hai) - is function ko FARAQ NAHI
 * PADTA ki underlying mechanism kya hai. Bas itna karta hai:
 *   1. Current content ka "signature" (post-links ki list) capture karo
 *   2. Koi bhi advance-control (Load More YA Next arrow) dhoondke click karo
 *   3. Content ka signature change hua ya nahi check karo
 *   4. Agar change hua -> naye links collect karo, dobara try karo
 *   5. Agar nahi hua, ya koi control hi nahi mila -> ruk jaao
 *
 * Date-aware early stop: agar kisi step pe mile posts ki date-hint
 * startDate se purani ho jaaye, to aage click karna band kar dete hain
 * (chronological listing maan ke) - kyunki category me 100 pages tak ho
 * sakti hain, hume sabko click karke nahi jaana.
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
      /* persistent background activity - ignore, aage badho */
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
        `"Next"/pagination step ${step + 1}: ${links.length} links mile, ${newCount} naye ` +
          `(total ab tak: ${collected.size})`
      );

      if (stopEarly) {
        log(`Range se purane posts mil gaye, "Next" click karna band kar rahe hain`);
        break;
      }

      if (step >= maxSteps) break; // safety cap pahunch gaya

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

          // Content change hone ka wait karo - signature (post-links list)
          // change hone tak, ya max 5 second (jo pehle ho). Ye append-style
          // aur replace-style dono pagination ke liye kaam karta hai.
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

          await page.waitForTimeout(700); // thoda extra settle time
          break;
        } catch {
          /* is selector se click nahi hui, agla try karo */
        }
      }

      const urlAfter = page.url();
      log(
        `  -> click attempt: selector="${matchedSelector || "none"}", text="${matchedText || "N/A"}", ` +
          `content_changed=${contentActuallyChanged}, url_before="${urlBefore}", url_after="${urlAfter}"`
      );

      if (!clicked) {
        log(`Step ${step + 1} ke baad koi "Load More"/"Next" control nahi mila - pagination end lag raha hai`);
        break;
      }

      if (!contentActuallyChanged) {
        // Click hua (element mila, click bhi hua), lekin content wahi ka wahi
        // reh gaya - matlab ye ab wahi element baar-baar click ho raha hoga
        // bina asar ke (jaise disabled button, ya galat element match ho raha
        // hai). Isse aage badhna faayda nahi dega, isliye ruk jaate hain.
        log(`Click hua lekin content change nahi hua - pagination yahi tak limited hai, ruk rahe hain`);
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

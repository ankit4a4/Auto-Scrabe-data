const cheerio = require("cheerio");

// Common pagination URL patterns (WordPress, generic query params, etc.)
const COMMON_PATTERNS = [
  (base, n) => appendPath(base, `page/${n}/`),
  (base, n) => appendQuery(base, "paged", n),
  (base, n) => appendQuery(base, "page", n),
  (base, n) => appendPath(base, `page/${n}`),
  (base, n) => appendPath(base, `p/${n}`),
];

function appendPath(base, suffix) {
  const url = new URL(base);
  let pathname = url.pathname;
  if (!pathname.endsWith("/")) pathname += "/";
  url.pathname = pathname + suffix;
  return url.toString();
}

function appendQuery(base, key, value) {
  const url = new URL(base);
  url.searchParams.set(key, value);
  return url.toString();
}

/**
 * Category page ke HTML me pagination links dhoondo
 * (numbered links, rel="next", ya "Next" text wale anchors)
 * Isse hume real pattern mil jata hai jo site khud use kar rahi hai.
 */
function detectPatternFromHtml(html, baseUrl) {
  const $ = cheerio.load(html);
  const candidates = [];

  $("a").each((_, el) => {
    const href = $(el).attr("href");
    const text = $(el).text().trim();
    const rel = $(el).attr("rel");
    if (!href) return;

    const isNumberLink = /^\d+$/.test(text);
    const isNextLink =
      rel === "next" || /next|older|→|›|»/i.test(text);

    if (isNumberLink || isNextLink) {
      try {
        const absolute = new URL(href, baseUrl).toString();
        candidates.push(absolute);
      } catch {
        /* ignore invalid hrefs */
      }
    }
  });

  // Pehla valid pagination-looking URL le lo aur uska pattern nikaalo
  for (const link of candidates) {
    if (/page\/2\/?/.test(link)) {
      return (base, n) => link.replace(/page\/2\/?/, `page/${n}/`);
    }
    if (/[?&]paged=2/.test(link)) {
      return (base, n) => link.replace(/paged=2/, `paged=${n}`);
    }
    if (/[?&]page=2/.test(link)) {
      return (base, n) => link.replace(/page=2/, `page=${n}`);
    }
    if (/\/p\/2\/?/.test(link)) {
      return (base, n) => link.replace(/\/p\/2\/?/, `/p/${n}/`);
    }
  }

  return null;
}

/**
 * startPage se endPage tak ke URLs banata hai.
 * Pehle actual page-1 HTML se pattern detect karta hai, agar nahi mila
 * to common fallback patterns try karta hai.
 */
function buildPageUrls(categoryUrl, startPage, endPage, page1Html) {
  const detectedPattern = page1Html
    ? detectPatternFromHtml(page1Html, categoryUrl)
    : null;

  const urls = [];
  for (let n = startPage; n <= endPage; n++) {
    if (n === 1) {
      urls.push(categoryUrl); // page 1 = original category URL
      continue;
    }

    if (detectedPattern) {
      urls.push(detectedPattern(categoryUrl, n));
    } else {
      // fallback: pehla common pattern try karo
      urls.push(COMMON_PATTERNS[0](categoryUrl, n));
    }
  }

  return urls;
}

module.exports = { buildPageUrls, detectPatternFromHtml, COMMON_PATTERNS };

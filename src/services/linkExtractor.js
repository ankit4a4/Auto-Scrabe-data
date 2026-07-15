const cheerio = require("cheerio");

// URL patterns jo generally post/article NAHI hote - inhe exclude karte hain
const EXCLUDE_PATTERNS = [
  /\/category\//i,
  /\/tag\//i,
  /\/page\/\d+/i,
  /[?&]paged=/i,
  /\/author\//i,
  /\/wp-admin/i,
  /\/wp-login/i,
  /\/feed\/?$/i,
  /\/login/i,
  /\/signup/i,
  /\/cart/i,
  /\/checkout/i,
  /\/search/i,
  /^#/,
  /^mailto:/i,
  /^tel:/i,
  /^javascript:/i,
];

// Static/utility pages jo bilkul post-jaisi single-segment slug rakhte hain
// (jaise example.com/magazine/, example.com/about-us/) - ye article nahi hote,
// isliye exact-slug match pe exclude karte hain. Ye sirf EXACT match hai
// (single path segment), isliye asli posts jaise "meet-the-founder-of-xyz-company"
// isse affect nahi honge - sirf generic nav pages jaise "/meet-the-founder/" exclude honge.
const STATIC_PAGE_SLUGS = [
  "about", "about-us", "aboutus", "contact", "contact-us", "contactus",
  "magazine", "advertise", "advertise-with-us", "subscribe", "subscription",
  "privacy-policy", "privacy", "terms", "terms-conditions", "terms-and-conditions",
  "careers", "jobs", "team", "our-team", "faq", "faqs", "shop", "store",
  "write-for-us", "submit-guest-post", "disclaimer", "sitemap", "home",
  "meet-the-founder", "meet-our-founder", "meet-the-team", "meet-our-team",
  "leadership", "founders", "management-team", "our-story", "our-mission",
  "our-vision", "editorial-team", "editorial-policy", "masthead",
  "contributors", "our-people", "who-we-are", "media-kit", "press",
  "press-release", "newsletter", "events", "gallery",
];

function isExcluded(url) {
  return EXCLUDE_PATTERNS.some((pattern) => pattern.test(url));
}

function isStaticPage(urlObj) {
  const segments = urlObj.pathname.split("/").filter(Boolean);
  // Sirf ek hi path segment ho aur wo known static-page slug ho
  if (segments.length === 1 && STATIC_PAGE_SLUGS.includes(segments[0].toLowerCase())) {
    return true;
  }
  return false;
}

// Category page ki listing me har post-card ke paas kabhi kabhi date dikhi
// hoti hai (jaise WordPress ka <time datetime="..."> tag, ya ".date"/".entry-date"
// jaisi class). Isse humein pagination early-stop karne me help milti hai -
// lekin FINAL date-range decision hamesha post ke apne page se milegi (accurate).
function findDateHintNear(el, $) {
  const timeWithAttr = $(el).find("time[datetime]").first().attr("datetime");
  if (timeWithAttr) return timeWithAttr;

  const timeText = $(el).find("time").first().text().trim();
  if (timeText) return timeText;

  const dateClassText = $(el)
    .find(".date, .entry-date, .post-date, .published, .publish-date, [class*='date']")
    .first()
    .text()
    .trim();
  if (dateClassText) return dateClassText;

  return null;
}

/**
 * PRIMARY STRATEGY: category/archive page pe posts aksar <article> tag ya
 * "post"/"entry" class wale container me wrapped hote hain. Wahi se link
 * nikalna sabse reliable hai (nav/footer/sidebar/static-page links khud hi
 * exclude ho jaate hain kyunki wo articles ke bahar hote hain).
 *
 * Ab { url, dateHint } dono return karta hai - dateHint raw string hai
 * (parse baad me pipeline karta hai), null agar category listing me date
 * nahi dikhi.
 */
function extractFromArticleContainers($, categoryUrl, baseHost) {
  const found = new Map(); // url -> dateHint (raw string ya null)
  const containerSelectors =
    "article, .post, .entry, .post-item, .post-card, .blog-post, " +
    "[class*='post-'], [class*='entry-'], [class*='article-']";

  $(containerSelectors).each((_, el) => {
    // Heading ke andar ka link priority - ye almost hamesha post ka
    // permalink hota hai (theme chahe koi bhi ho)
    let href =
      $(el).find("h1 a, h2 a, h3 a, h4 a").first().attr("href") ||
      $(el).find("a").first().attr("href");

    if (!href) return;

    try {
      const absolute = new URL(href, categoryUrl).toString();
      const urlObj = new URL(absolute);
      if (urlObj.hostname !== baseHost) return;

      const cleanUrl = urlObj.origin + urlObj.pathname;
      if (isExcluded(cleanUrl)) return;
      if (isStaticPage(urlObj)) return;
      if (cleanUrl.replace(/\/$/, "") === categoryUrl.replace(/\/$/, "")) return;

      if (!found.has(cleanUrl)) {
        found.set(cleanUrl, findDateHintNear(el, $));
      }
    } catch {
      /* invalid href, skip */
    }
  });

  return found;
}

/**
 * FALLBACK STRATEGY: agar site me <article>/.post jaisa structure nahi mila
 * (custom/unusual theme), to purana broad approach use karo - saare same-domain
 * links, minus excluded patterns aur static pages. Date hint yahan generally
 * nahi milti (broad links me container context clear nahi hota), isliye null.
 */
function extractFromAllLinks($, categoryUrl, baseHost) {
  const found = new Map();

  $("a[href]").each((_, el) => {
    const rawHref = $(el).attr("href");
    if (!rawHref) return;

    let absoluteUrl;
    try {
      absoluteUrl = new URL(rawHref, categoryUrl).toString();
    } catch {
      return;
    }

    const urlObj = new URL(absoluteUrl);
    if (urlObj.hostname !== baseHost) return;

    const cleanUrl = urlObj.origin + urlObj.pathname;
    if (isExcluded(cleanUrl)) return;
    if (isStaticPage(urlObj)) return;
    if (cleanUrl.replace(/\/$/, "") === categoryUrl.replace(/\/$/, "")) return;

    const pathSegments = urlObj.pathname.split("/").filter(Boolean);
    if (pathSegments.length === 0) return;

    if (!found.has(cleanUrl)) {
      found.set(cleanUrl, null);
    }
  });

  return found;
}

/**
 * Category page ke HTML se post links + (agar mile to) date hints nikalta hai.
 * Pehle article-container based (accurate) try karta hai, agar wahan se
 * kuch na mile (bahut kam/zero links) to broad fallback pe chala jaata hai.
 *
 * Return: [{ url, dateHint }] - dateHint null ho sakta hai agar listing me
 * date nahi dikhi (is case me final filtering post ke apne page se hogi).
 */
function extractPostLinksWithDates(html, categoryUrl) {
  const $ = cheerio.load(html);
  const baseHost = new URL(categoryUrl).hostname;

  const preciseLinks = extractFromArticleContainers($, categoryUrl, baseHost);

  const map = preciseLinks.size > 0 ? preciseLinks : extractFromAllLinks($, categoryUrl, baseHost);

  return Array.from(map.entries()).map(([url, dateHint]) => ({ url, dateHint }));
}

/**
 * Backward-compatible helper - sirf URLs chahiye ho (date hint ki zaroorat
 * nahi) to isse use karo.
 */
function extractPostLinks(html, categoryUrl) {
  return extractPostLinksWithDates(html, categoryUrl).map((item) => item.url);
}

module.exports = { extractPostLinks, extractPostLinksWithDates };

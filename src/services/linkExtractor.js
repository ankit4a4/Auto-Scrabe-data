const cheerio = require("cheerio");

// URL patterns that are generally NOT a post/article - these are excluded
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

// Static/utility pages that have a single-segment slug just like a post
// (e.g. example.com/magazine/, example.com/about-us/) - these are not articles,
// so they're excluded on exact-slug match. This is an EXACT match only
// (single path segment), so real posts like "meet-the-founder-of-xyz-company"
// are not affected - only generic nav pages like "/meet-the-founder/" get excluded.
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
  // Only a single path segment, and it's a known static-page slug
  if (segments.length === 1 && STATIC_PAGE_SLUGS.includes(segments[0].toLowerCase())) {
    return true;
  }
  return false;
}

// A date is sometimes shown near each post-card in a category page's listing
// (like WordPress's <time datetime="..."> tag, or a ".date"/".entry-date"
// style class). This helps us early-stop pagination -
// but the FINAL date-range decision always comes from the post's own page (accurate).
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
 * PRIMARY STRATEGY: on a category/archive page, posts are usually wrapped
 * in an <article> tag or a "post"/"entry" class container. Extracting links
 * from there is the most reliable (nav/footer/sidebar/static-page links get
 * excluded automatically since they're outside the articles).
 *
 * Now returns both { url, dateHint } - dateHint is a raw string
 * (parsed later by the pipeline), null if no date is shown in the
 * category listing.
 */
function extractFromArticleContainers($, categoryUrl, baseHost) {
  const found = new Map(); // url -> dateHint (raw string ya null)
  const containerSelectors =
    "article, .post, .entry, .post-item, .post-card, .blog-post, " +
    "[class*='post-'], [class*='entry-'], [class*='article-']";

  $(containerSelectors).each((_, el) => {
    // Prioritize the link inside the heading - this is almost always the
    // post's permalink (regardless of theme)
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
 * FALLBACK STRATEGY: if the site doesn't have an <article>/.post style
 * structure (custom/unusual theme), use the old broad approach - all
 * same-domain links, minus excluded patterns and static pages. A date hint
 * generally isn't available here (broad links don't have clear container
 * context), so it's null.
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
 * Extracts post links + (if found) date hints from a category page's HTML.
 * First tries the article-container based approach (accurate), and if
 * nothing is found there (very few/zero links) falls back to the broad approach.
 *
 * Returns: [{ url, dateHint }] - dateHint can be null if no date is shown in
 * the listing (in that case, the final filtering happens from the post's own page).
 */
function extractPostLinksWithDates(html, categoryUrl) {
  const $ = cheerio.load(html);
  const baseHost = new URL(categoryUrl).hostname;

  const preciseLinks = extractFromArticleContainers($, categoryUrl, baseHost);

  const map = preciseLinks.size > 0 ? preciseLinks : extractFromAllLinks($, categoryUrl, baseHost);

  return Array.from(map.entries()).map(([url, dateHint]) => ({ url, dateHint }));
}

/**
 * Backward-compatible helper - use this if you only need URLs (no date
 * hint needed).
 */
function extractPostLinks(html, categoryUrl) {
  return extractPostLinksWithDates(html, categoryUrl).map((item) => item.url);
}

module.exports = { extractPostLinks, extractPostLinksWithDates };

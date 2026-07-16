const { JSDOM } = require("jsdom");
const { Readability } = require("@mozilla/readability");
const cheerio = require("cheerio");

/**
 * Extracts clean article text + basic metadata from a post's HTML.
 * Readability strips out ads/sidebar/nav/footer to give just the main
 * content, so Gemini receives less and cleaner text (better for both cost
 * and accuracy).
 */
function extractArticle(html, url) {
  let title = null;
  let textContent = "";
  let excerpt = null;

  try {
    const dom = new JSDOM(html, { url });
    const reader = new Readability(dom.window.document);
    const article = reader.parse();
    if (article) {
      title = article.title;
      textContent = article.textContent.replace(/\s+/g, " ").trim();
      excerpt = article.excerpt;
    }
  } catch (err) {
    // Fallback below handles Readability failures
  }

  // Fallback if Readability couldn't extract anything
  if (!textContent || textContent.length < 100) {
    const $ = cheerio.load(html);
    $("script, style, nav, footer, header, noscript").remove();
    textContent = $("body").text().replace(/\s+/g, " ").trim();
    if (!title) title = $("title").text().trim() || null;
  }

  // Extra metadata (whatever's easily available)
  const $ = cheerio.load(html);
  const metaDescription =
    $('meta[name="description"]').attr("content") ||
    $('meta[property="og:description"]').attr("content") ||
    null;

  const featuredImage =
    $('meta[property="og:image"]').attr("content") ||
    $("article img").first().attr("src") ||
    null;

  // Publish date - date-range filtering now depends on this field, so we
  // try as many common sources as possible (ordered by reliability, most
  // trustworthy first). News/magazine sites (like Forbes) use different
  // CMS/plugins (Parse.ly, Sailthru, custom), so the list is kept long.
  let publishDate =
    $('meta[property="article:published_time"]').attr("content") ||
    $('meta[property="og:article:published_time"]').attr("content") ||
    $('meta[name="publish-date"]').attr("content") ||
    $('meta[name="publication_date"]').attr("content") ||
    $('meta[name="date"]').attr("content") ||
    $('meta[name="DC.date.issued"]').attr("content") ||
    $('meta[name="parsely-pub-date"]').attr("content") || // Parse.ly - very common on news/magazine sites
    $('meta[name="sailthru.date"]').attr("content") ||
    $('meta[itemprop="datePublished"]').attr("content") ||
    $('meta[itemprop="dateCreated"]').attr("content") ||
    $("time[datetime]").first().attr("datetime") ||
    null;

  // Fallback: JSON-LD structured data commonly has a date, but many sites
  // nest it inside a "@graph" array (checking only the top level isn't
  // enough) - so we recursively search the whole JSON tree.
  if (!publishDate) {
    function findDateInJsonLd(node) {
      if (!node || typeof node !== "object") return null;
      if (typeof node.datePublished === "string") return node.datePublished;
      if (typeof node.dateCreated === "string") return node.dateCreated;

      if (Array.isArray(node)) {
        for (const item of node) {
          const found = findDateInJsonLd(item);
          if (found) return found;
        }
      } else if (Array.isArray(node["@graph"])) {
        return findDateInJsonLd(node["@graph"]);
      }
      return null;
    }

    $('script[type="application/ld+json"]').each((_, el) => {
      if (publishDate) return;
      try {
        const json = JSON.parse($(el).contents().text());
        publishDate = findDateInJsonLd(json);
      } catch {
        /* invalid JSON-LD, ignore */
      }
    });
  }

  // Last fallback: visible text of a <time> tag (when there's no datetime
  // attribute), or common class-based date elements (many custom-CMS
  // sites, like Forbes-style magazine sites, only show the date as visible
  // text, with no structured meta/JSON-LD)
  if (!publishDate) {
    const timeText = $("time").first().text().trim();
    if (timeText) {
      publishDate = timeText;
    } else {
      const dateClassText = $(
        ".date, .post-date, .entry-date, .published, .publish-date, " +
          ".article-date, .story-date, [class*='date-time'], [class*='publish']"
      )
        .first()
        .text()
        .trim();
      if (dateClassText) publishDate = dateClassText;
    }
  }

  // A very common pattern on Indian news/magazine sites (like Forbes India):
  // plain text saying "First Published: Jun 26, 2026, 15:51" or
  // "Last Updated: Jun 26, 2026, 17:19 IST", with no structured tag/class
  // at all. "First Published" is prioritized (the actual publish date),
  // "Last Updated" is used as a fallback.
  if (!publishDate) {
    const bodyText = $("body").text();
    const datePattern =
      /[A-Za-z]{3,9}\.?\s+\d{1,2},?\s*\d{4}(?:,?\s*\d{1,2}:\d{2}(?:\s*(?:AM|PM))?)?/;

    const publishedMatch = bodyText.match(
      new RegExp(`First Published\\s*:?\\s*(${datePattern.source})\\s*(IST)?`, "i")
    );
    const updatedMatch = bodyText.match(
      new RegExp(`(?:Last Updated|Updated)\\s*:?\\s*(${datePattern.source})\\s*(IST)?`, "i")
    );

    const match = publishedMatch || updatedMatch;
    if (match) {
      const rawDate = match[1].trim();
      // If "IST" is explicitly written in the text, use that offset
      // (not a guess - the source itself said it's Indian Standard Time)
      publishDate = match[2] ? `${rawDate} GMT+0530` : rawDate;
    }
  }

  const author =
    $('meta[name="author"]').attr("content") ||
    $(".author, .byline, [rel='author']").first().text().trim() ||
    null;

  return {
    url,
    title,
    textContent: textContent.slice(0, 12000), // don't send too much text to Gemini
    excerpt,
    metaDescription,
    featuredImage,
    publishDate,
    author,
  };
}

module.exports = { extractArticle };

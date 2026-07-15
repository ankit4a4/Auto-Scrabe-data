const { JSDOM } = require("jsdom");
const { Readability } = require("@mozilla/readability");
const cheerio = require("cheerio");

/**
 * Post ke HTML se clean article text + basic metadata nikalta hai.
 * Readability ads/sidebar/nav/footer hata ke sirf main content deta hai,
 * isse Gemini ko kam aur saaf text jaata hai (cost + accuracy dono behtar).
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
    // Readability fail ho jaye to fallback niche hai
  }

  // Fallback agar Readability kuch extract na kar paya
  if (!textContent || textContent.length < 100) {
    const $ = cheerio.load(html);
    $("script, style, nav, footer, header, noscript").remove();
    textContent = $("body").text().replace(/\s+/g, " ").trim();
    if (!title) title = $("title").text().trim() || null;
  }

  // Extra metadata (jitna easily mil jaye)
  const $ = cheerio.load(html);
  const metaDescription =
    $('meta[name="description"]').attr("content") ||
    $('meta[property="og:description"]').attr("content") ||
    null;

  const featuredImage =
    $('meta[property="og:image"]').attr("content") ||
    $("article img").first().attr("src") ||
    null;

  // Publish date - date-range filtering ab isi field pe depend karti hai,
  // isliye jitne zyada common sources ho sakein utne try karte hain
  // (order = reliability ke hisaab se, sabse trustworthy pehle). News/magazine
  // sites (Forbes jaisi) alag-alag CMS/plugins (Parse.ly, Sailthru, custom)
  // use karte hain, isliye list lambi rakhi hai.
  let publishDate =
    $('meta[property="article:published_time"]').attr("content") ||
    $('meta[property="og:article:published_time"]').attr("content") ||
    $('meta[name="publish-date"]').attr("content") ||
    $('meta[name="publication_date"]').attr("content") ||
    $('meta[name="date"]').attr("content") ||
    $('meta[name="DC.date.issued"]').attr("content") ||
    $('meta[name="parsely-pub-date"]').attr("content") || // Parse.ly - bahut common hai news/magazine sites me
    $('meta[name="sailthru.date"]').attr("content") ||
    $('meta[itemprop="datePublished"]').attr("content") ||
    $('meta[itemprop="dateCreated"]').attr("content") ||
    $("time[datetime]").first().attr("datetime") ||
    null;

  // Fallback: JSON-LD structured data me date hona common hai, lekin kai
  // sites isko nested "@graph" array ke andar rakhte hain (sirf top-level
  // check karna kaafi nahi hai) - isliye recursively poore JSON tree me
  // dhoondte hain.
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

  // Aakhri fallback: <time> tag ka visible text (datetime attribute na ho to),
  // ya common class-based date elements (kai custom-CMS sites, jaise Forbes
  // jaisi magazine sites, date ko sirf visible text me dikhate hain, koi
  // structured meta/JSON-LD nahi dete)
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

  // Bahut common pattern Indian news/magazine sites me (Forbes India jaisi):
  // plain text me "First Published: Jun 26, 2026, 15:51" ya
  // "Last Updated: Jun 26, 2026, 17:19 IST" likha hota hai, kisi bhi
  // structured tag/class ke bina. "First Published" ko priority dete hain
  // (asli publish-date), "Last Updated" ko fallback ke roop me.
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
      // "IST" explicitly text me likha hai to wahi offset use karo (guess
      // nahi kar rahe - source ne khud bataya hai ye Indian Standard Time hai)
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
    textContent: textContent.slice(0, 12000), // Gemini ko bahut zyada text na bheje
    excerpt,
    metaDescription,
    featuredImage,
    publishDate,
    author,
  };
}

module.exports = { extractArticle };

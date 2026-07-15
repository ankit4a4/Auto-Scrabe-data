const cheerio = require("cheerio");
const { fetchStatic, fetchDynamic } = require("./fetchers");

// Domain-wise cache so detection doesn't need to run repeatedly
// (in production this could be persisted to MongoDB/a file)
const domainModeCache = new Map();

function getDomain(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

// Checks whether static HTML has "real" content or not, using a rough heuristic
function looksLikeRealContent(html) {
  const $ = cheerio.load(html);
  $("script, style, noscript").remove();
  const bodyText = $("body").text().replace(/\s+/g, " ").trim();

  // Very little text = likely a JS-rendered site (React/Vue/Angular/Next.js CSR)
  if (bodyText.length < 200) return false;

  // Common SPA "empty shell" markers
  const html_lower = html.toLowerCase();
  const spaMarkers = [
    'id="root"',
    'id="app"',
    "you need to enable javascript",
    "__next",
  ];
  const hasEmptyShellMarker = spaMarkers.some((m) => html_lower.includes(m));
  if (hasEmptyShellMarker && bodyText.length < 500) return false;

  return true;
}

/**
 * Given a URL, decide whether it's "static" (Cheerio will do the job)
 * or "dynamic" (Playwright is needed), and return that same HTML
 * (to avoid double fetching).
 */
async function fetchWithAutoDetect(url) {
  const domain = getDomain(url);
  const cachedMode = domainModeCache.get(domain);

  if (cachedMode === "dynamic") {
    const html = await fetchDynamic(url);
    return { html, mode: "dynamic" };
  }

  // Try static first (fast + light)
  let staticHtml = null;
  try {
    staticHtml = await fetchStatic(url);
  } catch (err) {
    staticHtml = null;
  }

  if (staticHtml && looksLikeRealContent(staticHtml)) {
    domainModeCache.set(domain, "static");
    return { html: staticHtml, mode: "static" };
  }

  // Static didn't work -> Playwright fallback
  const dynamicHtml = await fetchDynamic(url);
  domainModeCache.set(domain, "dynamic");
  return { html: dynamicHtml, mode: "dynamic" };
}

module.exports = { fetchWithAutoDetect, getDomain };

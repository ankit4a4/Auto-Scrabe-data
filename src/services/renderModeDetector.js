const cheerio = require("cheerio");
const { fetchStatic, fetchDynamic } = require("./fetchers");

// Domain-wise cache taaki baar baar detection na karni pade
// (production me isko MongoDB/file me persist kar sakte ho)
const domainModeCache = new Map();

function getDomain(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

// Static HTML me "real" content mil raha hai ya nahi, ye rough heuristic se check karte hain
function looksLikeRealContent(html) {
  const $ = cheerio.load(html);
  $("script, style, noscript").remove();
  const bodyText = $("body").text().replace(/\s+/g, " ").trim();

  // Bahut kam text = likely JS-rendered site (React/Vue/Angular/Next.js CSR)
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
 * Given a URL, decide karo "static" (Cheerio se kaam chalega)
 * ya "dynamic" (Playwright chahiye), aur wahi HTML return kar do
 * (double fetching se bachne ke liye).
 */
async function fetchWithAutoDetect(url) {
  const domain = getDomain(url);
  const cachedMode = domainModeCache.get(domain);

  if (cachedMode === "dynamic") {
    const html = await fetchDynamic(url);
    return { html, mode: "dynamic" };
  }

  // Pehle static try karo (fast + light)
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

  // Static se kaam nahi bana -> Playwright fallback
  const dynamicHtml = await fetchDynamic(url);
  domainModeCache.set(domain, "dynamic");
  return { html: dynamicHtml, mode: "dynamic" };
}

module.exports = { fetchWithAutoDetect, getDomain };

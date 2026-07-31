// Reuse a single Playwright browser instance
// (launching a new browser on every request would be very slow + heavy)

const { chromium } = require("playwright");

let browserPromise = null;

// Resource types that are pure "visual weight" - we never read pixels, only
// the DOM/text/links, so these are safe to block. This alone typically cuts
// per-page memory + bandwidth drastically (image-heavy news sites especially).
// CSS and JS are deliberately NOT blocked - button visibility checks
// (isVisible in loadMoreExpander.js, cookie-banner dismissal) depend on CSS
// being applied, and JS-rendered content depends on scripts running.
const BLOCKED_RESOURCE_TYPES = new Set(["image", "media", "font"]);

async function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
  }
  return browserPromise;
}

async function getNewPage() {
  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  });

  await context.route("**/*", (route) => {
    const resourceType = route.request().resourceType();
    if (BLOCKED_RESOURCE_TYPES.has(resourceType)) {
      return route.abort();
    }
    return route.continue();
  });

  const page = await context.newPage();
  return { page, context };
}

async function closeBrowser() {
  if (browserPromise) {
    const browser = await browserPromise;
    await browser.close();
    browserPromise = null;
  }
}

module.exports = { getBrowser, getNewPage, closeBrowser };

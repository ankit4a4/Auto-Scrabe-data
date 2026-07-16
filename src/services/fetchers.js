const axios = require("axios");
const { getNewPage } = require("./browserManager");
const config = require("../config");

const AXIOS_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
};

// Simple static fetch using axios (fast, no JS execution)
async function fetchStatic(url) {
  const res = await axios.get(url, {
    headers: AXIOS_HEADERS,
    timeout: config.pageTimeout,
    validateStatus: (status) => status < 500,
  });
  return res.data;
}

// Dynamic fetch using Playwright (executes JS, waits for content)
async function fetchDynamic(url) {
  const { page, context } = await getNewPage();
  try {
    // "domcontentloaded" is fast and reliable. "networkidle" was used here
    // before, but modern sites (with ads/analytics/chat-widgets/websockets
    // running continuously in the background) NEVER go network-"idle", so
    // it would time out completely (as happened on yourstory.com) - even
    // though the page had actually finished loading.
    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: config.pageTimeout,
    });

    // Best-effort: wait a bit more for lazy-loaded/JS-rendered content
    // (React/Vue components) to settle. If the site truly never goes
    // idle, proceed anyway - domcontentloaded has already been achieved,
    // and that's good enough.
    try {
      await page.waitForLoadState("networkidle", { timeout: 5000 });
    } catch {
      // Ignore - there's persistent background network activity, that's fine
    }

    await page.waitForTimeout(1000);
    const html = await page.content();
    return html;
  } finally {
    await context.close();
  }
}

module.exports = { fetchStatic, fetchDynamic };

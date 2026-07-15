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
    // "domcontentloaded" is fast and reliable. "networkidle" used to be
    // used here before, but on modern sites (ads/analytics/chat-widgets/
    // websockets that run continuously in the background) the network is
    // NEVER "idle", so it would completely time out (like it did on
    // yourstory.com) - even if the page had actually finished loading.
    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: config.pageTimeout,
    });

    // Best-effort: wait a bit more so lazy-loaded/JS-rendered content
    // (React/Vue components) settles. If the site truly never goes idle,
    // proceed anyway - domcontentloaded has already been achieved,
    // that's enough.
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

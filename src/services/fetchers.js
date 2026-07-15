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
    // "domcontentloaded" fast aur reliable hai. "networkidle" ka use pehle
    // yahan hota tha, lekin modern sites (ads/analytics/chat-widgets/websockets
    // jo background me continuously chalte rehte hain) pe network KABHI
    // "idle" nahi hota, isliye wo poori tarah timeout ho jaata tha (jaisa
    // yourstory.com pe hua) - chahe page actually load ho chuka ho.
    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: config.pageTimeout,
    });

    // Best-effort: thoda aur wait karo taaki lazy-loaded/JS-rendered content
    // (React/Vue components) settle ho jaaye. Agar site truly kabhi idle
    // nahi hoti to bhi aage badh jaao - domcontentloaded already achieve
    // ho chuka hai, wahi kaafi hai.
    try {
      await page.waitForLoadState("networkidle", { timeout: 5000 });
    } catch {
      // Ignore - persistent background network activity hai, koi baat nahi
    }

    await page.waitForTimeout(1000);
    const html = await page.content();
    return html;
  } finally {
    await context.close();
  }
}

module.exports = { fetchStatic, fetchDynamic };

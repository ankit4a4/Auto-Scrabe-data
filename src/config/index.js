require("dotenv").config();

module.exports = {
  port: process.env.PORT || 4000,

  // --- Gemini (free tier: 15 req/min, 1500 req/day for gemini-3.5-flash) ---
  geminiApiKey: process.env.GEMINI_API_KEY || "",
  geminiModel: process.env.GEMINI_MODEL || "gemini-3.5-flash",
  geminiMinIntervalMs: parseInt(process.env.GEMINI_MIN_INTERVAL_MS || "4200", 10),

  // --- Groq (free tier: ~30 req/min, OpenAI-compatible, bahut fast) ---
  groqApiKey: process.env.GROQ_API_KEY || "",
  groqModel: process.env.GROQ_MODEL || "llama-3.3-70b-versatile",
  groqMinIntervalMs: parseInt(process.env.GROQ_MIN_INTERVAL_MS || "2100", 10),

  // --- OpenRouter (free router: ~20 req/min, OpenAI-compatible) ---
  openrouterApiKey: process.env.OPENROUTER_API_KEY || "",
  openrouterModel: process.env.OPENROUTER_MODEL || "openrouter/free",
  openrouterMinIntervalMs: parseInt(process.env.OPENROUTER_MIN_INTERVAL_MS || "3100", 10),

  concurrency: parseInt(process.env.CONCURRENCY || "3", 10),
  pageTimeout: parseInt(process.env.PAGE_TIMEOUT || "25000", 10),

  // --- Post-count based scraping (page-range ki jagah) ---
  defaultPostLimit: parseInt(process.env.DEFAULT_POST_LIMIT || "15", 10),
  maxPostLimit: parseInt(process.env.MAX_POST_LIMIT || "20", 10),
  maxPagesToCrawl: parseInt(process.env.MAX_PAGES_TO_CRAWL || "15", 10),

  // JS-driven pagination (Load More button YA numbered Next-arrow, dono) ke
  // liye max click/step attempts (safety cap - bahut zyada pages wali sites,
  // jaise 100-page categories, pe hum bina limit ke click nahi karte rehte)
  maxLoadMoreClicks: parseInt(process.env.MAX_PAGINATION_STEPS || process.env.MAX_LOAD_MORE_CLICKS || "8", 10),

  // --- Date-range based scraping ---
  // Safety cap: agar date range me bahut zyada posts mil jaayein (bada range
  // ya bahut active site), sirf itne hi process honge - baaki truncate hoke
  // log me warning aayegi. Isse accidentally 500+ posts process hone se bachte hain.
  maxDateRangePosts: parseInt(process.env.MAX_DATE_RANGE_POSTS || "30", 10),
};

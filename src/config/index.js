require("dotenv").config();

module.exports = {
  port: process.env.PORT || 4000,

  // --- Gemini (free tier: 15 req/min, 1500 req/day for gemini-3.5-flash) ---
  geminiApiKey: process.env.GEMINI_API_KEY || "",
  geminiModel: process.env.GEMINI_MODEL || "gemini-3.5-flash",
  geminiMinIntervalMs: parseInt(process.env.GEMINI_MIN_INTERVAL_MS || "4200", 10),

  // --- Groq (free tier: ~30 req/min, OpenAI-compatible, very fast) ---
  groqApiKey: process.env.GROQ_API_KEY || "",
  groqModel: process.env.GROQ_MODEL || "llama-3.3-70b-versatile",
  groqMinIntervalMs: parseInt(process.env.GROQ_MIN_INTERVAL_MS || "2100", 10),

  // --- OpenRouter (free router: ~20 req/min, OpenAI-compatible) ---
  openrouterApiKey: process.env.OPENROUTER_API_KEY || "",
  openrouterModel: process.env.OPENROUTER_MODEL || "openrouter/free",
  openrouterMinIntervalMs: parseInt(process.env.OPENROUTER_MIN_INTERVAL_MS || "3100", 10),

  concurrency: parseInt(process.env.CONCURRENCY || "3", 10),
  pageTimeout: parseInt(process.env.PAGE_TIMEOUT || "25000", 10),

  // --- Post-count based scraping (instead of a page-range) ---
  defaultPostLimit: parseInt(process.env.DEFAULT_POST_LIMIT || "15", 10),
  maxPostLimit: parseInt(process.env.MAX_POST_LIMIT || "20", 10),
  maxPagesToCrawl: parseInt(process.env.MAX_PAGES_TO_CRAWL || "15", 10),

  // Max click/step attempts for JS-driven pagination (Load More button OR
  // numbered Next-arrow, both) (safety cap - for sites with a huge number
  // of pages, like 100-page categories, we don't keep clicking without a limit)
  maxLoadMoreClicks: parseInt(process.env.MAX_PAGINATION_STEPS || process.env.MAX_LOAD_MORE_CLICKS || "8", 10),

  // --- Date-range based scraping ---
  // Safety cap: if too many posts are found in the date range (a large range
  // or a very active site), only this many will be processed - the rest get
  // truncated with a warning in the log. This prevents accidentally
  // processing 500+ posts.
  maxDateRangePosts: parseInt(process.env.MAX_DATE_RANGE_POSTS || "30", 10),
};

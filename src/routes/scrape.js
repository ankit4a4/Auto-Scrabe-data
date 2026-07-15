const express = require("express");
const path = require("path");
const { runScrapePipeline } = require("../services/pipeline");
const { saveEntries, loadAll, exportToExcel } = require("../storage/store");
const { startOfDay, endOfDay, parseDateSafe } = require("../utils/dateUtils");
const { fetchWithAutoDetect } = require("../services/renderModeDetector");
const { extractArticle } = require("../services/contentExtractor");
const { clickThroughPagination } = require("../services/loadMoreExpander");

const router = express.Router();

/**
 * GET /api/debug-pagination?url=https://example.com/category&startDate=2026-06-01&steps=5
 *
 * Diagnostic tool - category page pe click-based pagination (Load More /
 * Next arrow) ko step-by-step test karta hai, detailed logs ke saath
 * (kaunsa selector match hua, click ke baad content change hua ya nahi,
 * URL before/after). Poori AI pipeline nahi chalata - bahut fast hai,
 * isse pagination-related issues ko bina AI-cost ke debug kar sakte ho.
 */
router.get("/debug-pagination", async (req, res) => {
  const { url, startDate, steps } = req.query;
  if (!url) {
    return res.status(400).json({ error: "?url= query param required hai (category page ka URL)" });
  }

  const start = startDate ? startOfDay(startDate) : startOfDay("2000-01-01"); // date-filter na chahiye ho to bahut purani date de do
  const maxSteps = steps ? parseInt(steps, 10) : 5;

  try {
    const logs = [];
    const result = await clickThroughPagination({
      categoryUrl: url,
      startDate: start,
      maxSteps,
      onProgress: (msg) => logs.push(msg),
    });

    res.json({
      totalCandidates: result.candidates.length,
      stepsDone: result.stepsDone,
      logs,
      candidateUrls: result.candidates.map((c) => ({
        url: c.url,
        dateHint: c.dateHint ? c.dateHint.toISOString() : null,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/debug-post?url=https://example.com/some-post
 *
 * Diagnostic tool - ek single post URL ke liye dikhata hai:
 *  - fetch mode (static ya dynamic/Playwright use hui)
 *  - extracted title, publishDate (jo bhi mila, ya null)
 *  - textContent ka preview (pehle 500 chars) - taaki dikhe content sahi
 *    extract ho raha hai ya nahi
 * Poori AI pipeline nahi chalata - sirf fetch + extract, taaki jaldi aur
 * bina AI-cost ke test kar sako ki kisi specific site pe date/content kyun
 * miss ho raha hai.
 */
router.get("/debug-post", async (req, res) => {
  const { url } = req.query;
  if (!url) {
    return res.status(400).json({ error: "?url= query param required hai" });
  }

  try {
    const { html, mode } = await fetchWithAutoDetect(url);
    const article = extractArticle(html, url);
    const parsedDate = parseDateSafe(article.publishDate);

    res.json({
      url,
      fetchMode: mode,
      title: article.title,
      publishDate_raw: article.publishDate,
      publishDate_parsed: parsedDate ? parsedDate.toISOString() : null,
      publishDate_parse_failed: !!article.publishDate && !parsedDate,
      textContentLength: article.textContent.length,
      textContentPreview: article.textContent.slice(0, 500),
      htmlLength: html.length,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/scrape
 * Body: { categoryUrl, startDate, endDate }
 *
 * startDate/endDate = "YYYY-MM-DD" format strings (jaisa HTML <input type="date">
 * deta hai). Range INCLUSIVE hai - startDate ke din se lekar endDate ke poore
 * din tak ke posts is range me aayenge.
 */
router.post("/scrape", async (req, res) => {
  const { categoryUrl, startDate, endDate } = req.body;

  if (!categoryUrl) {
    return res.status(400).json({ error: "categoryUrl required hai" });
  }

  if (!startDate || !endDate) {
    return res.status(400).json({ error: "startDate aur endDate dono required hain (YYYY-MM-DD format)" });
  }

  const start = startOfDay(startDate);
  const end = endOfDay(endDate);

  if (!start || !end) {
    return res.status(400).json({ error: "startDate ya endDate valid date nahi hai" });
  }

  if (start > end) {
    return res.status(400).json({ error: "startDate, endDate se baad ki nahi ho sakti" });
  }

  try {
    const logs = [];
    const result = await runScrapePipeline({
      categoryUrl,
      startDate: start,
      endDate: end,
      onProgress: (msg) => logs.push(msg),
    });

    const savedAll = saveEntries(result.entries);

    res.json({
      success: true,
      totalPostsFound: result.totalPostsFound,
      totalSaved: result.totalSaved,
      entries: result.entries,
      totalInDatabase: savedAll.length,
      logs,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/results -> ab tak save hue saare entries dekho
router.get("/results", (req, res) => {
  const all = loadAll();
  res.json({ total: all.length, entries: all });
});

// GET /api/export/excel -> saare results ko Excel file me export karo
router.get("/export/excel", async (req, res) => {
  try {
    const all = loadAll();
    const outputPath = path.join(__dirname, "..", "..", "data", "export.xlsx");
    await exportToExcel(all, outputPath);
    res.download(outputPath, "extracted-data.xlsx");
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

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
 * Diagnostic tool - tests click-based pagination (Load More / Next arrow)
 * on a category page step-by-step, with detailed logs (which selector
 * matched, whether the content changed after the click, URL before/after).
 * Does not run the full AI pipeline - very fast, so you can debug
 * pagination-related issues without any AI cost.
 */
router.get("/debug-pagination", async (req, res) => {
  const { url, startDate, steps } = req.query;
  if (!url) {
    return res.status(400).json({ error: "?url= query param is required (the category page URL)" });
  }

  const start = startDate ? startOfDay(startDate) : startOfDay("2000-01-01"); // if no date-filter is needed, give a very old date
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
 * Diagnostic tool - for a single post URL, shows:
 *  - fetch mode (static or dynamic/Playwright was used)
 *  - extracted title, publishDate (whatever was found, or null)
 *  - a preview of textContent (first 500 chars) - so you can see whether
 *    content is being extracted correctly
 * Does not run the full AI pipeline - only fetch + extract, so you can
 * quickly test without AI cost why date/content is missing on a specific site.
 */
router.get("/debug-post", async (req, res) => {
  const { url } = req.query;
  if (!url) {
    return res.status(400).json({ error: "?url= query param is required" });
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
 * startDate/endDate = "YYYY-MM-DD" format strings (as given by an HTML
 * <input type="date">). Range is INCLUSIVE - posts from the startDate's
 * day through the entire endDate's day fall in this range.
 */
router.post("/scrape", async (req, res) => {
  const { categoryUrl, startDate, endDate } = req.body;

  if (!categoryUrl) {
    return res.status(400).json({ error: "categoryUrl is required" });
  }

  if (!startDate || !endDate) {
    return res.status(400).json({ error: "Both startDate and endDate are required (YYYY-MM-DD format)" });
  }

  const start = startOfDay(startDate);
  const end = endOfDay(endDate);

  if (!start || !end) {
    return res.status(400).json({ error: "startDate or endDate is not a valid date" });
  }

  if (start > end) {
    return res.status(400).json({ error: "startDate cannot be after endDate" });
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

// GET /api/results -> see all entries saved so far
router.get("/results", (req, res) => {
  const all = loadAll();
  res.json({ total: all.length, entries: all });
});

// GET /api/export/excel -> export all results to an Excel file
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

const express = require("express");
const crypto = require("crypto");
const path = require("path");
const { runScrapePipeline } = require("../services/pipeline");
const { saveEntries, loadAll, clearAll, exportToExcel } = require("../storage/store");
const { startOfDay, endOfDay, parseDateSafe } = require("../utils/dateUtils");
const { fetchWithAutoDetect } = require("../services/renderModeDetector");
const { extractArticle } = require("../services/contentExtractor");
const { clickThroughPagination } = require("../services/loadMoreExpander");

const router = express.Router();

// In-memory job store for /api/scrape's background progress tracking.
// A scrape can take a while (many posts * AI calls * enrichment lookups),
// so instead of the client waiting on one long blocking request, /api/scrape
// now just kicks the job off and returns a jobId immediately - the client
// polls /api/scrape-progress/:jobId to get the live percent + logs, and the
// final result once status becomes "done" (or the error, if it failed).
//
// Single-admin internal tool, so a simple in-memory Map is enough - jobs
// reset on server restart, same trade-off as sessions in sessionAuth.js.
const jobs = new Map();
const JOB_TTL_MS = 30 * 60 * 1000; // stale jobs are cleaned up after 30 min

function cleanupOldJobs() {
  const now = Date.now();
  for (const [id, job] of jobs.entries()) {
    if (now - job.createdAt > JOB_TTL_MS) jobs.delete(id);
  }
}

/**
 * GET /api/debug-pagination?url=https://example.com/category&startDate=2026-06-01&steps=5
 *
 * Diagnostic tool - tests click-based pagination (Load More / Next arrow)
 * on a category page step-by-step, with detailed logs (which selector
 * matched, whether content changed after the click, URL before/after).
 * Does not run the full AI pipeline - it's fast, so you can debug
 * pagination-related issues without incurring any AI cost.
 */
router.get("/debug-pagination", async (req, res) => {
  const { url, startDate, steps } = req.query;
  if (!url) {
    return res.status(400).json({ error: "?url= query param is required (the category page URL)" });
  }

  const start = startDate ? startOfDay(startDate) : startOfDay("2000-01-01"); // use a very old date if no date-filter is needed
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
    res.status(500).json({ error: "This website is fully secured and could not be scanned." });
  }
});

/**
 * GET /api/debug-post?url=https://example.com/some-post
 *
 * Diagnostic tool - shows, for a single post URL:
 *  - fetch mode (static or dynamic/Playwright was used)
 *  - extracted title, publishDate (whatever was found, or null)
 *  - a preview of textContent (first 500 chars) - to check whether content
 *    is being extracted correctly
 * Does not run the full AI pipeline - just fetch + extract, so you can
 * quickly test why date/content might be missing on a specific site,
 * without any AI cost.
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
    res.status(500).json({ error: "This website is fully secured and could not be scanned." });
  }
});

/**
 * POST /api/scrape
 * Body: { categoryUrl, startDate, endDate }
 *
 * startDate/endDate are "YYYY-MM-DD" format strings (as given by an HTML
 * <input type="date">). The range is INCLUSIVE - posts from the start of
 * startDate through the end of endDate fall within range.
 *
 * Starts the scrape as a background job and returns immediately with a
 * jobId. Poll GET /api/scrape-progress/:jobId for live percent/logs, and
 * the final result once status is "done" or "error".
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

  cleanupOldJobs();

  const jobId = crypto.randomBytes(12).toString("hex");
  const job = {
    id: jobId,
    status: "running", // running | done | error
    percent: 0,
    stats: { totalFound: 0, totalToCheck: 0, checked: 0, withData: 0, withoutData: 0 },
    logs: [],
    result: null,
    error: null,
    createdAt: Date.now(),
  };
  jobs.set(jobId, job);

  // Run the pipeline in the background - the response below returns right
  // away, the client picks up progress via /api/scrape-progress/:jobId.
  (async () => {
    try {
      const result = await runScrapePipeline({
        categoryUrl,
        startDate: start,
        endDate: end,
        onProgress: (msg) => job.logs.push(msg),
        onPercent: (p) => (job.percent = p),
        onStats: (stats) => (job.stats = stats),
      });

      const savedAll = saveEntries(result.entries);

      job.status = "done";
      job.percent = 100;
      job.result = {
        success: true,
        totalPostsFound: result.totalPostsFound,
        totalSaved: result.totalSaved,
        postsWithData: result.postsWithData,
        postsWithoutData: result.postsWithoutData,
        entries: result.entries,
        totalInDatabase: savedAll.length,
        logs: job.logs,
      };
    } catch (err) {
      console.error(err); // full detail kept in server logs for debugging
      job.status = "error";
      job.error = "This website is fully secured and could not be scanned.";
    }
  })();

  res.json({ jobId });
});

/**
 * GET /api/scrape-progress/:jobId
 * Poll this while a scrape is running to get the live percent + logs.
 * Once status is "done", `result` has the same shape /api/scrape used to
 * return directly. Once status is "error", `error` has the message.
 */
router.get("/scrape-progress/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: "Unknown or expired job id." });
  }

  res.json({
    status: job.status,
    percent: job.percent,
    stats: job.stats,
    logs: job.logs,
    result: job.status === "done" ? job.result : null,
    error: job.status === "error" ? job.error : null,
  });
});

// GET /api/results -> view all entries saved so far
router.get("/results", (req, res) => {
  const all = loadAll();
  res.json({ total: all.length, entries: all });
});

// POST /api/clear-results -> empty out the saved JSON data (called on page
// load / reload, and when the "Refresh Saved Results" button is clicked -
// data is only meant to persist for the current page session, not across
// reloads or button clicks)
router.post("/clear-results", (req, res) => {
  clearAll();
  res.json({ success: true });
});

// GET /api/export/excel -> export all results to an Excel file, then clear the saved JSON data
router.get("/export/excel", async (req, res) => {
  try {
    const all = loadAll();
    const outputPath = path.join(__dirname, "..", "..", "data", "export.xlsx");
    await exportToExcel(all, outputPath);
    clearAll(); // data is now downloaded - clear it so the next scrape starts fresh
    res.download(outputPath, "extracted-data.xlsx");
  } catch (err) {
    res.status(500).json({ error: "This website is fully secured and could not be scanned." });
  }
});

module.exports = router;

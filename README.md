# Auto Scraper — Universal Category Scraper + Multi-Provider AI Extractor

Give it a category page URL + a date range, and it scrapes every post in
that range, extracting **Owner Name(s) / Business Name / City** using
Gemini, Groq, and/or OpenRouter (whichever API keys you configure), then
automatically finds **Website / Phone / Email** for each company.

## Save Condition
- An entry is saved when **either** Owner Name(s) **or** Business Name is
  found for that company (just one is enough - whichever field is missing
  stays blank).
- A single article can profile **multiple separate companies** (e.g. a
  roundup piece) - each becomes its own entry; owners are never mixed
  across companies.
- City is a bonus field - included only if mentioned in the text.
- Website, Phone, and Email are enriched automatically (see "Phone/Email
  Enrichment" below) whenever they aren't already found in the article
  itself - first by visiting the company's own website, then via a free
  search-based fallback.
- Non-business content (movie reviews, entertainment, sports, general news)
  is automatically filtered out by the AI.

## Phone/Email Enrichment
For every saved entry, if Phone and/or Email wasn't found directly in the
article text, the system does a free best-effort lookup, in two steps:

**Step 1 - visit the company's own website (most reliable).**
If a company's official website is known (either because the article text
itself mentioned one, or a best-effort search finds a likely domain), the
system automatically visits it using the existing Playwright setup and
scrapes the homepage plus Contact / About / Team / Support / Privacy pages
(discovered from the site's own nav/footer links, falling back to common
guessed paths like `/contact-us` when a page type isn't linked anywhere):
1. `mailto:` and `tel:` links are checked first (highest confidence).
2. Visible page/footer text is regex-scanned for any email/phone.
3. All matches are de-duplicated.
4. The visit stops early once both an email and phone are found, and is
   capped at `MAX_WEBSITE_CONTACT_PAGES` pages (default 6) per company.
5. The discovered `Website` is saved alongside the entry.

**Step 2 - search-engine fallback.** If a website couldn't be identified,
or the site visit still left a field blank, the system falls back to
searching DuckDuckGo's lite HTML endpoint for `"<Business Name> <City>
phone email contact"`, regex-scanning the result snippets, and (if still
needed) fetching the top 1-2 result pages.

Whatever is found is filled in; whatever isn't found anywhere stays blank
- nothing is ever guessed. This uses no paid API and no AI credits (pure
scraping + regex), so it's free but not guaranteed - sites/search engines
may occasionally rate-limit, block, or change their page structure, and
for common business names the search-based fallback can occasionally pick
up a different business's contact info. Requests are spaced out to stay
polite and reduce the chance of being blocked. Set `DEBUG_ENRICH=0` to
silence the step-by-step console trace.

## Setup

```bash
npm install
npx playwright install chromium   # one-time Playwright browser install
cp .env.example .env
# open .env and fill in: ADMIN_USERNAME, ADMIN_PASSWORD, and at least one AI provider's API key
npm start
```

Server runs at `http://localhost:4000` (or whichever `PORT` you set).

## Login

The whole app (admin panel + API) is protected by a login prompt (HTTP
Basic Auth - your browser will show its own native username/password
popup, no custom login page needed). Set `ADMIN_USERNAME` and
`ADMIN_PASSWORD` in `.env` - nothing is accessible until the correct
credentials are entered.

## AI Providers

You can configure 1, 2, or all 3 of these in `.env` - the more you add, the
faster scraping goes (each provider has its own independent rate limit,
and requests are rotated round-robin across all configured providers):

| Provider | Sign up | Free tier |
|---|---|---|
| Gemini | https://aistudio.google.com/apikey | ~15 req/min |
| Groq | https://console.groq.com/keys | ~30 req/min |
| OpenRouter | https://openrouter.ai/keys | ~20 req/min |

## API Usage

### 1. Run a scrape
A scrape can take a while (many posts × AI calls × contact lookups), so
`POST /api/scrape` starts the job in the background and returns a `jobId`
right away instead of making you wait on one long request.

```bash
POST /api/scrape
Content-Type: application/json

{
  "categoryUrl": "https://example.com/category/business",
  "startDate": "2026-06-01",
  "endDate": "2026-06-30"
}
```
Response: `{ "jobId": "..." }`

Poll for progress + the final result:
```bash
GET /api/scrape-progress/:jobId
```
Response: `{ status: "running" | "done" | "error", percent: 0-100, logs: [...], result: {...} | null, error: "..." | null }`

Once `status` is `"done"`, `result` has the same shape the old blocking
response used to: `totalPostsFound`, `totalSaved`, `entries[]`, `logs[]`,
`totalInDatabase`.

### 2. View all saved results so far
```bash
GET /api/results
```

### 3. Export to Excel
```bash
GET /api/export/excel
```
Downloads a `.xlsx` file with all saved entries.

### 4. Debug tools (fast, no AI cost)

```bash
GET /api/debug-post?url=https://example.com/some-post
```
Shows the fetch mode (static/dynamic), extracted title, publish date, and a
content preview for a single post - useful for diagnosing why a specific
site's date/content isn't being picked up correctly.

```bash
GET /api/debug-pagination?url=https://example.com/category&steps=5
```
Step-by-step tests click-based pagination (Load More / Next arrow) on a
category page, showing exactly which selector matched, whether the click
actually changed the page content, and the URL before/after each click.

## Architecture

```
categoryUrl + date range
        │
        ▼
paginationBuilder.js  →  detects the site's real pagination pattern from
        │                page 1's HTML (e.g. /page/2/, ?paged=2)
        ▼
renderModeDetector.js →  decides per page whether Cheerio (static) is
        │                enough, or Playwright (dynamic/JS-rendered) is needed
        ▼
linkExtractor.js      →  extracts only real post links from the category
        │                page (tag/category/pagination/login links excluded),
        │                plus a date-hint if the listing shows one
        ▼
loadMoreExpander.js   →  fallback for JS-driven pagination (Load More button
        │                OR a numbered Next-arrow) when the URL doesn't
        │                change - clicks through pages like a human would
        ▼
contentExtractor.js   →  uses Readability to strip ads/nav/footer, extracting
        │                clean article text + metadata (image, date, author, etc.)
        ▼
entityExtractor.js    →  sends the clean text to Gemini/Groq/OpenRouter
        │                (round-robin), with a strict "no-guessing" prompt,
        │                gets back a structured list of companies found
        ▼
pipeline.js           →  applies the save condition (owner AND business name
        │                required per company), confirms the actual publish
        │                date from each post, builds the final entries
        ▼
store.js              →  saves to a JSON file + Excel export
```

## Deploying on Render.com (Docker)

This project includes a `Dockerfile` that installs Chromium with all its
system dependencies during the build - this is the most reliable way to
get Playwright working on Render, since Render's native Node build
environment has repeatedly failed to install the browser correctly (even
with a `postinstall` script).

**To deploy with Docker on Render:**
1. In your Render service settings, change **Environment** to **Docker**
2. Point it at the `Dockerfile` in the repo root
3. Add your environment variables (API keys etc.) in the Render dashboard
4. Deploy

If you prefer to stick with the native Node environment instead, you can
override the **Build Command** to:
```
npm install && npx playwright install --with-deps chromium
```

## Important Notes

1. **Concurrency** - `.env`'s `CONCURRENCY` controls how many posts are
   processed in parallel. Too high and sites may block you; 2-4 is a safe range.

2. **Anti-bot sites** - Cloudflare-protected or heavily bot-guarded sites
   may fail with this basic setup. Let us know if a specific site blocks
   you and we can look at adding a stealth layer.

3. **Pagination detection** - The system tries, in order: (a) a detected
   URL pattern from page 1, (b) if that yields nothing new, a click-based
   fallback (Load More button or numbered Next-arrow) that works
   regardless of the underlying mechanism.

4. **Rate limits** - Each AI provider has its own rate limit; requests are
   automatically spaced and retried with backoff on 429 errors.

5. **Data storage** - Currently a simple JSON file (`data/results.json`).
   For larger scale or production use, MongoDB would be a better fit.

const axios = require("axios");
const cheerio = require("cheerio");
const { fetchWithAutoDetect } = require("./renderModeDetector");

/**
 * Free, no-API-key phone/email enrichment.
 *
 * When the AI didn't find a phone/email directly in the article text, we
 * do a best-effort web search for "<Business Name> <City> phone email
 * contact" (DuckDuckGo first, Bing as a backup if DuckDuckGo comes back
 * empty/blocked), then regex-scan the result snippets for a phone number
 * and/or email. If that's not enough, we fetch the top few result pages
 * themselves (skipping social-media links, which need login/JS and rarely
 * work here) - including trying a guessed "/contact-us" page on the same
 * site, since that's usually where the actual phone/email lives, not the
 * homepage.
 *
 * Nothing here uses AI - this is pure scraping + regex, so it costs no AI
 * credits and no money. It is NOT guaranteed to find anything - many small
 * local businesses simply have no searchable web presence at all. If
 * nothing is found, the field is simply left blank (never guessed).
 *
 * DEBUG_ENRICH=0 (env var) turns off the step-by-step server console
 * trace - it's ON by default so you can see exactly what's being
 * searched/fetched and why something wasn't found.
 */

const DEBUG = process.env.DEBUG_ENRICH !== "0";

function dlog(...args) {
  if (DEBUG) console.log("[enrich]", ...args);
}

const COMMON_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

// Domains that are technically "results" but not worth fetching for
// contact info - they need login/JS to render, or are never business
// contact pages (video/social/general reference sites).
const SKIP_DOMAINS = [
  "facebook.com",
  "instagram.com",
  "twitter.com",
  "x.com",
  "youtube.com",
  "pinterest.com",
  "threads.net",
  "wikipedia.org",
  "linkedin.com",
  "reddit.com",
];

// --- Regex patterns ---------------------------------------------------

const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

const EMAIL_JUNK_PATTERNS = [
  /^(no-?reply|donotreply|example|test|sentry|admin|webmaster|postmaster)@/i,
  /\.(png|jpg|jpeg|gif|svg|webp)$/i,
  /@(sentry\.io|wixpress\.com|godaddy\.com|schema\.org|w3\.org|example\.com|domain\.com|duckduckgo\.com|bing\.com)$/i,
  /\d{6,}@/,
];

// Groups-with-separators pattern (e.g. "022-4567-8901", "+91 98765 43210")
const PHONE_SEPARATED_REGEX = /(\+\d{1,3}[-.\s]?)?(\(?\d{2,5}\)?[-.\s]){1,4}\d{3,4}(?![\d])/g;

// Plain, unformatted Indian mobile number (e.g. "9876543210", "919876543210")
// - starts with 6-9, exactly 10 digits, with lookaround so we don't grab a
// piece of a longer number (like a pincode-glued string or an ID).
const PHONE_PLAIN_INDIA_REGEX = /(?<!\d)(?:\+?91[-\s]?)?[6-9]\d{9}(?!\d)/g;

function isJunkEmail(email) {
  return EMAIL_JUNK_PATTERNS.some((p) => p.test(email));
}

function isSkippableDomain(hostname) {
  return SKIP_DOMAINS.some((d) => hostname === d || hostname.endsWith(`.${d}`));
}

// DuckDuckGo's html endpoint wraps result links in a redirect like
// "//duckduckgo.com/l/?uddg=<url-encoded-real-url>&rut=...". We decode the
// real destination out of the `uddg` param before using it.
function resolveDdgLink(href) {
  if (!href) return null;
  try {
    const normalized = href.startsWith("//") ? `https:${href}` : href;
    const url = new URL(normalized, "https://duckduckgo.com");
    const uddg = url.searchParams.get("uddg");
    if (uddg) return decodeURIComponent(uddg);
    return normalized;
  } catch {
    return null;
  }
}

function cleanPhoneCandidate(raw) {
  const digitsOnly = raw.replace(/[^\d+]/g, "");
  const digitCount = digitsOnly.replace(/\+/g, "").length;
  if (digitCount < 8 || digitCount > 13) return null;
  return raw.trim();
}

function extractEmailFrom(text) {
  if (!text) return null;
  const matches = text.match(EMAIL_REGEX) || [];
  for (const m of matches) {
    const email = m.trim().replace(/[.,;:]+$/, "");
    if (!isJunkEmail(email)) return email;
  }
  return null;
}

function extractPhoneFrom(html, text) {
  // Highest confidence: an actual tel: link
  if (html) {
    try {
      const $ = cheerio.load(html);
      const telHref = $('a[href^="tel:"]').first().attr("href");
      if (telHref) {
        const cleaned = cleanPhoneCandidate(telHref.replace(/^tel:/i, ""));
        if (cleaned) return cleaned;
      }
    } catch {
      /* malformed html, fall through to text regex */
    }
  }

  if (!text) return null;

  for (const regex of [PHONE_SEPARATED_REGEX, PHONE_PLAIN_INDIA_REGEX]) {
    const matches = text.match(regex) || [];
    for (const m of matches) {
      const cleaned = cleanPhoneCandidate(m);
      if (cleaned) return cleaned;
    }
  }
  return null;
}

// --- Rate limiter (be polite to search engines, avoid getting blocked) --

const SEARCH_MIN_INTERVAL_MS = 2500;
let lastCallAt = 0;
let queue = Promise.resolve();

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function scheduleSearchSlot() {
  const runNext = queue.then(async () => {
    const now = Date.now();
    const wait = Math.max(0, lastCallAt + SEARCH_MIN_INTERVAL_MS - now);
    if (wait > 0) await sleep(wait);
    lastCallAt = Date.now();
  });
  queue = runNext.catch(() => {});
  return runNext;
}

// --- Search engines -----------------------------------------------------

async function searchDuckDuckGo(query) {
  await scheduleSearchSlot();

  const res = await axios.get("https://html.duckduckgo.com/html/", {
    params: { q: query },
    headers: { ...COMMON_HEADERS, Referer: "https://duckduckgo.com/" },
    timeout: 15000,
    validateStatus: (status) => status < 500,
  });

  const $ = cheerio.load(res.data);
  const results = [];

  $(".result").each((_, el) => {
    const rawLink = $(el).find(".result__a").attr("href");
    const link = resolveDdgLink(rawLink);
    const snippet = $(el).find(".result__snippet").text().trim();
    if (link) results.push({ link, snippet, engine: "duckduckgo" });
  });

  return results;
}

async function searchBing(query) {
  await scheduleSearchSlot();

  const res = await axios.get("https://www.bing.com/search", {
    params: { q: query },
    headers: { ...COMMON_HEADERS, Referer: "https://www.bing.com/" },
    timeout: 15000,
    validateStatus: (status) => status < 500,
  });

  const $ = cheerio.load(res.data);
  const results = [];

  $("li.b_algo").each((_, el) => {
    const link = $(el).find("h2 a").first().attr("href");
    const snippet = $(el).find(".b_caption p, .b_lineclamp2, .b_lineclamp4").first().text().trim();
    if (link) results.push({ link, snippet, engine: "bing" });
  });

  return results;
}

// Runs both engines (DDG first, Bing as backup/supplement), dedupes by
// domain (we only need one URL per site), and drops unusable social/video
// domains up front.
async function gatherSearchResults(query) {
  const combined = [];

  try {
    const ddgResults = await searchDuckDuckGo(query);
    dlog(`DuckDuckGo returned ${ddgResults.length} result(s) for: "${query}"`);
    combined.push(...ddgResults);
  } catch (err) {
    dlog(`DuckDuckGo search failed: ${err.message}`);
  }

  // Only bother with Bing if DuckDuckGo didn't give us much - saves time/requests
  if (combined.length < 2) {
    try {
      const bingResults = await searchBing(query);
      dlog(`Bing returned ${bingResults.length} result(s) for: "${query}"`);
      combined.push(...bingResults);
    } catch (err) {
      dlog(`Bing search failed: ${err.message}`);
    }
  }

  const seenDomains = new Set();
  const deduped = [];
  for (const r of combined) {
    try {
      const hostname = new URL(r.link).hostname.replace(/^www\./, "");
      if (seenDomains.has(hostname)) continue;
      if (isSkippableDomain(hostname)) continue;
      seenDomains.add(hostname);
      deduped.push(r);
    } catch {
      /* invalid URL, skip */
    }
  }

  return deduped;
}

// Tries a page URL, and if given a homepage-ish URL, also tries a couple of
// common "contact us" paths on the same domain - phone/email usually live
// there, not on the homepage.
async function tryExtractFromSite(baseUrl, wantEmail, wantPhone) {
  let email = null;
  let phone = null;

  const candidateUrls = [baseUrl];
  try {
    const origin = new URL(baseUrl).origin;
    candidateUrls.push(`${origin}/contact-us`, `${origin}/contact`);
  } catch {
    /* invalid base URL, just try it as-is */
  }

  for (const url of candidateUrls) {
    if ((email || !wantEmail) && (phone || !wantPhone)) break;
    try {
      const { html } = await fetchWithAutoDetect(url);
      const $ = cheerio.load(html);
      $("script, style, noscript").remove();
      const pageText = $("body").text().replace(/\s+/g, " ").trim();

      if (!email && wantEmail) email = extractEmailFrom(pageText) || extractEmailFrom(html);
      if (!phone && wantPhone) phone = extractPhoneFrom(html, pageText);

      dlog(`  fetched ${url} -> email=${email || "-"}, phone=${phone || "-"}`);
    } catch (err) {
      dlog(`  could not fetch ${url}: ${err.message}`);
    }
  }

  return { email, phone };
}

/**
 * Given a business name + optional city, tries to find a phone number and
 * email address for free. Returns { phone, email } - either can be null
 * if not found. Never throws; genuine failures are swallowed and just
 * result in a blank field (we never guess).
 */
async function enrichContact({ businessName, city }) {
  if (!businessName) return { phone: null, email: null };

  const query = `${businessName} ${city || ""} phone email contact`.trim();
  dlog(`--- Looking up contact for "${businessName}"${city ? ` (${city})` : ""} ---`);

  let results = [];
  try {
    results = await gatherSearchResults(query);
  } catch (err) {
    dlog(`Search failed entirely: ${err.message}`);
    return { phone: null, email: null };
  }

  if (results.length === 0) {
    dlog(`No usable search results found - leaving phone/email blank.`);
    return { phone: null, email: null };
  }

  // Step 1: check the snippets themselves first (cheapest - no extra fetches)
  const combinedSnippetText = results.map((r) => r.snippet).join(" \n ");
  let email = extractEmailFrom(combinedSnippetText);
  let phone = extractPhoneFrom(null, combinedSnippetText);
  if (email) dlog(`  found email in search snippet: ${email}`);
  if (phone) dlog(`  found phone in search snippet: ${phone}`);

  if (email && phone) return { phone, email };

  // Step 2: fetch the top few result pages (+ their /contact-us page) and scan those too
  const topLinks = results.slice(0, 3).map((r) => r.link);

  for (const link of topLinks) {
    if (email && phone) break;
    const found = await tryExtractFromSite(link, !email, !phone);
    if (!email && found.email) email = found.email;
    if (!phone && found.phone) phone = found.phone;
  }

  dlog(`Final result for "${businessName}": email=${email || "not found"}, phone=${phone || "not found"}`);
  return { phone: phone || null, email: email || null };
}

module.exports = { enrichContact };

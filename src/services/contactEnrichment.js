const axios = require("axios");
const cheerio = require("cheerio");
const { fetchWithAutoDetect } = require("./renderModeDetector");
const { tryPaidProviders } = require("./contactApiProviders");

// Best-effort regex patterns - not perfect, but catch the common cases
const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
// Indian mobile numbers: optional +91, then a 10-digit number starting 6-9
// (this avoids false-matching random 10-digit numbers like IDs/pin-code
// combos that don't start with 6-9)
const PHONE_REGEX = /(?:\+91[-\s]?)?[6-9]\d{9}\b/;

// Simple rate limiter - DuckDuckGo can start blocking/CAPTCHA-ing if hit
// too fast, so we space searches out a bit (same pattern as the AI
// provider limiters elsewhere in this project)
let lastSearchAt = 0;
const MIN_SEARCH_INTERVAL_MS = 1500;
async function waitForSearchSlot() {
  const now = Date.now();
  const wait = Math.max(0, lastSearchAt + MIN_SEARCH_INTERVAL_MS - now);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastSearchAt = Date.now();
}

function extractContactInfo(text) {
  const emailMatch = text.match(EMAIL_REGEX);
  const phoneMatch = text.match(PHONE_REGEX);
  return {
    email: emailMatch ? emailMatch[0] : null,
    phone: phoneMatch ? phoneMatch[0] : null,
  };
}

// DuckDuckGo's HTML-only endpoint (html.duckduckgo.com/html/) doesn't need
// JS to render results, so a plain fast HTTP request is enough - no
// Playwright/browser needed for this part, and no API key required either.
async function searchDuckDuckGo(query) {
  await waitForSearchSlot();
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const res = await axios.get(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    },
    timeout: 15000,
  });

  const $ = cheerio.load(res.data);
  const results = [];
  $(".result__a").each((_, el) => {
    const href = $(el).attr("href");
    if (href) results.push(href);
  });
  return results;
}

/**
 * Best-effort contact-info lookup: FIRST tries a completely free DuckDuckGo
 * search + regex scan (no API key, no cost). If phone and/or email is STILL
 * missing after that, falls back to whichever paid providers are configured
 * in .env (Hunter -> Apollo -> Lusha -> RocketReach, in that order) - each
 * one only used for whatever's still missing, and automatically skipped
 * once its free quota runs out.
 *
 * - Only runs if phone/email isn't already present from the article itself.
 * - Never blocks or breaks the main scrape - any failure here just means
 *   phone/email stay blank, exactly as if nothing was searched at all.
 * - Accuracy is inherently best-effort (a generic business name could
 *   surface a same-named but unrelated business/person) - this is a
 *   genuine trade-off of searching beyond the article text itself.
 */
async function enrichContactInfo(company, log) {
  if (!company.businessName) {
    return { phone: company.phone || null, email: company.email || null };
  }
  if (company.phone && company.email) {
    return { phone: company.phone, email: company.email }; // already complete, nothing to look up
  }

  const query = `${company.businessName} ${company.ownerNames?.[0] || ""} contact phone email`.trim();

  let phone = company.phone || null;
  let email = company.email || null;

  try {
    const resultUrls = await searchDuckDuckGo(query);
    if (resultUrls.length === 0) {
      if (log) log(`[contact-enrichment] duckduckgo: no search results for "${company.businessName}"`);
    } else {
      const { html } = await fetchWithAutoDetect(resultUrls[0]);
      const $ = cheerio.load(html);
      $("script, style").remove();
      const pageText = $("body").text();
      const found = extractContactInfo(pageText);
      phone = phone || found.phone;
      email = email || found.email;
      if (!found.phone && !found.email && log) {
        log(`[contact-enrichment] duckduckgo: top result (${resultUrls[0]}) had no phone/email match for "${company.businessName}"`);
      }
    }
  } catch (err) {
    // Best-effort only - a free-search failure just means we fall through
    // to the paid providers below (if configured) instead of stopping here
    const msg = `[contact-enrichment] duckduckgo failed for "${company.businessName}": ${err.message}`;
    console.error(msg);
    if (log) log(msg);
  }

  if (phone && email) {
    return { phone, email }; // free search already found everything needed
  }

  // Still missing phone and/or email -> try configured paid providers
  const paidResult = await tryPaidProviders(
    { businessName: company.businessName, ownerNames: company.ownerNames, phone, email },
    log
  );
  return { phone: paidResult.phone, email: paidResult.email };
}

module.exports = { enrichContactInfo };
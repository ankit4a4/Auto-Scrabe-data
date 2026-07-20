const cheerio = require("cheerio");
const { fetchWithAutoDetect } = require("./renderModeDetector");
const { extractEmailFrom, isJunkEmail, EMAIL_REGEX } = require("./contactEnricher");
const config = require("../config");

/**
 * Automatic Email/Phone extraction directly from a company's own website.
 *
 * Given the business's official website (identified either from the
 * article text itself or via a best-effort search - see
 * contactEnricher.findOfficialWebsite), this visits the site using the
 * existing Playwright setup (fetchWithAutoDetect - static Cheerio fetch
 * when the page is plain HTML, automatically falling back to a real
 * Playwright browser page when the site is JS-rendered) and scrapes the
 * homepage plus common "about us" style pages (Contact, About, Team,
 * Support, Privacy) for:
 *   - emails found in mailto: links and visible page/footer text
 *   - phone numbers found in tel: links and visible page/footer text
 *
 * Nothing is guessed - if no email/phone is found anywhere on the site,
 * the corresponding field is simply returned as null.
 *
 * DEBUG_ENRICH=0 (env var, shared with contactEnricher.js) turns off the
 * step-by-step console trace.
 */

const DEBUG = process.env.DEBUG_ENRICH !== "0";
function dlog(...args) {
  if (DEBUG) console.log("[site-contact]", ...args);
}

// Same phone patterns as contactEnricher.js (kept local so this module has
// no surprise coupling beyond the email helpers, which really do need to
// stay byte-for-byte identical between both modules).
const PHONE_SEPARATED_REGEX = /(\+\d{1,3}[-.\s]?)?(\(?\d{2,5}\)?[-.\s]){1,4}\d{3,4}(?![\d])/g;
const PHONE_PLAIN_INDIA_REGEX = /(?<!\d)(?:\+?91[-\s]?)?[6-9]\d{9}(?!\d)/g;

// Keyword groups used to find the *real* Contact/About/Team/Support/Privacy
// links on the site itself (checked against both the link text and the
// href), tried in this priority order - contact pages are most likely to
// actually list a phone/email, so they're visited first.
const PAGE_KEYWORDS = [
  { label: "contact", patterns: [/contact/i] },
  { label: "about", patterns: [/about/i] },
  { label: "team", patterns: [/\bteam\b/i, /who-we-are/i] },
  { label: "support", patterns: [/support/i, /help/i] },
  { label: "privacy", patterns: [/privacy/i] },
];

// Guessed common paths - only used as a fallback for a page-type that
// wasn't discoverable via an actual link on the site.
const GUESSED_PATHS = {
  contact: ["/contact", "/contact-us", "/contactus"],
  about: ["/about", "/about-us", "/aboutus"],
  team: ["/team", "/our-team"],
  support: ["/support", "/help"],
  privacy: ["/privacy", "/privacy-policy"],
};

const MAX_PAGES_TO_VISIT = config.maxWebsiteContactPages || 6;

function normalizeWebsiteUrl(rawUrl) {
  if (!rawUrl) return null;
  let url = rawUrl.trim();
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  try {
    const parsed = new URL(url);
    return parsed.origin + (parsed.pathname !== "/" ? parsed.pathname : "");
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

// --- Extraction from one already-fetched page -----------------------------

function extractEmailsFromPage($, pageText) {
  const found = new Set();

  // Highest confidence: mailto: links (anywhere on the page, including the footer)
  $('a[href^="mailto:"]').each((_, el) => {
    const href = $(el).attr("href") || "";
    const email = decodeURIComponent(href.replace(/^mailto:/i, "").split("?")[0]).trim();
    if (email && !isJunkEmail(email)) found.add(email.toLowerCase());
  });

  // Visible text (main content + footer, since $ already contains the whole page)
  const textMatches = pageText.match(EMAIL_REGEX) || [];
  for (const m of textMatches) {
    const email = m.trim().replace(/[.,;:]+$/, "");
    if (!isJunkEmail(email)) found.add(email.toLowerCase());
  }

  return found;
}

function extractPhonesFromPage($, pageText) {
  const found = new Set();

  // Highest confidence: tel: links
  $('a[href^="tel:"]').each((_, el) => {
    const href = $(el).attr("href") || "";
    const cleaned = cleanPhoneCandidate(href.replace(/^tel:/i, ""));
    if (cleaned) found.add(cleaned);
  });

  // Visible text
  for (const regex of [PHONE_SEPARATED_REGEX, PHONE_PLAIN_INDIA_REGEX]) {
    const matches = pageText.match(regex) || [];
    for (const m of matches) {
      const cleaned = cleanPhoneCandidate(m);
      if (cleaned) found.add(cleaned);
    }
  }

  return found;
}

// --- Discover real Contact/About/Team/Support/Privacy links on the site ---

function discoverCandidateLinks(html, baseUrl) {
  const $ = cheerio.load(html);
  const origin = new URL(baseUrl).origin;
  const byLabel = new Map(); // label -> absolute URL (first match wins)

  $("a[href]").each((_, el) => {
    const href = $(el).attr("href") || "";
    const text = $(el).text() || "";
    if (!href || href.startsWith("mailto:") || href.startsWith("tel:") || href.startsWith("#")) return;

    let absolute;
    try {
      absolute = new URL(href, baseUrl).toString();
    } catch {
      return;
    }
    // Stay on the same site - we don't want to wander off to unrelated domains
    if (!absolute.startsWith(origin)) return;

    for (const { label, patterns } of PAGE_KEYWORDS) {
      if (byLabel.has(label)) continue;
      const haystack = `${href} ${text}`;
      if (patterns.some((p) => p.test(haystack))) {
        byLabel.set(label, absolute);
      }
    }
  });

  return byLabel;
}

/**
 * Given a company's official website URL, visits the homepage plus
 * Contact/About/Team/Support/Privacy pages (discovered from the site's own
 * nav/footer links, falling back to common guessed paths when a page type
 * isn't linked anywhere) and scrapes for publicly available email
 * addresses and phone numbers.
 *
 * Returns { email, phone } - each is a single deduplicated value (the
 * first plausible one found, prioritizing mailto:/tel: links over plain
 * text matches) or null if nothing was found anywhere on the site. Never
 * throws - any fetch/parse failure for an individual page is skipped, and
 * a total failure just results in { email: null, phone: null }.
 */
async function extractContactFromWebsite(websiteUrl) {
  const homepage = normalizeWebsiteUrl(websiteUrl);
  if (!homepage) return { email: null, phone: null, emails: [], phones: [] };

  dlog(`--- Visiting website: ${homepage} ---`);

  const visited = new Set();
  const allEmails = new Set();
  const allPhones = new Set();

  async function visitAndExtract(url) {
    if (visited.has(url) || visited.size >= MAX_PAGES_TO_VISIT) return null;
    visited.add(url);
    try {
      const { html } = await fetchWithAutoDetect(url);
      const $ = cheerio.load(html);
      $("script, style, noscript").remove();
      const pageText = $("body").text().replace(/\s+/g, " ").trim();

      const emails = extractEmailsFromPage($, pageText);
      const phones = extractPhonesFromPage($, pageText);
      emails.forEach((e) => allEmails.add(e));
      phones.forEach((p) => allPhones.add(p));

      dlog(`  ${url} -> +${emails.size} email(s), +${phones.size} phone(s)`);
      return html;
    } catch (err) {
      dlog(`  could not fetch ${url}: ${err.message}`);
      return null;
    }
  }

  // 1. Homepage first (footer contact details are extremely common here)
  const homepageHtml = await visitAndExtract(homepage);

  // 2. Discover real Contact/About/Team/Support/Privacy links from the
  //    homepage itself, and visit them in priority order until either both
  //    an email and a phone have been found or we hit the page-visit cap.
  const discovered = homepageHtml ? discoverCandidateLinks(homepageHtml, homepage) : new Map();

  for (const { label } of PAGE_KEYWORDS) {
    if (allEmails.size > 0 && allPhones.size > 0) break;
    if (visited.size >= MAX_PAGES_TO_VISIT) break;

    const link = discovered.get(label);
    if (link) {
      await visitAndExtract(link);
      continue;
    }

    // Not linked anywhere findable - try the common guessed path(s) for this page type
    for (const guessedPath of GUESSED_PATHS[label]) {
      if (allEmails.size > 0 && allPhones.size > 0) break;
      if (visited.size >= MAX_PAGES_TO_VISIT) break;
      const guessedUrl = new URL(guessedPath, homepage).toString();
      await visitAndExtract(guessedUrl);
    }
  }

  const emails = Array.from(allEmails);
  const phones = Array.from(allPhones);

  dlog(
    `Final result for ${homepage}: emails=${emails.length ? emails.join(", ") : "none"}, ` +
      `phones=${phones.length ? phones.join(", ") : "none"}`
  );

  return {
    email: emails[0] || null,
    phone: phones[0] || null,
    emails, // full deduplicated list, in case more than one is needed later
    phones,
  };
}

module.exports = { extractContactFromWebsite, normalizeWebsiteUrl };

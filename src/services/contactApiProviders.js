const axios = require("axios");
const config = require("../config");

// Once a provider's free quota runs out (402/429 response), we mark it
// "exhausted" for the rest of this server session so we stop wasting
// requests on it and move straight to the next provider each time.
const exhausted = {
  hunter: false,
  apollo: false,
  lusha: false,
  rocketreach: false,
};

function isQuotaError(err) {
  const status = err.response?.status;
  return status === 402 || status === 429 || status === 403;
}

// Turns an axios error into a short, human-readable reason so we can tell
// "invalid/expired key" apart from "quota used up" apart from "no match
// found" - all three used to look identical (silently return nulls).
function describeError(err) {
  const status = err.response?.status;
  const apiMessage =
    err.response?.data?.error?.message ||
    err.response?.data?.message ||
    err.response?.data?.error ||
    err.message;

  if (status === 401) return `INVALID/EXPIRED API KEY (401) - ${apiMessage}`;
  if (status === 402) return `QUOTA/CREDITS EXHAUSTED (402) - ${apiMessage}`;
  if (status === 403) return `FORBIDDEN/QUOTA (403) - ${apiMessage}`;
  if (status === 429) return `RATE LIMITED (429) - ${apiMessage}`;
  if (status === 404) return `NO MATCH FOUND (404) - ${apiMessage}`;
  if (status) return `API ERROR (${status}) - ${apiMessage}`;
  return `REQUEST FAILED (no response) - ${apiMessage}`;
}

// Logs to both the scrape's own progress log (visible in the UI/API
// response) and the server console (always, even for debug endpoints that
// don't pass a log function).
function reportError(providerName, err, log) {
  const msg = `[contact-enrichment] ${providerName} failed: ${describeError(err)}`;
  console.error(msg);
  if (log) log(msg);
}

// ---------------------------------------------------------------------------
// 1) Hunter.io - EMAIL ONLY (Hunter's API does not provide phone numbers at
//    any plan tier). Uses the Email Finder endpoint: full_name + company.
// ---------------------------------------------------------------------------
async function tryHunter(company, log) {
  if (!config.hunterApiKey) return { phone: null, email: null };
  if (exhausted.hunter) {
    if (log) log(`[contact-enrichment] hunter skipped: marked exhausted earlier this session (quota/auth error)`);
    return { phone: null, email: null };
  }
  if (!company.ownerNames?.[0]) {
    if (log) log(`[contact-enrichment] hunter skipped: no owner name extracted for "${company.businessName}"`);
    return { phone: null, email: null }; // Hunter needs a person's name
  }

  try {
    const res = await axios.get("https://api.hunter.io/v2/email-finder", {
      params: {
        full_name: company.ownerNames[0],
        company: company.businessName,
        api_key: config.hunterApiKey,
      },
      timeout: 15000,
    });
    const email = res.data?.data?.email || null;
    if (!email && log) log(`[contact-enrichment] hunter: no email found for "${company.ownerNames[0]}" / "${company.businessName}"`);
    return { phone: null, email }; // Hunter never returns phone numbers
  } catch (err) {
    if (isQuotaError(err)) exhausted.hunter = true;
    reportError("hunter", err, log);
    return { phone: null, email: null };
  }
}

// ---------------------------------------------------------------------------
// 2) Apollo.io - People Enrichment endpoint. Can return both email and
//    phone synchronously with reveal_personal_emails / reveal_phone_number.
//    (Apollo also offers a more thorough async "waterfall" phone lookup via
//    webhook, which needs a public webhook URL - skipped here for simplicity.)
// ---------------------------------------------------------------------------
async function tryApollo(company, log) {
  if (!config.apolloApiKey) return { phone: null, email: null };
  if (exhausted.apollo) {
    if (log) log(`[contact-enrichment] apollo skipped: marked exhausted earlier this session (quota/auth error)`);
    return { phone: null, email: null };
  }

  const nameParts = (company.ownerNames?.[0] || "").split(" ");
  const first_name = nameParts[0] || undefined;
  const last_name = nameParts.slice(1).join(" ") || undefined;

  try {
    const res = await axios.post(
      "https://api.apollo.io/api/v1/people/match",
      {
        first_name,
        last_name,
        organization_name: company.businessName,
        reveal_personal_emails: true,
        reveal_phone_number: true,
      },
      {
        headers: {
          "Content-Type": "application/json",
          "X-Api-Key": config.apolloApiKey,
        },
        timeout: 15000,
      }
    );
    const person = res.data?.person;
    const result = {
      phone: person?.phone_numbers?.[0]?.raw_number || null,
      email: person?.email || null,
    };
    if (!result.phone && !result.email && log) {
      log(`[contact-enrichment] apollo: no match for "${company.ownerNames?.[0] || "?"}" / "${company.businessName}"`);
    }
    return result;
  } catch (err) {
    if (isQuotaError(err)) exhausted.apollo = true;
    reportError("apollo", err, log);
    return { phone: null, email: null };
  }
}

// ---------------------------------------------------------------------------
// 3) Lusha - Person API v2. Simpler firstName/lastName/companyName lookup
//    (v2 is marked "still operational" by Lusha - if it's deprecated on
//    your account, this call will just fail gracefully and get skipped).
// ---------------------------------------------------------------------------
async function tryLusha(company, log) {
  if (!config.lushaApiKey) return { phone: null, email: null };
  if (exhausted.lusha) {
    if (log) log(`[contact-enrichment] lusha skipped: marked exhausted earlier this session (quota/auth error)`);
    return { phone: null, email: null };
  }

  const nameParts = (company.ownerNames?.[0] || "").split(" ");
  const firstName = nameParts[0] || undefined;
  const lastName = nameParts.slice(1).join(" ") || undefined;

  try {
    const res = await axios.get("https://api.lusha.com/v2/person", {
      params: {
        firstName,
        lastName,
        companyName: company.businessName,
      },
      headers: { api_key: config.lushaApiKey },
      timeout: 15000,
    });
    const data = res.data?.data;
    const result = {
      phone: data?.phoneNumbers?.[0]?.number || null,
      email: data?.emailAddresses?.[0]?.email || null,
    };
    if (!result.phone && !result.email && log) {
      log(`[contact-enrichment] lusha: no match for "${company.ownerNames?.[0] || "?"}" / "${company.businessName}"`);
    }
    return result;
  } catch (err) {
    if (isQuotaError(err)) exhausted.lusha = true;
    reportError("lusha", err, log);
    return { phone: null, email: null };
  }
}

// ---------------------------------------------------------------------------
// 4) RocketReach - Person Lookup endpoint. name + current_employer.
// ---------------------------------------------------------------------------
async function tryRocketReach(company, log) {
  if (!config.rocketreachApiKey) return { phone: null, email: null };
  if (exhausted.rocketreach) {
    if (log) log(`[contact-enrichment] rocketreach skipped: marked exhausted earlier this session (quota/auth error)`);
    return { phone: null, email: null };
  }
  if (!company.ownerNames?.[0]) {
    if (log) log(`[contact-enrichment] rocketreach skipped: no owner name extracted for "${company.businessName}"`);
    return { phone: null, email: null };
  }

  try {
    const res = await axios.get("https://api.rocketreach.co/api/v2/person/lookup", {
      params: {
        name: company.ownerNames[0],
        current_employer: company.businessName,
      },
      headers: { "Api-Key": config.rocketreachApiKey },
      timeout: 15000,
    });
    const emails = res.data?.emails;
    const phones = res.data?.phones;
    const result = {
      phone: phones?.[0]?.number || null,
      email: emails?.[0]?.email || null,
    };
    if (!result.phone && !result.email && log) {
      log(`[contact-enrichment] rocketreach: no match for "${company.ownerNames[0]}" / "${company.businessName}"`);
    }
    return result;
  } catch (err) {
    if (isQuotaError(err)) exhausted.rocketreach = true;
    reportError("rocketreach", err, log);
    return { phone: null, email: null };
  }
}

/**
 * Tries each configured paid provider IN ORDER (Hunter -> Apollo -> Lusha ->
 * RocketReach), stopping as soon as BOTH phone and email are found. A
 * provider with no API key configured, or whose free quota has already run
 * out this session, is skipped automatically - no code changes needed, just
 * add/remove keys in .env.
 *
 * This only runs for whatever the free DuckDuckGo search (contactEnrichment.js)
 * couldn't find - it's a fallback on top of a fallback, all best-effort.
 */
async function tryPaidProviders(company, log) {
  let phone = company.phone || null;
  let email = company.email || null;

  const providers = [
    { name: "hunter", fn: tryHunter, hasKey: Boolean(config.hunterApiKey) },
    { name: "apollo", fn: tryApollo, hasKey: Boolean(config.apolloApiKey) },
    { name: "lusha", fn: tryLusha, hasKey: Boolean(config.lushaApiKey) },
    { name: "rocketreach", fn: tryRocketReach, hasKey: Boolean(config.rocketreachApiKey) },
  ];

  for (const { name, fn, hasKey } of providers) {
    if (phone && email) break; // both already found, no need to try more
    if (!hasKey) {
      if (log) log(`[contact-enrichment] ${name} skipped: no API key configured in .env`);
      continue;
    }
    const result = await fn({ ...company, phone, email }, log);
    phone = phone || result.phone;
    email = email || result.email;
  }

  return { phone, email };
}

module.exports = { tryPaidProviders };
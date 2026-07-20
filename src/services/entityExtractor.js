const axios = require("axios");
const config = require("../config");

/**
 * Multi-provider AI entity extractor.
 *
 * Previously only Gemini was used (free tier 15 req/min), which was a
 * bottleneck. Now up to six providers are rotated round-robin: Gemini +
 * Groq + OpenRouter + Cerebras + Mistral + NVIDIA NIM. Each provider has
 * its own independent rate-limit clock, so combined throughput is the SUM
 * of all active providers' rate limits (more providers = more speed).
 *
 * The more API keys you put in .env, the faster/more parallel the scraping
 * will be. If only one key is set, only that one is used (just a bit slower).
 */

// ---------------------------------------------------------------------------
// Prompt
//
// IMPORTANT: a single article can profile MORE THAN ONE company (e.g. a
// roundup article like "5 entrepreneurs running their own businesses"),
// and each company has its own separate owner(s). So instead of asking for
// a FLAT ownerNames list, we ask for a "companies" ARRAY, where each
// company has its own businessName + its own ownerNames + its own city.
// This fixes the bug where "all founders get lumped into the first/main
// company."
// ---------------------------------------------------------------------------
function buildPrompt(article) {
  return `You are a strict information-extraction engine for a BUSINESS/ENTREPRENEURSHIP database.

FIRST, decide: is this article actually PROFILING one or more business owners, founders, co-founders, or CEOs and their company/venture? Only articles about real businesses and the people who own/run them count.

Articles that DO NOT count (return {"companies": []} even if names appear in them):
- Movie reviews, film/TV/celebrity news, entertainment pieces
- Sports articles, politics, general news unrelated to a specific business
- Generic listicles, event coverage, or opinion pieces that don't profile a specific business owner

If it DOES qualify, this article may profile ONE company or SEVERAL SEPARATE, UNRELATED companies (e.g. a roundup article featuring multiple different entrepreneurs and their own ventures). For EACH distinct company mentioned, create ONE separate entry in the "companies" array.

CRITICAL RELATIONSHIP RULE - read carefully:
- Only associate a person's name with a company if the article EXPLICITLY states that specific person is an owner/founder/co-founder/CEO of that specific company.
- Do NOT dump every person's name mentioned anywhere in the article into one company's owner list.
- Example: if the article says "Bhupendra Patel founded Home Sizzler, Prachi Patwardhan founded GirlZFashion, and Vivek Sharma founded Decor Hand" - these are THREE separate companies, each with exactly ONE owner. Do NOT combine them into one entry.
- Only put MULTIPLE names in a single company's ownerNames array when the article explicitly says those specific people are co-founders/partners/joint-owners of THAT SAME company (e.g. "Ravi and Sunita together started XYZ Foods").
- If a company's owner is not clearly stated, still include the company with an empty ownerNames array - but never guess or borrow a name from a different company/person mentioned elsewhere in the article.

For each company entry, extract:
- businessName: the company / brand name, ONLY if explicitly named in the text.
- ownerNames: an ARRAY of the full name(s) of ONLY the people explicitly identified as owner/founder/co-founder/CEO of THIS specific company. Empty array if none named for this company.
- city: a city name for THIS specific company, ONLY if explicitly mentioned in connection with it in the text. Otherwise null.
- website: THIS specific company's official website/domain (e.g. "www.example.com" or "example.com"), ONLY if explicitly written in the text (as a URL or a domain-looking string). Otherwise null.
- phone: a phone/contact number for THIS specific company or its owner, ONLY if explicitly written in the text. Otherwise null.
- email: an email address for THIS specific company or its owner, ONLY if explicitly written in the text. Otherwise null.

STRICT RULES (very important):
1. Do NOT guess, infer, or use outside/general knowledge. If a field is not directly stated in the article text, leave it as null (or empty array for ownerNames).
2. Do NOT assume a company's headquarters city from general knowledge - only use a city if the article text itself mentions it in connection with that company.
3. If a sentence implies the relationship (e.g. "Ritesh Agarwal started OYO in Gurugram"), that counts as explicit mention - extract it.
4. Each company gets its OWN entry in the array, with its OWN owners - never merge people or companies together.
5. ownerNames must contain ONLY real person names. NEVER put the business/brand name itself into ownerNames, and never put generic placeholders like "the company", "the team", "unknown", or "not mentioned" - if no real person's name is stated, leave ownerNames as an empty array.
6. Never fabricate a phone number, email address, or website - only use one if it is written verbatim in the article text.
7. Return ONLY valid JSON, no markdown, no explanation, no extra text.

ARTICLE TITLE: ${article.title || "N/A"}

ARTICLE TEXT:
"""
${article.textContent}
"""

Return strictly in this JSON shape (companies is an array - one item per distinct company found, empty array if none qualify):
{"companies": [{"businessName": string or null, "ownerNames": string[], "city": string or null, "website": string or null, "phone": string or null, "email": string or null}]}`;
}

function safeParseJson(rawText) {
  if (!rawText) return null;
  // Models sometimes wrap output in ```json fences - strip those out
  const cleaned = rawText.replace(/```json|```/g, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    // Last resort: try to extract the first {...} block
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch {
        return null;
      }
    }
    return null;
  }
}

// Extract a "retry in 47.2s" style hint from a Google/OpenAI style error message, if present
function extractRetryDelayMs(message) {
  const match = /retry in ([\d.]+)s/i.exec(message || "");
  if (match) return Math.ceil(parseFloat(match[1]) * 1000) + 1000; // +1s buffer
  return null;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Per-provider rate limiter (calls are globally spaced within MIN_INTERVAL_MS -
// previously this only existed for Gemini, now every provider has its own)
// ---------------------------------------------------------------------------
function makeLimiter(minIntervalMs) {
  let lastCallAt = 0;
  let queue = Promise.resolve();

  return function scheduleSlot() {
    const runNext = queue.then(async () => {
      const now = Date.now();
      const wait = Math.max(0, lastCallAt + minIntervalMs - now);
      if (wait > 0) await sleep(wait);
      lastCallAt = Date.now();
    });
    queue = runNext.catch(() => {}); // keep the queue running even if one slot fails
    return runNext;
  };
}

// ---------------------------------------------------------------------------
// Provider 1: Gemini
// ---------------------------------------------------------------------------
const GEMINI_ENDPOINT = (model, apiKey) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

const GEMINI_SCHEMA = {
  type: "object",
  properties: {
    companies: {
      type: "array",
      items: {
        type: "object",
        properties: {
          businessName: { type: "string", nullable: true },
          ownerNames: { type: "array", items: { type: "string" } },
          city: { type: "string", nullable: true },
          website: { type: "string", nullable: true },
          phone: { type: "string", nullable: true },
          email: { type: "string", nullable: true },
        },
        required: ["businessName", "ownerNames", "city", "website", "phone", "email"],
      },
    },
  },
  required: ["companies"],
};

async function callGemini(article) {
  const body = {
    contents: [{ role: "user", parts: [{ text: buildPrompt(article) }] }],
    generationConfig: {
      temperature: 0,
      responseMimeType: "application/json",
      responseSchema: GEMINI_SCHEMA,
    },
  };

  const url = GEMINI_ENDPOINT(config.geminiModel, config.geminiApiKey);
  const res = await axios.post(url, body, {
    headers: { "Content-Type": "application/json" },
    timeout: 30000,
  });

  const rawText = res.data?.candidates?.[0]?.content?.parts?.[0]?.text || null;
  return safeParseJson(rawText);
}

// ---------------------------------------------------------------------------
// Provider 2 & 3: Groq / OpenRouter - both use an OpenAI-compatible chat
// completions endpoint, so one generic caller is enough for both.
// ---------------------------------------------------------------------------
function makeOpenAiCompatibleCaller({ baseUrl, apiKey, model, extraHeaders }) {
  return async function call(article) {
    const res = await axios.post(
      `${baseUrl}/chat/completions`,
      {
        model,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [{ role: "user", content: buildPrompt(article) }],
      },
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
          ...extraHeaders,
        },
        timeout: 30000,
      }
    );

    const rawText = res.data?.choices?.[0]?.message?.content || null;
    return safeParseJson(rawText);
  };
}

// ---------------------------------------------------------------------------
// Active providers list - only providers with an API key found in .env
// become active. So 1, 2, or 3 keys means that many providers get rotated.
// ---------------------------------------------------------------------------
function isConfigured(key) {
  return Boolean(key) && !key.startsWith("your_");
}

function buildProviders() {
  const providers = [];

  if (isConfigured(config.geminiApiKey)) {
    providers.push({
      name: "gemini",
      call: callGemini,
      scheduleSlot: makeLimiter(config.geminiMinIntervalMs),
    });
  }

  if (isConfigured(config.groqApiKey)) {
    providers.push({
      name: "groq",
      call: makeOpenAiCompatibleCaller({
        baseUrl: "https://api.groq.com/openai/v1",
        apiKey: config.groqApiKey,
        model: config.groqModel,
      }),
      scheduleSlot: makeLimiter(config.groqMinIntervalMs),
    });
  }

  if (isConfigured(config.openrouterApiKey)) {
    providers.push({
      name: "openrouter",
      call: makeOpenAiCompatibleCaller({
        baseUrl: "https://openrouter.ai/api/v1",
        apiKey: config.openrouterApiKey,
        model: config.openrouterModel,
        extraHeaders: {
          "HTTP-Referer": "https://auto-scraper.local",
          "X-Title": "Auto Scraper",
        },
      }),
      scheduleSlot: makeLimiter(config.openrouterMinIntervalMs),
    });
  }

  if (isConfigured(config.cerebrasApiKey)) {
    providers.push({
      name: "cerebras",
      call: makeOpenAiCompatibleCaller({
        baseUrl: "https://api.cerebras.ai/v1",
        apiKey: config.cerebrasApiKey,
        model: config.cerebrasModel,
      }),
      scheduleSlot: makeLimiter(config.cerebrasMinIntervalMs),
    });
  }

  if (isConfigured(config.mistralApiKey)) {
    providers.push({
      name: "mistral",
      call: makeOpenAiCompatibleCaller({
        baseUrl: "https://api.mistral.ai/v1",
        apiKey: config.mistralApiKey,
        model: config.mistralModel,
      }),
      scheduleSlot: makeLimiter(config.mistralMinIntervalMs),
    });
  }

  if (isConfigured(config.nvidiaApiKey)) {
    providers.push({
      name: "nvidia",
      call: makeOpenAiCompatibleCaller({
        baseUrl: "https://integrate.api.nvidia.com/v1",
        apiKey: config.nvidiaApiKey,
        model: config.nvidiaModel,
      }),
      scheduleSlot: makeLimiter(config.nvidiaMinIntervalMs),
    });
  }

  return providers;
}

const providers = buildProviders();
let rrIndex = 0;

// Each call tries the next provider in rotation first, with the rest kept
// in order as fallbacks (in case one provider fails/is rate-limited).
function providerOrderForThisCall() {
  const n = providers.length;
  const order = [];
  for (let i = 0; i < n; i++) order.push(providers[(rrIndex + i) % n]);
  rrIndex = (rrIndex + 1) % n;
  return order;
}

/**
 * Takes an article object (from contentExtractor.js) and returns an ARRAY -
 * each item is a separate COMPANY with its own { ownerNames, businessName,
 * city }. A single article can contain multiple unrelated companies
 * (roundup articles), so this never returns a flat single-object anymore -
 * you always get companies[] (an empty array if the article doesn't
 * qualify or nothing was found).
 *
 * Rotation + fallback: each request goes to the next provider in
 * round-robin order. If that provider fails/is rate-limited, the next
 * provider is tried for the same request (without showing the user an
 * error), keeping throughput consistent.
 */
async function extractEntities(article) {
  if (providers.length === 0) {
    throw new Error(
      "No AI provider is configured. Add at least one of GEMINI_API_KEY, GROQ_API_KEY, or OPENROUTER_API_KEY to the .env file."
    );
  }

  const order = providerOrderForThisCall();
  let lastErr = null;

  for (const provider of order) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      await provider.scheduleSlot(); // wait for our turn (respecting this provider's rate limit)

      try {
        const parsed = await provider.call(article);

        // New format: { companies: [{businessName, ownerNames, city}, ...] }
        let rawCompanies;
        if (Array.isArray(parsed?.companies)) {
          rawCompanies = parsed.companies;
        } else if (parsed?.businessName || (Array.isArray(parsed?.ownerNames) && parsed.ownerNames.length)) {
          // Backward-compat: if a model ever returns the old flat format, treat it as one company
          rawCompanies = [parsed];
        } else {
          rawCompanies = [];
        }

        const companies = rawCompanies
          .map((c) => ({
            businessName: c?.businessName || null,
            ownerNames: Array.isArray(c?.ownerNames)
              ? c.ownerNames
                  .map((n) => (typeof n === "string" ? n.trim() : n))
                  .filter(Boolean)
                  // Safety check: sometimes a model mistakenly puts the
                  // business/brand name itself into ownerNames (as if it
                  // were a person). Since that's not a real owner name,
                  // we filter those out here.
                  .filter((n) => {
                    if (!c?.businessName) return true;
                    return n.toLowerCase().trim() !== c.businessName.toLowerCase().trim();
                  })
                  // Also filter out generic non-name placeholders a model
                  // might produce instead of leaving the field empty
                  .filter((n) => !/^(unknown|n\/a|not mentioned|not specified|none|the company|the team|team)$/i.test(n))
              : c?.ownerName
              ? [c.ownerName]
              : [],
            city: c?.city || null,
            website: c?.website ? String(c.website).trim() || null : null,
            phone: c?.phone ? String(c.phone).trim() || null : null,
            email: c?.email ? String(c.email).trim() || null : null,
          }))
          // Remove empty/junk entries (where neither an owner nor a business name was found)
          .filter((c) => c.businessName || c.ownerNames.length > 0);

        return companies;
      } catch (err) {
        const status = err.response?.status;
        const apiMessage = err.response?.data?.error?.message || err.message;
        lastErr = new Error(`[${provider.name}] ${apiMessage}`);

        // 429 = rate limit exceeded -> retry on this same provider (if a wait time was given)
        if (status === 429 && attempt < 2) {
          const delay = extractRetryDelayMs(apiMessage) || 5000;
          await sleep(delay);
          continue;
        }
        break; // this provider didn't work out -> move to the next provider in order
      }
    }
  }

  throw lastErr || new Error("All configured providers failed");
}

module.exports = { extractEntities, activeProviderNames: providers.map((p) => p.name) };

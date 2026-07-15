const axios = require("axios");
const config = require("../config");

/**
 * Multi-provider AI entity extractor.
 *
 * Pehle sirf Gemini use hota tha (free tier 15 req/min), jo bottleneck tha.
 * Ab teen providers ko round-robin rotate karte hain: Gemini + Groq + OpenRouter.
 * Har provider ka apna independent rate-limit clock hai, isliye combined
 * throughput teeno ke rate limits ka SUM hota hai (jitne providers utna fast).
 *
 * Jitni API keys .env me daaloge utna hi fast/parallel scraping hoga.
 * Sirf ek key daali to sirf wahi use hogi (bas thoda slow rahega).
 */

// ---------------------------------------------------------------------------
// Prompt
//
// IMPORTANT: ek article me EK SE ZYADA companies profile ho sakti hain
// (jaise "5 entrepreneurs jo apna business chala rahe hain" type roundup
// article), aur har company ke apne alag owner(s) hote hain. Isliye ab hum
// ek FLAT ownerNames list nahi maangte - balki ek "companies" ARRAY maangte
// hain, jisme har company ka apna businessName + apne hi ownerNames + apni
// city hoti hai. Isse "sabhi founders ko pehli/main company se jod dena"
// wala bug fix ho jaata hai.
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

STRICT RULES (very important):
1. Do NOT guess, infer, or use outside/general knowledge. If a field is not directly stated in the article text, leave it as null (or empty array for ownerNames).
2. Do NOT assume a company's headquarters city from general knowledge - only use a city if the article text itself mentions it in connection with that company.
3. If a sentence implies the relationship (e.g. "Ritesh Agarwal started OYO in Gurugram"), that counts as explicit mention - extract it.
4. Each company gets its OWN entry in the array, with its OWN owners - never merge people or companies together.
5. Return ONLY valid JSON, no markdown, no explanation, no extra text.

ARTICLE TITLE: ${article.title || "N/A"}

ARTICLE TEXT:
"""
${article.textContent}
"""

Return strictly in this JSON shape (companies is an array - one item per distinct company found, empty array if none qualify):
{"companies": [{"businessName": string or null, "ownerNames": string[], "city": string or null}]}`;
}

function safeParseJson(rawText) {
  if (!rawText) return null;
  // Kabhi kabhi model ```json fences ke saath deta hai, strip kar do
  const cleaned = rawText.replace(/```json|```/g, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    // Last resort: pehla {...} block nikaalne ki koshish
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

// Google/OpenAI style error message se "retry in 47.2s" jaisa hint nikaalo, agar ho
function extractRetryDelayMs(message) {
  const match = /retry in ([\d.]+)s/i.exec(message || "");
  if (match) return Math.ceil(parseFloat(match[1]) * 1000) + 1000; // +1s buffer
  return null;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Per-provider rate limiter (ek MIN_INTERVAL_MS ke andar calls globally spaced
// rehte hain - jaisa pehle sirf Gemini ke liye tha, ab har provider ka apna hai)
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
    queue = runNext.catch(() => {}); // ek slot fail ho to bhi queue chalti rahe
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
        },
        required: ["businessName", "ownerNames", "city"],
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
// Provider 2 & 3: Groq / OpenRouter - dono OpenAI-compatible chat completions
// endpoint use karte hain, isliye ek hi generic caller kaafi hai.
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
// Active providers list - jo bhi .env me API key mili wahi providers active
// honge. Isliye 1, 2, ya 3 - jitni keys utne providers rotate honge.
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

  return providers;
}

const providers = buildProviders();
let rrIndex = 0;

// Har call pe rotation ka agla provider pehle try hota hai, baaki fallback ke
// liye order me rehte hain (agar ek provider fail/rate-limited ho jaye).
function providerOrderForThisCall() {
  const n = providers.length;
  const order = [];
  for (let i = 0; i < n; i++) order.push(providers[(rrIndex + i) % n]);
  rrIndex = (rrIndex + 1) % n;
  return order;
}

/**
 * Article object leta hai (contentExtractor.js se) aur ek ARRAY return karta
 * hai - har item ek alag COMPANY hai apne khud ke { ownerNames, businessName,
 * city } ke saath. Ek article me multiple unrelated companies ho sakti hain
 * (roundup articles), isliye ye ab kabhi flat single-object return nahi
 * karta - hamesha companies[] hi milega (empty array agar article qualify
 * nahi karta ya kuch nahi mila).
 *
 * Rotation + fallback: har request agle provider ko round-robin se milti hai.
 * Agar wo provider fail/rate-limited ho jaye, isi request ke liye agla
 * provider try hota hai (bina user ko error dikhaye), taaki throughput
 * consistent rahe.
 */
async function extractEntities(article) {
  if (providers.length === 0) {
    throw new Error(
      "Koi bhi AI provider configure nahi hai. .env file me GEMINI_API_KEY, GROQ_API_KEY, ya OPENROUTER_API_KEY me se kam se kam ek daalo."
    );
  }

  const order = providerOrderForThisCall();
  let lastErr = null;

  for (const provider of order) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      await provider.scheduleSlot(); // apni turn ka wait karo (is provider ka rate limit respect karte hue)

      try {
        const parsed = await provider.call(article);

        // Naya format: { companies: [{businessName, ownerNames, city}, ...] }
        let rawCompanies;
        if (Array.isArray(parsed?.companies)) {
          rawCompanies = parsed.companies;
        } else if (parsed?.businessName || (Array.isArray(parsed?.ownerNames) && parsed.ownerNames.length)) {
          // Backward-compat: agar kabhi model purana flat format de de, usse ek company maan lo
          rawCompanies = [parsed];
        } else {
          rawCompanies = [];
        }

        const companies = rawCompanies
          .map((c) => ({
            businessName: c?.businessName || null,
            ownerNames: Array.isArray(c?.ownerNames)
              ? c.ownerNames.map((n) => (typeof n === "string" ? n.trim() : n)).filter(Boolean)
              : c?.ownerName
              ? [c.ownerName]
              : [],
            city: c?.city || null,
          }))
          // Khaali/junk entries hata do (jaha na owner mila na business name)
          .filter((c) => c.businessName || c.ownerNames.length > 0);

        return companies;
      } catch (err) {
        const status = err.response?.status;
        const apiMessage = err.response?.data?.error?.message || err.message;
        lastErr = new Error(`[${provider.name}] ${apiMessage}`);

        // 429 = rate limit exceeded -> isi provider pe ek retry (agar bataya gaya wait time mile)
        if (status === 429 && attempt < 2) {
          const delay = extractRetryDelayMs(apiMessage) || 5000;
          await sleep(delay);
          continue;
        }
        break; // is provider se kaam nahi bana -> order me agle provider pe jao
      }
    }
  }

  throw lastErr || new Error("Sabhi configured providers fail ho gaye");
}

module.exports = { extractEntities, activeProviderNames: providers.map((p) => p.name) };

import { kv } from "@vercel/kv";
import crypto from "crypto";

const SEARCH_ENABLED = process.env.SEARCH_ENABLED !== "false";
const DEBUG_LOGS = process.env.DEBUG_LOGS === "true";

const PROVIDER_RACE_GRACE_MS = 1200;
const PROVIDER_SECONDARY_DELAY_MS = 350;

const PROVIDER_FAILURE_THRESHOLD = 3;
const PROVIDER_COOLDOWN_MS = 5 * 60 * 1000;

const PROVIDER_STATE_TTL_SECONDS = 24 * 60 * 60;
const PROVIDER_STATS_TTL_SECONDS = 7 * 24 * 60 * 60;
const PROVIDER_LATENCY_ALPHA = 0.35;

const EXACT_CACHE_TTL_SECONDS = 3600;
const SEMANTIC_CACHE_TTL_SECONDS = 3600;

const MAX_PROVIDERS_PER_QUERY = 3;

const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const ANTHROPIC_MODEL =
  process.env.ANTHROPIC_MODEL || "claude-3-5-sonnet-latest";
const PERPLEXITY_MODEL = process.env.PERPLEXITY_MODEL || "sonar-pro";
const XAI_MODEL = process.env.XAI_MODEL || "grok-3-latest";
const MISTRAL_MODEL = process.env.MISTRAL_MODEL || "mistral-medium-latest";
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || "deepseek-chat";

const ALLOWED_ORIGINS = [
  "https://chironnexus.com",
  "https://www.chironnexus.com",
  "https://chironsearch.vercel.app",
  "http://localhost:3000"
];

const PROVIDERS = [
  {
    name: "openai",
    label: "OpenAI Web Search",
    envKey: "OPENAI_API_KEY"
  },
  {
    name: "gemini",
    label: "Gemini",
    envKey: "GEMINI_API_KEY"
  },
  {
    name: "claude",
    label: "Claude",
    envKey: "ANTHROPIC_API_KEY"
  },
  {
    name: "perplexity",
    label: "Perplexity",
    envKey: "PERPLEXITY_API_KEY"
  },
  {
    name: "grok",
    label: "Grok",
    envKey: "XAI_API_KEY"
  },
  {
    name: "mistral",
    label: "Mistral",
    envKey: "MISTRAL_API_KEY"
  },
  {
    name: "deepseek",
    label: "DeepSeek",
    envKey: "DEEPSEEK_API_KEY"
  }
];

function debugLog(...args) {
  if (DEBUG_LOGS) {
    console.error(...args);
  }
}

function normalizeQuery(q = "") {
  return q.toLowerCase().trim().replace(/\s+/g, " ");
}

function getHeader(req, name) {
  const value = req.headers?.[name.toLowerCase()];
  if (Array.isArray(value)) {
    return value[0] || "";
  }
  return value || "";
}

function getClientIp(req) {
  const forwarded = getHeader(req, "x-forwarded-for");
  if (typeof forwarded === "string" && forwarded.length > 0) {
    return forwarded.split(",")[0].trim();
  }
  return req.socket?.remoteAddress || "unknown";
}

function tokenize(text = "") {
  return text.toLowerCase().split(/\W+/).filter(Boolean);
}

function calculateSimilarity(a = "", b = "") {
  const wordsA = new Set(tokenize(a));
  const wordsB = new Set(tokenize(b));

  if (wordsA.size === 0 || wordsB.size === 0) {
    return 0;
  }

  let overlap = 0;

  wordsA.forEach((word) => {
    if (wordsB.has(word)) {
      overlap++;
    }
  });

  return overlap / Math.max(wordsA.size, wordsB.size);
}

function getConfidenceFromAnswers(answers = []) {
  const validAnswers = answers.filter(Boolean);

  if (validAnswers.length <= 1) {
    return "low";
  }

  const similarities = [];

  for (let i = 0; i < validAnswers.length; i++) {
    for (let j = i + 1; j < validAnswers.length; j++) {
      similarities.push(calculateSimilarity(validAnswers[i], validAnswers[j]));
    }
  }

  if (similarities.length === 0) {
    return "low";
  }

  const avgSimilarity =
    similarities.reduce((sum, value) => sum + value, 0) / similarities.length;

  if (avgSimilarity >= 0.72 && validAnswers.length >= 3) {
    return "high";
  }

  if (avgSimilarity >= 0.5) {
    return "medium";
  }

  return "low";
}

function shouldSkipSynthesis(answers = []) {
  const validAnswers = answers.filter(Boolean);

  if (validAnswers.length < 2) {
    return false;
  }

  const similarities = [];

  for (let i = 0; i < validAnswers.length; i++) {
    for (let j = i + 1; j < validAnswers.length; j++) {
      similarities.push(calculateSimilarity(validAnswers[i], validAnswers[j]));
    }
  }

  if (similarities.length === 0) {
    return false;
  }

  const avgSimilarity =
    similarities.reduce((sum, value) => sum + value, 0) / similarities.length;

  return avgSimilarity >= 0.82;
}

function pickBestDirectAnswer(candidates = []) {
  const valid = candidates.filter((item) => item?.answer);

  if (valid.length === 0) {
    return { provider: null, answer: null };
  }

  const sorted = [...valid].sort((a, b) => {
    const aScore = typeof a.score === "number" ? a.score : -999;
    const bScore = typeof b.score === "number" ? b.score : -999;
    return bScore - aScore;
  });

  return {
    provider: sorted[0].provider,
    answer: sorted[0].answer
  };
}

function fingerprintQuery(q = "") {
  const stopWords = new Set([
    "a",
    "an",
    "and",
    "are",
    "at",
    "be",
    "by",
    "for",
    "from",
    "give",
    "how",
    "i",
    "in",
    "is",
    "it",
    "me",
    "my",
    "of",
    "on",
    "or",
    "tell",
    "the",
    "to",
    "what",
    "when",
    "where",
    "which",
    "who",
    "why",
    "about",
    "summary",
    "summarize",
    "summaryof",
    "explain",
    "explainer",
    "overview",
    "intro",
    "introduction",
    "describe",
    "definition"
  ]);

  return q
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .filter((word) => !stopWords.has(word))
    .sort()
    .join(" ");
}

function isSemanticCacheSafe(query = "") {
  const q = query.toLowerCase();

  const unsafePatterns = [
    "latest",
    "today",
    "current",
    "currently",
    "now",
    "news",
    "recent",
    "tonight",
    "tomorrow",
    "yesterday",
    "this week",
    "this month",
    "this year",
    "near me",
    "my",
    "for me",
    "should i",
    "best",
    "compare",
    "vs",
    "versus"
  ];

  if (unsafePatterns.some((pattern) => q.includes(pattern))) {
    return false;
  }

  if (/\b(20\d{2}|19\d{2})\b/.test(q)) {
    return false;
  }

  const tokenCount = tokenize(q).length;
  if (tokenCount < 2 || tokenCount > 12) {
    return false;
  }

  return true;
}

function buildRequestFingerprint(req) {
  const ip = getClientIp(req);
  const userAgent = getHeader(req, "user-agent").slice(0, 300);
  const origin = getHeader(req, "origin").slice(0, 200);

  return crypto
    .createHash("sha256")
    .update(`${ip}|${userAgent}|${origin}`)
    .digest("hex")
    .slice(0, 24);
}

function isAllowedOrigin(origin) {
  if (!origin) {
    return true;
  }
  return ALLOWED_ORIGINS.includes(origin);
}

function getProviderStateKey(providerName) {
  return `provider:state:v1:${providerName}`;
}

function getProviderStatsKey(providerName) {
  return `provider:stats:v1:${providerName}`;
}

async function getProviderState(providerName) {
  return (
    (await kv.get(getProviderStateKey(providerName))) || {
      failures: 0,
      cooldown_until: 0,
      last_error: "",
      last_error_at: 0,
      last_success_at: 0
    }
  );
}

async function getProviderStats(providerName) {
  return (
    (await kv.get(getProviderStatsKey(providerName))) || {
      success_count: 0,
      failure_count: 0,
      avg_latency_ms: null,
      last_latency_ms: null,
      fastest_ms: null,
      slowest_ms: null,
      last_success_at: 0,
      last_failure_at: 0
    }
  );
}

function isProviderCoolingDown(state) {
  return Number(state?.cooldown_until || 0) > Date.now();
}

async function recordProviderSuccess(providerName, latencyMs) {
  const [state, stats] = await Promise.all([
    getProviderState(providerName),
    getProviderStats(providerName)
  ]);

  const nextState = {
    failures: 0,
    cooldown_until: 0,
    last_error: "",
    last_error_at: Number(state.last_error_at || 0),
    last_success_at: Date.now()
  };

  const previousAvg =
    typeof stats.avg_latency_ms === "number" ? stats.avg_latency_ms : latencyMs;

  const nextAvg =
    previousAvg + (latencyMs - previousAvg) * PROVIDER_LATENCY_ALPHA;

  const nextStats = {
    success_count: Number(stats.success_count || 0) + 1,
    failure_count: Number(stats.failure_count || 0),
    avg_latency_ms: Math.round(nextAvg),
    last_latency_ms: latencyMs,
    fastest_ms:
      stats.fastest_ms == null
        ? latencyMs
        : Math.min(Number(stats.fastest_ms), latencyMs),
    slowest_ms:
      stats.slowest_ms == null
        ? latencyMs
        : Math.max(Number(stats.slowest_ms), latencyMs),
    last_success_at: Date.now(),
    last_failure_at: Number(stats.last_failure_at || 0)
  };

  await Promise.all([
    kv.set(getProviderStateKey(providerName), nextState, {
      ex: PROVIDER_STATE_TTL_SECONDS
    }),
    kv.set(getProviderStatsKey(providerName), nextStats, {
      ex: PROVIDER_STATS_TTL_SECONDS
    })
  ]);
}

async function recordProviderFailure(providerName, latencyMs, errorMessage = "") {
  const [state, stats] = await Promise.all([
    getProviderState(providerName),
    getProviderStats(providerName)
  ]);

  const nextFailures = Number(state.failures || 0) + 1;
  const cooldownUntil =
    nextFailures >= PROVIDER_FAILURE_THRESHOLD
      ? Date.now() + PROVIDER_COOLDOWN_MS
      : 0;

  const nextState = {
    failures: nextFailures,
    cooldown_until: cooldownUntil,
    last_error: String(errorMessage || "Unknown provider failure").slice(0, 500),
    last_error_at: Date.now(),
    last_success_at: Number(state.last_success_at || 0)
  };

  const nextStats = {
    success_count: Number(stats.success_count || 0),
    failure_count: Number(stats.failure_count || 0) + 1,
    avg_latency_ms:
      typeof stats.avg_latency_ms === "number" ? stats.avg_latency_ms : null,
    last_latency_ms: latencyMs,
    fastest_ms:
      stats.fastest_ms == null
        ? latencyMs
        : Math.min(Number(stats.fastest_ms), latencyMs),
    slowest_ms:
      stats.slowest_ms == null
        ? latencyMs
        : Math.max(Number(stats.slowest_ms), latencyMs),
    last_success_at: Number(stats.last_success_at || 0),
    last_failure_at: Date.now()
  };

  await Promise.all([
    kv.set(getProviderStateKey(providerName), nextState, {
      ex: PROVIDER_STATE_TTL_SECONDS
    }),
    kv.set(getProviderStatsKey(providerName), nextStats, {
      ex: PROVIDER_STATS_TTL_SECONDS
    })
  ]);
}

function chooseProviderDelays(providerConfigs) {
  const available = providerConfigs.filter((p) => p.available);

  if (available.length <= 1) {
    return Object.fromEntries(providerConfigs.map((p) => [p.name, 0]));
  }

  const ranked = [...available].sort((a, b) => {
    const aLatency =
      typeof a.stats?.avg_latency_ms === "number"
        ? a.stats.avg_latency_ms
        : Number.MAX_SAFE_INTEGER;
    const bLatency =
      typeof b.stats?.avg_latency_ms === "number"
        ? b.stats.avg_latency_ms
        : Number.MAX_SAFE_INTEGER;

    return aLatency - bLatency;
  });

  const delays = {};

  ranked.forEach((provider, index) => {
    delays[provider.name] = index === 0 ? 0 : PROVIDER_SECONDARY_DELAY_MS;
  });

  providerConfigs.forEach((provider) => {
    if (!(provider.name in delays)) {
      delays[provider.name] = 0;
    }
  });

  return delays;
}

function chooseProvidersForQuery(queryType, providers) {
  const priorityByType = {
    fresh: ["perplexity", "grok", "openai", "gemini"],
    comparison: ["claude", "openai", "gemini", "deepseek"],
    visual: ["perplexity", "openai", "gemini"],
    historical: ["openai", "claude", "perplexity"],
    explanation: ["claude", "openai", "deepseek", "gemini"],
    factual: ["openai", "gemini", "perplexity", "deepseek"],
    general: ["openai", "gemini", "claude", "perplexity"]
  };

  const preferredOrder = priorityByType[queryType] || priorityByType.general;
  const byName = new Map(providers.map((provider) => [provider.name, provider]));
  const selected = [];

  for (const name of preferredOrder) {
    const provider = byName.get(name);
    if (provider && provider.enabled) {
      selected.push(provider);
    }
    if (selected.length >= MAX_PROVIDERS_PER_QUERY) {
      break;
    }
  }

  if (selected.length < Math.min(MAX_PROVIDERS_PER_QUERY, providers.length)) {
    for (const provider of providers) {
      if (!provider.enabled) continue;
      if (!selected.find((item) => item.name === provider.name)) {
        selected.push(provider);
      }
      if (selected.length >= MAX_PROVIDERS_PER_QUERY) {
        break;
      }
    }
  }

  return selected;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithAbort(url, options, ms, label = "Request") {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ms);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });
    return response;
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error(`${label} aborted after ${ms}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function dedupeSourceLinks(links = []) {
  const seen = new Set();
  const deduped = [];

  for (const link of links) {
    const key = `${link?.url || ""}|${link?.title || ""}`;
    if (!link?.url || seen.has(key)) continue;
    seen.add(key);
    deduped.push(link);
  }

  return deduped.slice(0, 10);
}

function extractOutputTextParts(data) {
  const output = Array.isArray(data?.output) ? data.output : [];
  const parts = [];

  for (const item of output) {
    if (item?.type !== "message") continue;
    const content = Array.isArray(item.content) ? item.content : [];
    for (const part of content) {
      if (part?.type === "output_text") {
        parts.push(part);
      }
    }
  }

  return parts;
}

function extractOpenAISourceLinks(data) {
  const parts = extractOutputTextParts(data);
  const links = [];

  for (const part of parts) {
    const annotations = Array.isArray(part.annotations) ? part.annotations : [];

    for (const annotation of annotations) {
      if (annotation?.type !== "url_citation") continue;

      const url = annotation.url || annotation.uri || "";
      const title =
        annotation.title || annotation.text || annotation.display_text || url;

      if (!url) continue;

      links.push({
        title: String(title).slice(0, 300),
        url: String(url).slice(0, 1000),
        provider: "OpenAI Web Search"
      });
    }
  }

  return dedupeSourceLinks(links);
}

function extractPerplexitySourceLinks(data) {
  const searchResults = Array.isArray(data?.search_results)
    ? data.search_results
    : [];

  return dedupeSourceLinks(
    searchResults.map((item) => ({
      title: String(item?.title || item?.url || "Perplexity result").slice(0, 300),
      url: String(item?.url || "").slice(0, 1000),
      provider: "Perplexity"
    }))
  );
}

function extractPerplexityReferenceImage(data) {
  const images = Array.isArray(data?.images) ? data.images : [];
  const first = images[0];

  if (!first?.image_url) {
    return null;
  }

  return {
    url: first.image_url,
    title: first.title || "Perplexity image",
    caption: first.title || "Reference image",
    source_url: first.origin_url || "",
    provider: "Perplexity"
  };
}

function extractChatMessageContent(data) {
  const content = data?.choices?.[0]?.message?.content;

  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") return item;
        if (item?.type === "text") return item.text || "";
        return "";
      })
      .join("")
      .trim();
  }

  return null;
}

function isVisualQuery(query = "") {
  const q = query.toLowerCase();

  return (
    [
      "what does ",
      "what does a ",
      "what does an ",
      "what does the ",
      "look like",
      "show me ",
      "image of ",
      "picture of ",
      "photo of ",
      "what is a ",
      "what is an "
    ].some((pattern) => q.includes(pattern)) &&
    (q.includes("look like") ||
      q.startsWith("show me ") ||
      q.startsWith("image of ") ||
      q.startsWith("picture of ") ||
      q.startsWith("photo of "))
  );
}

function extractVisualSubject(query = "") {
  let q = query.trim().toLowerCase();

  q = q
    .replace(/^what does\s+/, "")
    .replace(/^show me\s+/, "")
    .replace(/^image of\s+/, "")
    .replace(/^picture of\s+/, "")
    .replace(/^photo of\s+/, "")
    .replace(/^what is\s+/, "")
    .replace(/\s+look like\??$/, "")
    .replace(/[?!.]+$/g, "")
    .trim();

  q = q.replace(/^(a|an|the)\s+/, "").trim();

  return q.slice(0, 120);
}

async function fetchWikipediaReferenceImage(subject) {
  if (!subject) return null;

  const title = subject
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join("_");

  const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`;

  try {
    const response = await fetchWithAbort(
      url,
      {
        method: "GET",
        headers: {
          Accept: "application/json"
        }
      },
      3500,
      "Wikipedia image lookup"
    );

    if (!response.ok) {
      return null;
    }

    const data = await response.json();
    const imageUrl = data?.thumbnail?.source || data?.originalimage?.source || null;

    if (!imageUrl) {
      return null;
    }

    return {
      url: imageUrl,
      title: data?.title || subject,
      caption: data?.description || `Reference image for ${subject}`,
      source_url:
        data?.content_urls?.desktop?.page ||
        data?.content_urls?.mobile?.page ||
        "",
      provider: "Wikipedia"
    };
  } catch (error) {
    debugLog("Wikipedia image lookup failed:", error?.message || error);
    return null;
  }
}

function countUncertaintySignals(text = "") {
  const patterns = [
    "may",
    "might",
    "could",
    "possibly",
    "likely",
    "appears",
    "seems",
    "unclear",
    "uncertain",
    "not clear",
    "not confirmed",
    "probably"
  ];

  const lower = text.toLowerCase();
  let count = 0;

  for (const pattern of patterns) {
    if (lower.includes(pattern)) {
      count++;
    }
  }

  return count;
}

function computeQueryTermOverlap(query = "", answer = "") {
  const queryTerms = new Set(
    fingerprintQuery(query)
      .split(/\s+/)
      .filter(Boolean)
  );

  if (queryTerms.size === 0) {
    return 0;
  }

  const answerTerms = new Set(tokenize(answer));
  let overlap = 0;

  queryTerms.forEach((term) => {
    if (answerTerms.has(term)) {
      overlap++;
    }
  });

  return overlap / queryTerms.size;
}

function classifyQuery(query = "") {
  const q = query.toLowerCase();

  const freshPatterns = [
    "latest",
    "today",
    "current",
    "currently",
    "now",
    "news",
    "recent",
    "tonight",
    "tomorrow",
    "yesterday",
    "this week",
    "this month",
    "this year"
  ];

  if (freshPatterns.some((pattern) => q.includes(pattern))) {
    return "fresh";
  }

  if (
    q.includes("compare") ||
    q.includes(" vs ") ||
    q.includes(" versus ") ||
    q.startsWith("difference between")
  ) {
    return "comparison";
  }

  if (isVisualQuery(q)) {
    return "visual";
  }

  if (
    q.includes("historically") ||
    q.includes("history of ") ||
    q.includes("how did people") ||
    q.includes("used to think") ||
    q.includes("old encyclopedia") ||
    q.includes("in 18") ||
    q.includes("in 19") ||
    q.includes("in 20")
  ) {
    return "historical";
  }

  if (
    q.startsWith("why ") ||
    q.startsWith("how ") ||
    q.includes("explain") ||
    q.includes("overview") ||
    q.includes("summary")
  ) {
    return "explanation";
  }

  if (
    q.startsWith("what is ") ||
    q.startsWith("who is ") ||
    q.startsWith("when did ") ||
    q.startsWith("where is ") ||
    q.startsWith("capital of ")
  ) {
    return "factual";
  }

  return "general";
}

function scoreAnswer({ answer, sourceLinks = [], query, queryType }) {
  if (!answer) {
    return -999;
  }

  const length = answer.length;
  const overlap = computeQueryTermOverlap(query, answer);
  const uncertaintySignals = countUncertaintySignals(answer);
  const hasSources = sourceLinks.length > 0;

  let score = 0;

  score += overlap * 40;

  if (hasSources) {
    score += Math.min(sourceLinks.length, 4) * 8;
  }

  if (length >= 120 && length <= 1400) {
    score += 14;
  } else if (length >= 60 && length <= 1800) {
    score += 8;
  } else {
    score -= 6;
  }

  if (uncertaintySignals >= 4) {
    score -= 10;
  } else if (uncertaintySignals >= 2) {
    score -= 4;
  }

  if (answer.includes("\n\n")) {
    score += 3;
  }

  if ((queryType === "fresh" || queryType === "historical") && !hasSources) {
    score -= 10;
  }

  if (queryType === "comparison" && length < 180) {
    score -= 6;
  }

  return Math.round(score);
}

function normalizeHistoricalSubject(query = "") {
  return query
    .replace(/\b(historically|history of|old encyclopedia|used to think|how did people)\b/gi, " ")
    .replace(/\b(in\s+(18|19|20)\d{2})\b/gi, " ")
    .replace(/[?!.]+$/g, "")
    .trim()
    .slice(0, 140);
}

async function fetchOpenLibraryHistoricalReferences(subject) {
  if (!subject) return [];

  const url = `https://openlibrary.org/search.json?q=${encodeURIComponent(subject)}&limit=5`;

  try {
    const response = await fetchWithAbort(
      url,
      {
        method: "GET",
        headers: {
          Accept: "application/json"
        }
      },
      4000,
      "Open Library search"
    );

    if (!response.ok) {
      return [];
    }

    const data = await response.json();
    const docs = Array.isArray(data?.docs) ? data.docs : [];

    return docs.slice(0, 3).map((doc) => ({
      source: "Open Library",
      title: doc.title || "Untitled",
      year: doc.first_publish_year || null,
      author:
        Array.isArray(doc.author_name) && doc.author_name.length > 0
          ? doc.author_name.slice(0, 2).join(", ")
          : null,
      url: doc.key ? `https://openlibrary.org${doc.key}` : "",
      summary:
        typeof doc.first_sentence === "string"
          ? doc.first_sentence
          : Array.isArray(doc.first_sentence)
            ? doc.first_sentence[0] || null
            : null
    }));
  } catch (error) {
    debugLog("Open Library historical lookup failed:", error?.message || error);
    return [];
  }
}

async function fetchInternetArchiveHistoricalReferences(subject) {
  if (!subject) return [];

  const query = `title:(${subject}) OR subject:(${subject})`;
  const url =
    `https://archive.org/advancedsearch.php?q=${encodeURIComponent(query)}` +
    `&fl[]=identifier&fl[]=title&fl[]=creator&fl[]=year&rows=5&page=1&output=json`;

  try {
    const response = await fetchWithAbort(
      url,
      {
        method: "GET",
        headers: {
          Accept: "application/json"
        }
      },
      4500,
      "Internet Archive search"
    );

    if (!response.ok) {
      return [];
    }

    const data = await response.json();
    const docs = Array.isArray(data?.response?.docs) ? data.response.docs : [];

    return docs.slice(0, 3).map((doc) => ({
      source: "Internet Archive",
      title: doc.title || "Untitled",
      year: doc.year || null,
      author: doc.creator || null,
      url: doc.identifier
        ? `https://archive.org/details/${encodeURIComponent(doc.identifier)}`
        : "",
      summary: null
    }));
  } catch (error) {
    debugLog("Internet Archive historical lookup failed:", error?.message || error);
    return [];
  }
}

async function fetchHistoricalReferences(query, queryType) {
  if (queryType !== "historical") {
    return [];
  }

  const subject = normalizeHistoricalSubject(query);

  const [openLibrary, internetArchive] = await Promise.all([
    fetchOpenLibraryHistoricalReferences(subject),
    fetchInternetArchiveHistoricalReferences(subject)
  ]);

  return [...openLibrary, ...internetArchive].slice(0, 5);
}

async function callOpenAI(query) {
  try {
    const response = await fetchWithAbort(
      "https://api.openai.com/v1/responses",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
        },
        body: JSON.stringify({
          model: OPENAI_MODEL,
          tools: [{ type: "web_search" }],
          input: query
        })
      },
      8000,
      "OpenAI"
    );

    const data = await response.json();
    debugLog("OpenAI raw response:", JSON.stringify(data, null, 2));

    if (!response.ok) {
      return null;
    }

    const messageItem = (data.output || []).find((item) => item.type === "message");

    const answer =
      data.output_text ||
      messageItem?.content?.find((part) => part.type === "output_text")?.text ||
      messageItem?.content?.[0]?.text ||
      null;

    return {
      answer,
      source_links: extractOpenAISourceLinks(data),
      reference_image: null
    };
  } catch (error) {
    console.error("OpenAI request error:", error);
    return null;
  }
}

async function callGemini(query) {
  try {
    const response = await fetchWithAbort(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
        GEMINI_MODEL
      )}:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          contents: [
            {
              parts: [{ text: query }]
            }
          ]
        })
      },
      8000,
      "Gemini"
    );

    const data = await response.json();
    debugLog("Gemini raw response:", JSON.stringify(data, null, 2));

    if (!response.ok) {
      return null;
    }

    return {
      answer: data.candidates?.[0]?.content?.parts?.[0]?.text || null,
      source_links: [],
      reference_image: null
    };
  } catch (error) {
    console.error("Gemini request error:", error);
    return null;
  }
}

async function callClaude(query) {
  try {
    const response = await fetchWithAbort(
      "https://api.anthropic.com/v1/messages",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": process.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01"
        },
        body: JSON.stringify({
          model: ANTHROPIC_MODEL,
          max_tokens: 900,
          messages: [
            {
              role: "user",
              content: query
            }
          ]
        })
      },
      8000,
      "Claude"
    );

    const data = await response.json();
    debugLog("Claude raw response:", JSON.stringify(data, null, 2));

    if (!response.ok) {
      return null;
    }

    const answer = data?.content?.find((part) => part.type === "text")?.text || null;

    return {
      answer,
      source_links: [],
      reference_image: null
    };
  } catch (error) {
    console.error("Claude request error:", error);
    return null;
  }
}

async function callPerplexity(query) {
  try {
    const response = await fetchWithAbort(
      "https://api.perplexity.ai/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.PERPLEXITY_API_KEY}`
        },
        body: JSON.stringify({
          model: PERPLEXITY_MODEL,
          messages: [
            {
              role: "system",
              content:
                "Answer clearly and concisely. Use current web-grounded information when relevant."
            },
            {
              role: "user",
              content: query
            }
          ]
        })
      },
      9000,
      "Perplexity"
    );

    const data = await response.json();
    debugLog("Perplexity raw response:", JSON.stringify(data, null, 2));

    if (!response.ok) {
      return null;
    }

    return {
      answer: extractChatMessageContent(data),
      source_links: extractPerplexitySourceLinks(data),
      reference_image: extractPerplexityReferenceImage(data)
    };
  } catch (error) {
    console.error("Perplexity request error:", error);
    return null;
  }
}

async function callGrok(query) {
  try {
    const response = await fetchWithAbort(
      "https://api.x.ai/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.XAI_API_KEY}`
        },
        body: JSON.stringify({
          model: XAI_MODEL,
          messages: [
            {
              role: "system",
              content: "Answer clearly and concisely."
            },
            {
              role: "user",
              content: query
            }
          ]
        })
      },
      9000,
      "Grok"
    );

    const data = await response.json();
    debugLog("Grok raw response:", JSON.stringify(data, null, 2));

    if (!response.ok) {
      return null;
    }

    return {
      answer: extractChatMessageContent(data),
      source_links: [],
      reference_image: null
    };
  } catch (error) {
    console.error("Grok request error:", error);
    return null;
  }
}

async function callMistral(query) {
  try {
    const response = await fetchWithAbort(
      "https://api.mistral.ai/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.MISTRAL_API_KEY}`
        },
        body: JSON.stringify({
          model: MISTRAL_MODEL,
          messages: [
            {
              role: "system",
              content: "Answer clearly and concisely."
            },
            {
              role: "user",
              content: query
            }
          ],
          max_tokens: 900
        })
      },
      9000,
      "Mistral"
    );

    const data = await response.json();
    debugLog("Mistral raw response:", JSON.stringify(data, null, 2));

    if (!response.ok) {
      return null;
    }

    return {
      answer: extractChatMessageContent(data),
      source_links: [],
      reference_image: null
    };
  } catch (error) {
    console.error("Mistral request error:", error);
    return null;
  }
}

async function callDeepSeek(query) {
  try {
    const response = await fetchWithAbort(
      "https://api.deepseek.com/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`
        },
        body: JSON.stringify({
          model: DEEPSEEK_MODEL,
          messages: [
            {
              role: "system",
              content: "Answer clearly and concisely."
            },
            {
              role: "user",
              content: query
            }
          ],
          max_tokens: 900
        })
      },
      9000,
      "DeepSeek"
    );

    const data = await response.json();
    debugLog("DeepSeek raw response:", JSON.stringify(data, null, 2));

    if (!response.ok) {
      return null;
    }

    return {
      answer: extractChatMessageContent(data),
      source_links: [],
      reference_image: null
    };
  } catch (error) {
    console.error("DeepSeek request error:", error);
    return null;
  }
}

const PROVIDER_CALLS = {
  openai: callOpenAI,
  gemini: callGemini,
  claude: callClaude,
  perplexity: callPerplexity,
  grok: callGrok,
  mistral: callMistral,
  deepseek: callDeepSeek
};

async function cleanupSingleProviderAnswer(userQuery, providerName, rawAnswer) {
  const cleanupPrompt = `
You are Chiron Nexus, an AI broker and answer-normalization engine.

The user asked:
"${userQuery}"

A single provider returned this draft answer:
${rawAnswer}

Provider name:
${providerName}

Your task:
- Rewrite the answer into a clean final response for the user.
- Preserve the substance of the answer.
- Remove markdown headings like # or ##.
- Remove unnecessary provider-style formatting.
- Remove obvious link clutter unless a link is genuinely necessary to understand the answer.
- Keep the answer concise, natural, and readable.
- Do not mention the provider in the main answer.
- Do not mention that this answer was rewritten or cleaned up.
- Do not invent facts that are not already supported by the draft answer.
- If the draft answer is weak or uncertain, keep the uncertainty but present it clearly.
`;

  try {
    const response = await fetchWithAbort(
      "https://api.openai.com/v1/responses",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
        },
        body: JSON.stringify({
          model: OPENAI_MODEL,
          input: cleanupPrompt
        })
      },
      6000,
      "Single-provider cleanup"
    );

    const data = await response.json();
    debugLog("Cleanup raw response:", JSON.stringify(data, null, 2));

    if (!response.ok) {
      return null;
    }

    const messageItem = (data.output || []).find((item) => item.type === "message");

    return (
      data.output_text ||
      messageItem?.content?.find((part) => part.type === "output_text")?.text ||
      messageItem?.content?.[0]?.text ||
      null
    );
  } catch (error) {
    console.error("Cleanup request error:", error);
    return null;
  }
}

function tryParseJson(text = "") {
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;

    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

async function critiqueProviderAnswers(userQuery, providerAnswers, queryType) {
  const packet = {
    query: userQuery,
    query_type: queryType,
    providers: providerAnswers.map((item) => ({
      provider: item.provider,
      label: item.label,
      score: item.score,
      sources: item.source_links?.length || 0,
      answer: item.answer
    }))
  };

  const critiquePrompt = `
You are the arbitration engine for Chiron Nexus.

Analyze the candidate AI answers below and return JSON only.

Return this exact shape:
{
  "consensus_level": "high" | "medium" | "low",
  "needs_synthesis": true | false,
  "winner": string | null,
  "outliers": string[],
  "confidence": "high" | "medium" | "low",
  "reason": string
}

Rules:
- "winner" should be the provider id when one answer is clearly strongest.
- "needs_synthesis" should be true when combining multiple answers will produce a better final result.
- Use "outliers" for materially weaker or conflicting answers.
- Keep "reason" under 220 characters.
- Return valid JSON only. No markdown.

Candidate packet:
${JSON.stringify(packet)}
`;

  try {
    const response = await fetchWithAbort(
      "https://api.openai.com/v1/responses",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
        },
        body: JSON.stringify({
          model: OPENAI_MODEL,
          input: critiquePrompt
        })
      },
      6000,
      "Critique"
    );

    const data = await response.json();
    debugLog("Critique raw response:", JSON.stringify(data, null, 2));

    if (!response.ok) {
      return null;
    }

    const messageItem = (data.output || []).find((item) => item.type === "message");
    const text =
      data.output_text ||
      messageItem?.content?.find((part) => part.type === "output_text")?.text ||
      messageItem?.content?.[0]?.text ||
      "";

    const parsed = tryParseJson(text);

    if (!parsed || typeof parsed !== "object") {
      return null;
    }

    return {
      consensus_level:
        parsed.consensus_level === "high" ||
        parsed.consensus_level === "medium" ||
        parsed.consensus_level === "low"
          ? parsed.consensus_level
          : "medium",
      needs_synthesis: Boolean(parsed.needs_synthesis),
      winner:
        typeof parsed.winner === "string" && parsed.winner.length > 0
          ? parsed.winner
          : null,
      outliers: Array.isArray(parsed.outliers)
        ? parsed.outliers.filter((item) => typeof item === "string").slice(0, 4)
        : [],
      confidence:
        parsed.confidence === "high" ||
        parsed.confidence === "medium" ||
        parsed.confidence === "low"
          ? parsed.confidence
          : "medium",
      reason:
        typeof parsed.reason === "string"
          ? parsed.reason.slice(0, 220)
          : "Arbitration completed."
    };
  } catch (error) {
    console.error("Critique request error:", error);
    return null;
  }
}

async function synthesizeWithOpenAI(userQuery, providerAnswers, critique = null) {
  const sections = providerAnswers
    .filter((item) => item?.answer)
    .map((item) => `${item.label.toUpperCase()} ANSWER:\n${item.answer}`)
    .join("\n\n");

  const critiqueSection = critique
    ? `
Arbitration summary:
- Consensus level: ${critique.consensus_level}
- Suggested winner: ${critique.winner || "none"}
- Outliers: ${(critique.outliers || []).join(", ") || "none"}
- Confidence: ${critique.confidence}
- Reason: ${critique.reason}
`
    : "";

  const synthesisPrompt = `
You are Chiron Nexus, an AI broker and synthesis engine.

The user asked:
"${userQuery}"

${critiqueSection}

Below are AI-generated answers from different providers.

${sections}

Your task:
- Produce one clear, accurate, concise final answer for the user.
- Synthesize the strongest points from the provider answers.
- Resolve disagreements cautiously.
- If one answer appears weak or uncertain, do not over-trust it.
- Do not mention internal analysis.
- Do not say provider names in the final answer.
- Do not use markdown headings.
- Keep the answer clean and natural.
- If the answers conflict, be cautious and briefly acknowledge uncertainty when needed.
`;

  try {
    const response = await fetchWithAbort(
      "https://api.openai.com/v1/responses",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
        },
        body: JSON.stringify({
          model: OPENAI_MODEL,
          input: synthesisPrompt
        })
      },
      7000,
      "Synthesis"
    );

    const data = await response.json();
    debugLog("Synthesis raw response:", JSON.stringify(data, null, 2));

    if (!response.ok) {
      return null;
    }

    const messageItem = (data.output || []).find((item) => item.type === "message");

    return (
      data.output_text ||
      messageItem?.content?.find((part) => part.type === "output_text")?.text ||
      messageItem?.content?.[0]?.text ||
      null
    );
  } catch (error) {
    console.error("Synthesis request error:", error);
    return null;
  }
}

async function callProviderWithTracking(providerName, query, providerFn, delayMs = 0) {
  if (delayMs > 0) {
    await sleep(delayMs);
  }

  const startedAt = Date.now();

  try {
    const result = await providerFn(query);
    const latencyMs = Date.now() - startedAt;

    if (result?.answer) {
      await recordProviderSuccess(providerName, latencyMs);
      return {
        name: providerName,
        answer: result.answer,
        source_links: Array.isArray(result.source_links) ? result.source_links : [],
        reference_image: result.reference_image || null,
        error: null,
        latency_ms: latencyMs,
        skipped: false
      };
    }

    await recordProviderFailure(
      providerName,
      latencyMs,
      "No usable answer returned"
    );

    return {
      name: providerName,
      answer: null,
      source_links: [],
      reference_image: null,
      error: new Error("No usable answer returned"),
      latency_ms: latencyMs,
      skipped: false
    };
  } catch (error) {
    const latencyMs = Date.now() - startedAt;

    await recordProviderFailure(
      providerName,
      latencyMs,
      error?.message || "Provider request failed"
    );

    return {
      name: providerName,
      answer: null,
      source_links: [],
      reference_image: null,
      error,
      latency_ms: latencyMs,
      skipped: false
    };
  }
}

async function waitWithTimeout(promise, ms) {
  let timeoutId;

  const timeoutPromise = new Promise((resolve) => {
    timeoutId = setTimeout(() => resolve(null), ms);
  });

  try {
    const result = await Promise.race([promise, timeoutPromise]);
    return result;
  } finally {
    clearTimeout(timeoutId);
  }
}

export default async function handler(req, res) {
  const requestStart = Date.now();

  if (!SEARCH_ENABLED) {
    return res.status(503).json({
      answer: "Search is temporarily disabled.",
      sources: []
    });
  }

  const origin = getHeader(req, "origin");
  const contentType = getHeader(req, "content-type");
  const userAgent = getHeader(req, "user-agent");
  const fingerprint = buildRequestFingerprint(req);

  if (!isAllowedOrigin(origin)) {
    return res.status(403).json({
      answer: "Forbidden.",
      sources: []
    });
  }

  if (req.method !== "POST") {
    return res.status(405).json({
      answer: "Method not allowed.",
      sources: []
    });
  }

  if (!contentType.includes("application/json")) {
    return res.status(415).json({
      answer: "Unsupported content type.",
      sources: []
    });
  }

  if (!userAgent || userAgent.length < 10) {
    return res.status(400).json({
      answer: "Invalid request.",
      sources: []
    });
  }

  const fingerprintRateKey = `ratelimit:fingerprint:${fingerprint}`;
  const fingerprintWindowSeconds = 60;
  const maxFingerprintRequestsPerWindow = 12;

  const fingerprintCount = await kv.incr(fingerprintRateKey);

  if (fingerprintCount === 1) {
    await kv.expire(fingerprintRateKey, fingerprintWindowSeconds);
  }

  if (fingerprintCount > maxFingerprintRequestsPerWindow) {
    return res.status(429).json({
      answer: "Too many requests. Please wait a minute and try again.",
      sources: []
    });
  }

  const { query } = req.body || {};
  const normalizedQuery = normalizeQuery((query || "").slice(0, 500));

  if (!normalizedQuery) {
    return res.status(400).json({
      answer: "No query provided.",
      sources: []
    });
  }

  const queryType = classifyQuery(normalizedQuery);

  const queryBurstFingerprint = crypto
    .createHash("sha256")
    .update(`${fingerprint}|${normalizedQuery}`)
    .digest("hex")
    .slice(0, 24);

  const queryBurstKey = `ratelimit:burst:${queryBurstFingerprint}`;
  const queryBurstWindowSeconds = 30;
  const maxSameQueryBurst = 3;

  const queryBurstCount = await kv.incr(queryBurstKey);

  if (queryBurstCount === 1) {
    await kv.expire(queryBurstKey, queryBurstWindowSeconds);
  }

  if (queryBurstCount > maxSameQueryBurst) {
    return res.status(429).json({
      answer: "Please wait before repeating the same search.",
      sources: []
    });
  }

  const ip = getClientIp(req);
  const rateKey = `ratelimit:${ip}`;
  const rateWindowSeconds = 60;
  const maxRequestsPerWindow = 10;

  const currentCount = await kv.incr(rateKey);

  if (currentCount === 1) {
    await kv.expire(rateKey, rateWindowSeconds);
  }

  if (currentCount > maxRequestsPerWindow) {
    return res.status(429).json({
      answer: "Too many searches. Please wait a minute and try again.",
      sources: []
    });
  }

  const cacheKey = `search:v20:${normalizedQuery}`;
  const semanticEnabled = isSemanticCacheSafe(normalizedQuery);
  const semanticFingerprint = semanticEnabled
    ? fingerprintQuery(normalizedQuery)
    : "";
  const semanticKey = semanticFingerprint
    ? `semantic:v6:${semanticFingerprint}`
    : "";

  try {
    const cached = await kv.get(cacheKey);

    if (cached) {
      return res.status(200).json({
        ...cached,
        cached: true,
        cache_type: "exact",
        response_time_ms: Date.now() - requestStart
      });
    }

    if (semanticKey) {
      const semanticCached = await kv.get(semanticKey);

      if (semanticCached) {
        await kv.set(cacheKey, semanticCached, { ex: EXACT_CACHE_TTL_SECONDS });

        return res.status(200).json({
          ...semanticCached,
          cached: true,
          cache_type: "semantic",
          response_time_ms: Date.now() - requestStart
        });
      }
    }

    const providerStateAndStats = await Promise.all(
      PROVIDERS.map(async (provider) => ({
        ...provider,
        state: await getProviderState(provider.name),
        stats: await getProviderStats(provider.name)
      }))
    );

    const providerConfigs = providerStateAndStats.map((provider) => ({
      ...provider,
      enabled: Boolean(process.env[provider.envKey]),
      cooling: isProviderCoolingDown(provider.state),
      available: false
    }));

    const selectedProviders = chooseProvidersForQuery(queryType, providerConfigs);

    const installedProviders = selectedProviders.filter((provider) => provider.enabled);
    const allCooling =
      installedProviders.length > 0 &&
      installedProviders.every((provider) => provider.cooling);

    installedProviders.forEach((provider) => {
      provider.available = allCooling || !provider.cooling;
    });

    const delays = chooseProviderDelays(installedProviders);

    const providerTasks = {};
    const providerResults = {};

    for (const provider of installedProviders) {
      if (provider.available) {
        providerTasks[provider.name] = callProviderWithTracking(
          provider.name,
          normalizedQuery,
          PROVIDER_CALLS[provider.name],
          delays[provider.name] || 0
        );
      } else {
        providerResults[provider.name] = {
          name: provider.name,
          answer: null,
          source_links: [],
          reference_image: null,
          error: new Error("Provider cooling down"),
          latency_ms: null,
          skipped: true
        };
      }
    }

    const activeTaskEntries = Object.entries(providerTasks);

    if (activeTaskEntries.length > 0) {
      const firstSettled = await Promise.race(
        activeTaskEntries.map(([name, task]) =>
          task.then((result) => ({ ...result, settledBy: name }))
        )
      );

      providerResults[firstSettled.name] = firstSettled;

      if (firstSettled.error) {
        console.error(`${firstSettled.name} provider error:`, firstSettled.error);
      }

      const remainingTasks = activeTaskEntries.filter(
        ([name]) => name !== firstSettled.name
      );

      if (firstSettled.answer && remainingTasks.length > 0) {
        const remainingResults = await Promise.all(
          remainingTasks.map(async ([name, task]) => {
            const result = await waitWithTimeout(task, PROVIDER_RACE_GRACE_MS);
            return result
              ? result
              : {
                  name,
                  answer: null,
                  source_links: [],
                  reference_image: null,
                  error: null,
                  latency_ms: null,
                  skipped: true
                };
          })
        );

        for (const result of remainingResults) {
          providerResults[result.name] = result;

          if (result?.error) {
            console.error(`${result.name} provider error:`, result.error);
          }
        }
      } else {
        const remainingResults = await Promise.all(
          remainingTasks.map(async ([, task]) => task)
        );

        for (const result of remainingResults) {
          providerResults[result.name] = result;

          if (result?.error) {
            console.error(`${result.name} provider error:`, result.error);
          }
        }
      }
    }

    const providerResultsList = installedProviders.map((provider) => {
      const result = providerResults[provider.name];
      const answer = result?.answer || null;
      const sourceLinks = result?.source_links || [];

      return {
        provider: provider.name,
        label: provider.label,
        answer,
        source_links: sourceLinks,
        reference_image: result?.reference_image || null,
        score: scoreAnswer({
          answer,
          sourceLinks,
          query: normalizedQuery,
          queryType
        })
      };
    });

    const validProviderAnswers = providerResultsList.filter((item) => item.answer);

    let finalAnswer = null;
    let provider = "chiron-nexus";
    let confidence = getConfidenceFromAnswers(
      validProviderAnswers.map((item) => item.answer)
    );
    let synthesisSkipped = false;
    let critique = null;

    const sources = validProviderAnswers.map((item) => item.label);
    const sourceLinks = dedupeSourceLinks(
      validProviderAnswers.flatMap((item) => item.source_links || [])
    );

    if (validProviderAnswers.length >= 2) {
      critique = await critiqueProviderAnswers(
        normalizedQuery,
        validProviderAnswers,
        queryType
      );

      if (critique?.needs_synthesis) {
        finalAnswer = await synthesizeWithOpenAI(
          normalizedQuery,
          validProviderAnswers,
          critique
        );
        confidence = critique.confidence || confidence;
      } else if (critique?.winner) {
        const winner = validProviderAnswers.find(
          (item) => item.provider === critique.winner
        );

        if (winner?.answer) {
          finalAnswer =
            (await cleanupSingleProviderAnswer(
              normalizedQuery,
              winner.label,
              winner.answer
            )) || winner.answer;

          synthesisSkipped = true;
          confidence = critique.confidence || confidence;
        }
      }

      if (!finalAnswer && shouldSkipSynthesis(validProviderAnswers.map((item) => item.answer))) {
        const directWinner = pickBestDirectAnswer(
          validProviderAnswers.map((item) => ({
            provider: item.provider,
            answer: item.answer,
            score: item.score
          }))
        );

        finalAnswer =
          (await cleanupSingleProviderAnswer(
            normalizedQuery,
            `Chiron Nexus Direct Winner (${directWinner.provider})`,
            directWinner.answer
          )) || directWinner.answer;

        synthesisSkipped = true;
      }

      if (!finalAnswer) {
        finalAnswer = await synthesizeWithOpenAI(
          normalizedQuery,
          validProviderAnswers,
          critique
        );
      }
    }

    if (!finalAnswer && validProviderAnswers.length === 1) {
      const onlyAnswer = validProviderAnswers[0];

      finalAnswer =
        (await cleanupSingleProviderAnswer(
          normalizedQuery,
          onlyAnswer.label,
          onlyAnswer.answer
        )) || onlyAnswer.answer;

      provider = "chiron-nexus";
      confidence = "low";
    }

    if (!finalAnswer) {
      return res.status(500).json({
        answer: "AI providers failed to return a usable answer.",
        sources: []
      });
    }

    let referenceImage =
      validProviderAnswers.find((item) => item.reference_image)?.reference_image || null;

    if (!referenceImage && isVisualQuery(normalizedQuery)) {
      referenceImage = await fetchWikipediaReferenceImage(
        extractVisualSubject(normalizedQuery)
      );
    }

    const historicalReferences = await fetchHistoricalReferences(
      normalizedQuery,
      queryType
    );

    const result = {
      answer: finalAnswer,
      sources,
      source_links: sourceLinks,
      reference_image: referenceImage,
      historical_references: historicalReferences,
      provider,
      confidence,
      query_type: queryType,
      consensus_level: critique?.consensus_level || null,
      arbitration_reason: critique?.reason || null,
      outlier_providers: critique?.outliers || [],
      synthesis_skipped: synthesisSkipped
    };

    if (sources.length > 0) {
      await kv.set(cacheKey, result, { ex: EXACT_CACHE_TTL_SECONDS });

      if (semanticKey) {
        await kv.set(semanticKey, result, { ex: SEMANTIC_CACHE_TTL_SECONDS });
      }
    }

    return res.status(200).json({
      ...result,
      cached: false,
      cache_type: "none",
      response_time_ms: Date.now() - requestStart
    });
  } catch (error) {
    console.error("Chiron Engine fatal error:", error);

    return res.status(500).json({
      answer: "Error contacting AI services.",
      sources: []
    });
  }
}

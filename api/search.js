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

const METRICS_TTL_SECONDS = 120 * 24 * 60 * 60;
const PROVIDER_LATENCY_ALPHA = 0.35;

const EXACT_CACHE_TTL_SECONDS = 3600;
const SEMANTIC_CACHE_TTL_SECONDS = 3600;

const MIN_PANEL_SIZE = 2;
const BASE_PANEL_SIZE = 3;
const MAX_PANEL_SIZE = 5;

const MAX_SOURCE_LINKS = 10;
const MAX_HISTORICAL_REFERENCES = 8;

const OPENAI_MODEL =
  process.env.AI_PROVIDER_OPENAI_MODEL ||
  process.env.OPENAI_MODEL ||
  "gpt-4.1-mini";

const GEMINI_MODEL =
  process.env.AI_PROVIDER_GEMINI_MODEL ||
  process.env.GEMINI_MODEL ||
  "gemini-2.5-flash";

const ANTHROPIC_MODEL =
  process.env.AI_PROVIDER_ANTHROPIC_MODEL ||
  process.env.ANTHROPIC_MODEL ||
  "claude-3-5-sonnet-latest";

const PERPLEXITY_MODEL =
  process.env.AI_PROVIDER_PERPLEXITY_MODEL ||
  process.env.PERPLEXITY_MODEL ||
  "sonar-pro";

const XAI_MODEL =
  process.env.AI_PROVIDER_XAI_MODEL ||
  process.env.XAI_MODEL ||
  "grok-3-latest";

const MISTRAL_MODEL =
  process.env.AI_PROVIDER_MISTRAL_MODEL ||
  process.env.MISTRAL_MODEL ||
  "mistral-medium-latest";

const DEEPSEEK_MODEL =
  process.env.AI_PROVIDER_DEEPSEEK_MODEL ||
  process.env.DEEPSEEK_MODEL ||
  "deepseek-chat";

const ALLOWED_ORIGINS = [
  "https://chironnexus.com",
  "https://www.chironnexus.com",
  "https://chironsearch.vercel.app",
  "http://localhost:3000"
];

const HISTORICAL_YEAR_REGEX = /\b(1[6-9]\d{2})\b/g;
const HISTORICAL_DECADE_REGEX = /\b(1[6-9]\d0s)\b/i;

const ACCESS_TIERS = {
  PUBLIC: "public",
  PAID: "paid",
  ADMIN: "admin"
};

const PROVIDERS = [
  {
    name: "openai",
    label: "OpenAI Web Search",
    envKeys: ["AI_PROVIDER_OPENAI_KEY", "OPENAI_API_KEY"],
    strengths: ["factual", "reasoning", "synthesis", "verification"],
    cost_tier: "high",
    speed_tier: "medium",
    grounded: true,
    good_for_fresh: true,
    good_for_long_reasoning: true,
    good_for_cleanup: true
  },
  {
    name: "gemini",
    label: "Gemini",
    envKeys: ["AI_PROVIDER_GEMINI_KEY", "GEMINI_API_KEY"],
    strengths: ["factual", "general", "fast"],
    cost_tier: "low",
    speed_tier: "fast",
    grounded: false,
    good_for_fresh: false,
    good_for_long_reasoning: false,
    good_for_cleanup: false
  },
  {
    name: "claude",
    label: "Claude",
    envKeys: ["AI_PROVIDER_ANTHROPIC_KEY", "ANTHROPIC_API_KEY"],
    strengths: ["reasoning", "explanation", "comparison", "synthesis"],
    cost_tier: "high",
    speed_tier: "medium",
    grounded: false,
    good_for_fresh: false,
    good_for_long_reasoning: true,
    good_for_cleanup: false
  },
  {
    name: "perplexity",
    label: "Perplexity",
    envKeys: ["AI_PROVIDER_PERPLEXITY_KEY", "PERPLEXITY_API_KEY"],
    strengths: ["fresh", "grounding", "sources", "visual"],
    cost_tier: "medium",
    speed_tier: "medium",
    grounded: true,
    good_for_fresh: true,
    good_for_long_reasoning: false,
    good_for_cleanup: false
  },
  {
    name: "grok",
    label: "Grok",
    envKeys: ["AI_PROVIDER_XAI_KEY", "XAI_API_KEY"],
    strengths: ["fresh", "current-events", "general"],
    cost_tier: "medium",
    speed_tier: "fast",
    grounded: false,
    good_for_fresh: true,
    good_for_long_reasoning: false,
    good_for_cleanup: false
  },
  {
    name: "mistral",
    label: "Mistral",
    envKeys: ["AI_PROVIDER_MISTRAL_KEY", "MISTRAL_API_KEY"],
    strengths: ["efficient", "general", "low-cost"],
    cost_tier: "low",
    speed_tier: "fast",
    grounded: false,
    good_for_fresh: false,
    good_for_long_reasoning: false,
    good_for_cleanup: false
  },
  {
    name: "deepseek",
    label: "DeepSeek",
    envKeys: ["AI_PROVIDER_DEEPSEEK_KEY", "DEEPSEEK_API_KEY"],
    strengths: ["technical", "reasoning", "comparison"],
    cost_tier: "low",
    speed_tier: "medium",
    grounded: false,
    good_for_fresh: false,
    good_for_long_reasoning: true,
    good_for_cleanup: false
  }
];

function debugLog(...args) {
  if (DEBUG_LOGS) {
    console.error(...args);
  }
}

function getEnvAny(...keys) {
  for (const key of keys) {
    const value = process.env[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

function getProviderApiKey(providerName) {
  const provider = PROVIDERS.find((item) => item.name === providerName);
  if (!provider) return "";
  return getEnvAny(...provider.envKeys);
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

function getRequestQueueKey(normalizedQuery) {
  return `search:request:v1:${normalizedQuery}`;
}

function getMetricsKey(metricName, bucket = "global") {
  return `metrics:v1:${metricName}:${bucket}`;
}

function getDailyBucket() {
  return new Date().toISOString().slice(0, 10);
}

async function incrementMetric(metricName, bucket = "global", amount = 1) {
  try {
    const key = getMetricsKey(metricName, bucket);
    const value = await kv.incrby(key, amount);
    if (value === amount) {
      await kv.expire(key, METRICS_TTL_SECONDS);
    }
  } catch (error) {
    debugLog("Metric increment failed:", metricName, bucket, error?.message || error);
  }
}

async function incrementMetricDual(metricName, amount = 1) {
  await Promise.all([
    incrementMetric(metricName, "global", amount),
    incrementMetric(metricName, getDailyBucket(), amount)
  ]);
}

async function trackProviderSelection(providerNames = []) {
  await Promise.all(
    providerNames.map((providerName) =>
      Promise.all([
        incrementMetric("provider_selected", providerName, 1),
        incrementMetric(`provider_selected_daily:${getDailyBucket()}`, providerName, 1)
      ])
    )
  );
}

function getLiveAccessMode(req) {
  const explicitAccess = getHeader(req, "x-chiron-access").toLowerCase().trim();
  const adminKeyHeader = getHeader(req, "x-chiron-admin-key");
  const adminKeyEnv = process.env.CHIRON_ADMIN_KEY || "";

  if (adminKeyEnv && adminKeyHeader && adminKeyHeader === adminKeyEnv) {
    return ACCESS_TIERS.ADMIN;
  }

  if (explicitAccess === ACCESS_TIERS.PAID) {
    return ACCESS_TIERS.PAID;
  }

  return ACCESS_TIERS.PUBLIC;
}

function isLiveSearchAllowed(accessTier) {
  return accessTier === ACCESS_TIERS.PAID || accessTier === ACCESS_TIERS.ADMIN;
}

function shouldForceLiveSearch(req, accessTier) {
  if (!isLiveSearchAllowed(accessTier)) {
    return false;
  }

  return getHeader(req, "x-chiron-force-live").toLowerCase() === "true";
}

function buildPublicCacheMissResponse(normalizedQuery, queryType, requestStart) {
  return {
    answer:
      "No cached answer is available for that search yet. Live search is currently limited to authorized users.",
    sources: [],
    source_links: [],
    reference_image: null,
    historical_references: [],
    provider: "chiron-cache",
    confidence: "low",
    query_type: queryType,
    query_difficulty: "unknown",
    route_mode: "cache-only",
    panel_size_initial: 0,
    panel_size_final: 0,
    consensus_level: null,
    arbitration_reason: null,
    outlier_providers: [],
    synthesis_skipped: false,
    cached: false,
    cache_type: "miss",
    response_time_ms: Date.now() - requestStart,
    access_tier: ACCESS_TIERS.PUBLIC,
    live_search_used: false,
    live_search_available: false,
    cache_only_mode: true,
    cache_miss: true,
    query: normalizedQuery,
    request_queued: false,
    upgrade_required: true
  };
}

async function markPublicCacheMissRequest(normalizedQuery) {
  try {
    const key = getRequestQueueKey(normalizedQuery);
    const now = Date.now();

    const existing = (await kv.get(key)) || {
      count: 0,
      first_requested_at: now,
      last_requested_at: now
    };

    const next = {
      count: Number(existing.count || 0) + 1,
      first_requested_at: Number(existing.first_requested_at || now),
      last_requested_at: now
    };

    await kv.set(key, next, { ex: 7 * 24 * 60 * 60 });
    await incrementMetricDual("public_cache_miss");

    return next;
  } catch (error) {
    debugLog("Failed to record cache miss request:", error?.message || error);
    return null;
  }
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
    }),
    incrementMetricDual("provider_success"),
    incrementMetric("provider_success_by_name", providerName, 1)
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
    }),
    incrementMetricDual("provider_failure"),
    incrementMetric("provider_failure_by_name", providerName, 1)
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

  return deduped.slice(0, MAX_SOURCE_LINKS);
}

function dedupeHistoricalReferences(items = []) {
  const seen = new Set();
  const deduped = [];

  for (const item of items) {
    const key = `${item?.source || ""}|${item?.title || ""}|${item?.url || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }

  return deduped.slice(0, MAX_HISTORICAL_REFERENCES);
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

function hasHistoricalSignals(query = "") {
  const q = query.toLowerCase();

  const explicitSignals = [
    "historically",
    "history of ",
    "how did people",
    "used to think",
    "old encyclopedia",
    "old encyclopaedia",
    "historical view",
    "historical perspective",
    "what was known about",
    "what did people believe",
    "what was believed about",
    "in the 1800s",
    "in the 1700s",
    "in the 1600s",
    "in the 1900s"
  ];

  if (explicitSignals.some((pattern) => q.includes(pattern))) {
    return true;
  }

  if (HISTORICAL_DECADE_REGEX.test(q)) {
    return true;
  }

  const years = q.match(HISTORICAL_YEAR_REGEX) || [];
  return years.length > 0;
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

  if (hasHistoricalSignals(q)) {
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

function estimateQueryDifficulty(query = "", queryType = "general") {
  const q = query.toLowerCase();
  const tokenCount = tokenize(q).length;

  let score = 0;

  if (tokenCount >= 14) score += 2;
  else if (tokenCount >= 9) score += 1;

  const hardSignals = [
    "analyze",
    "analysis",
    "tradeoff",
    "trade-off",
    "risks",
    "long-term",
    "implications",
    "compare",
    "versus",
    "difference",
    "why",
    "how",
    "historically",
    "what changed",
    "pros and cons",
    "best approach",
    "strategy",
    "architecture"
  ];

  const mediumSignals = [
    "explain",
    "overview",
    "summary",
    "history",
    "research",
    "technical",
    "reasoning"
  ];

  if (hardSignals.some((signal) => q.includes(signal))) {
    score += 2;
  } else if (mediumSignals.some((signal) => q.includes(signal))) {
    score += 1;
  }

  if (queryType === "comparison" || queryType === "historical") {
    score += 2;
  }

  if (queryType === "explanation" || queryType === "fresh") {
    score += 1;
  }

  if (queryType === "visual" || queryType === "factual") {
    score -= 1;
  }

  if (score <= 0) return "easy";
  if (score <= 2) return "medium";
  return "hard";
}

function buildRoutePlan({ query, queryType, difficulty, providers }) {
  const enabledProviders = providers.filter((provider) => provider.enabled);
  const enabledCount = enabledProviders.length;

  let routeMode = "balanced";
  let initialPanelSize = BASE_PANEL_SIZE;
  let maxPanelSize = Math.min(MAX_PANEL_SIZE, enabledCount);
  let requireGrounding = false;
  let allowSynthesis = true;
  let expandOnDisagreement = true;

  if (difficulty === "easy") {
    initialPanelSize = Math.min(MIN_PANEL_SIZE, enabledCount);
    allowSynthesis = false;
    routeMode = "cheap-first";
  }

  if (difficulty === "medium") {
    initialPanelSize = Math.min(BASE_PANEL_SIZE, enabledCount);
    routeMode = "balanced";
  }

  if (difficulty === "hard") {
    initialPanelSize = Math.min(4, enabledCount);
    routeMode = "reasoning-first";
    allowSynthesis = true;
  }

  if (queryType === "fresh") {
    initialPanelSize = Math.min(Math.max(initialPanelSize, 3), enabledCount);
    maxPanelSize = Math.min(Math.max(initialPanelSize + 1, 4), enabledCount, MAX_PANEL_SIZE);
    routeMode = "grounded-first";
    requireGrounding = true;
    allowSynthesis = true;
  }

  if (queryType === "historical") {
    initialPanelSize = Math.min(Math.max(initialPanelSize, 3), enabledCount);
    routeMode = "historical-first";
    allowSynthesis = true;
  }

  if (queryType === "comparison") {
    initialPanelSize = Math.min(Math.max(initialPanelSize, 3), enabledCount);
    routeMode = "reasoning-first";
    allowSynthesis = true;
  }

  if (queryType === "visual") {
    initialPanelSize = Math.min(Math.max(initialPanelSize, 2), enabledCount);
    routeMode = "visual-first";
    requireGrounding = true;
  }

  if (enabledCount <= 2) {
    initialPanelSize = enabledCount;
    maxPanelSize = enabledCount;
    expandOnDisagreement = false;
  } else {
    maxPanelSize = Math.max(initialPanelSize, maxPanelSize);
  }

  return {
    query_type: queryType,
    difficulty,
    route_mode: routeMode,
    require_grounding: requireGrounding,
    allow_synthesis: allowSynthesis,
    expand_on_disagreement: expandOnDisagreement,
    initial_panel_size: initialPanelSize,
    max_panel_size: maxPanelSize
  };
}

function scoreProviderForRoute(provider, routePlan) {
  let score = 0;

  if (!provider.enabled) {
    return -9999;
  }

  const avgLatency =
    typeof provider.stats?.avg_latency_ms === "number"
      ? provider.stats.avg_latency_ms
      : null;

  const failureCount = Number(provider.state?.failures || 0);
  const coolingPenalty = provider.cooling ? 100 : 0;

  if (routePlan.route_mode === "cheap-first") {
    if (provider.cost_tier === "low") score += 25;
    if (provider.speed_tier === "fast") score += 20;
  }

  if (routePlan.route_mode === "grounded-first") {
    if (provider.grounded) score += 28;
    if (provider.good_for_fresh) score += 18;
    if (provider.name === "perplexity") score += 14;
    if (provider.name === "openai") score += 8;
    if (provider.name === "grok") score += 8;
  }

  if (routePlan.route_mode === "reasoning-first") {
    if (provider.good_for_long_reasoning) score += 22;
    if (provider.strengths.includes("reasoning")) score += 18;
    if (provider.strengths.includes("comparison")) score += 10;
  }

  if (routePlan.route_mode === "historical-first") {
    if (provider.grounded) score += 14;
    if (provider.good_for_long_reasoning) score += 16;
    if (provider.name === "openai") score += 10;
    if (provider.name === "claude") score += 10;
  }

  if (routePlan.route_mode === "visual-first") {
    if (provider.strengths.includes("visual")) score += 20;
    if (provider.grounded) score += 10;
    if (provider.name === "perplexity") score += 12;
  }

  if (routePlan.route_mode === "balanced") {
    if (provider.speed_tier === "fast") score += 8;
    if (provider.cost_tier === "low") score += 8;
    if (provider.strengths.includes(routePlan.query_type)) score += 16;
  }

  if (provider.strengths.includes(routePlan.query_type)) {
    score += 18;
  }

  if (provider.strengths.includes("verification")) {
    score += 4;
  }

  if (avgLatency != null) {
    if (avgLatency <= 2500) score += 10;
    else if (avgLatency <= 5000) score += 5;
  }

  score -= Math.min(failureCount * 4, 16);
  score -= coolingPenalty;

  return score;
}

function selectProvidersForRoutePlan(routePlan, providers) {
  const scored = providers
    .filter((provider) => provider.enabled)
    .map((provider) => ({
      ...provider,
      route_score: scoreProviderForRoute(provider, routePlan)
    }))
    .sort((a, b) => b.route_score - a.route_score);

  const initialProviders = scored.slice(0, routePlan.initial_panel_size);
  const expansionProviders = scored
    .filter(
      (provider) =>
        !initialProviders.find((item) => item.name === provider.name)
    )
    .slice(0, Math.max(0, routePlan.max_panel_size - initialProviders.length));

  return {
    initialProviders,
    expansionProviders
  };
}

function shouldExpandPanel({
  routePlan,
  critique,
  validProviderAnswers,
  sourceLinks,
  remainingExpansionCount
}) {
  if (!routePlan.expand_on_disagreement) {
    return false;
  }

  if (remainingExpansionCount <= 0) {
    return false;
  }

  if (validProviderAnswers.length < 2) {
    return true;
  }

  if (critique?.consensus_level === "low") {
    return true;
  }

  if (critique?.outliers?.length) {
    return true;
  }

  if (routePlan.require_grounding && sourceLinks.length < 2) {
    return true;
  }

  const confidence = getConfidenceFromAnswers(
    validProviderAnswers.map((item) => item.answer)
  );

  if (confidence === "low" && routePlan.difficulty !== "easy") {
    return true;
  }

  return false;
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
    .replace(
      /\b(historically|history of|old encyclopedia|old encyclopaedia|used to think|how did people|historical view|historical perspective|what was known about|what did people believe|what was believed about)\b/gi,
      " "
    )
    .replace(/\b(in\s+(1[6-9]\d{2}))\b/gi, " ")
    .replace(/\b(1[6-9]\d0s)\b/gi, " ")
    .replace(/[?!.]+$/g, "")
    .replace(/\s+/g, " ")
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

async function fetchProjectGutenbergHistoricalReferences(subject) {
  if (!subject) return [];

  const url = `https://gutendex.com/books?search=${encodeURIComponent(subject)}`;

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
      "Project Gutenberg search"
    );

    if (!response.ok) {
      return [];
    }

    const data = await response.json();
    const results = Array.isArray(data?.results) ? data.results : [];

    return results.slice(0, 3).map((book) => ({
      source: "Project Gutenberg",
      title: book.title || "Untitled",
      year: null,
      author:
        Array.isArray(book.authors) && book.authors.length > 0
          ? book.authors
              .slice(0, 2)
              .map((author) => author.name)
              .filter(Boolean)
              .join(", ")
          : null,
      url:
        book.formats?.["text/html"] ||
        book.formats?.["text/html; charset=utf-8"] ||
        book.formats?.["text/plain; charset=utf-8"] ||
        book.formats?.["text/plain"] ||
        "",
      summary: Array.isArray(book.subjects)
        ? book.subjects.slice(0, 2).join(" • ")
        : null
    }));
  } catch (error) {
    debugLog("Project Gutenberg historical lookup failed:", error?.message || error);
    return [];
  }
}

async function fetchWikidataHistoricalReferences(subject) {
  if (!subject) return [];

  const url =
    `https://www.wikidata.org/w/api.php?action=wbsearchentities` +
    `&search=${encodeURIComponent(subject)}` +
    `&language=en&format=json&limit=3&origin=*`;

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
      "Wikidata search"
    );

    if (!response.ok) {
      return [];
    }

    const data = await response.json();
    const results = Array.isArray(data?.search) ? data.search : [];

    return results.slice(0, 3).map((item) => ({
      source: "Wikidata",
      title: item.label || "Untitled",
      year: null,
      author: null,
      url: item.id
        ? `https://www.wikidata.org/wiki/${encodeURIComponent(item.id)}`
        : "",
      summary: item.description || null
    }));
  } catch (error) {
    debugLog("Wikidata historical lookup failed:", error?.message || error);
    return [];
  }
}

async function fetchHistoricalReferences(query, queryType) {
  if (queryType !== "historical") {
    return [];
  }

  const subject = normalizeHistoricalSubject(query);

  if (!subject) {
    return [];
  }

  const [openLibrary, internetArchive, gutenberg, wikidata] = await Promise.all([
    fetchOpenLibraryHistoricalReferences(subject),
    fetchInternetArchiveHistoricalReferences(subject),
    fetchProjectGutenbergHistoricalReferences(subject),
    fetchWikidataHistoricalReferences(subject)
  ]);

  return dedupeHistoricalReferences([
    ...openLibrary,
    ...internetArchive,
    ...gutenberg,
    ...wikidata
  ]).slice(0, 6);
}

async function callOpenAI(query) {
  const apiKey = getProviderApiKey("openai");
  if (!apiKey) return null;

  try {
    const response = await fetchWithAbort(
      "https://api.openai.com/v1/responses",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`
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
  const apiKey = getProviderApiKey("gemini");
  if (!apiKey) return null;

  try {
    const response = await fetchWithAbort(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
        GEMINI_MODEL
      )}:generateContent?key=${apiKey}`,
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
  const apiKey = getProviderApiKey("claude");
  if (!apiKey) return null;

  try {
    const response = await fetchWithAbort(
      "https://api.anthropic.com/v1/messages",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
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
  const apiKey = getProviderApiKey("perplexity");
  if (!apiKey) return null;

  try {
    const response = await fetchWithAbort(
      "https://api.perplexity.ai/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`
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
  const apiKey = getProviderApiKey("grok");
  if (!apiKey) return null;

  try {
    const response = await fetchWithAbort(
      "https://api.x.ai/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`
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
  const apiKey = getProviderApiKey("mistral");
  if (!apiKey) return null;

  try {
    const response = await fetchWithAbort(
      "https://api.mistral.ai/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`
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
  const apiKey = getProviderApiKey("deepseek");
  if (!apiKey) return null;

  try {
    const response = await fetchWithAbort(
      "https://api.deepseek.com/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`
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
  const openAiKey = getProviderApiKey("openai");
  if (!openAiKey) {
    return rawAnswer || null;
  }

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
          Authorization: `Bearer ${openAiKey}`
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
  const openAiKey = getProviderApiKey("openai");
  if (!openAiKey) {
    return null;
  }

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
          Authorization: `Bearer ${openAiKey}`
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
  const openAiKey = getProviderApiKey("openai");
  if (!openAiKey) {
    return null;
  }

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
          Authorization: `Bearer ${openAiKey}`
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
    await incrementMetric("provider_invoked", providerName, 1);
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

async function executeProviderPanel(selectedProviders, normalizedQuery) {
  const installedProviders = selectedProviders.filter((provider) => provider.enabled);

  if (installedProviders.length === 0) {
    return {};
  }

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

  return providerResults;
}

function buildProviderResultsList(providersUsed, providerResults, normalizedQuery, queryType) {
  return providersUsed.map((provider) => {
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
  const accessTier = getLiveAccessMode(req);
  const liveSearchAllowed = isLiveSearchAllowed(accessTier);
  const forceLive = shouldForceLiveSearch(req, accessTier);

  await incrementMetricDual("request_total");
  await incrementMetric("request_by_access_tier", accessTier, 1);

  if (!isAllowedOrigin(origin)) {
    await incrementMetricDual("forbidden_origin");
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
    await incrementMetricDual("rate_limited_fingerprint");
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
  const queryDifficulty = estimateQueryDifficulty(normalizedQuery, queryType);

  await incrementMetric("request_by_query_type", queryType, 1);
  await incrementMetric("request_by_difficulty", queryDifficulty, 1);

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
    await incrementMetricDual("rate_limited_query_burst");
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
    await incrementMetricDual("rate_limited_ip");
    return res.status(429).json({
      answer: "Too many searches. Please wait a minute and try again.",
      sources: []
    });
  }

  const cacheKey = `search:v25:${normalizedQuery}`;
  const semanticEnabled = isSemanticCacheSafe(normalizedQuery);
  const semanticFingerprint = semanticEnabled
    ? fingerprintQuery(normalizedQuery)
    : "";
  const semanticKey = semanticFingerprint
    ? `semantic:v11:${semanticFingerprint}`
    : "";

  try {
    if (!forceLive) {
      const cached = await kv.get(cacheKey);

      if (cached) {
        await incrementMetricDual("cache_hit_exact");
        return res.status(200).json({
          ...cached,
          cached: true,
          cache_type: "exact",
          response_time_ms: Date.now() - requestStart,
          access_tier: accessTier,
          live_search_used: false,
          live_search_available: liveSearchAllowed,
          cache_only_mode: accessTier === ACCESS_TIERS.PUBLIC
        });
      }

      if (semanticKey) {
        const semanticCached = await kv.get(semanticKey);

        if (semanticCached) {
          await kv.set(cacheKey, semanticCached, { ex: EXACT_CACHE_TTL_SECONDS });
          await incrementMetricDual("cache_hit_semantic");

          return res.status(200).json({
            ...semanticCached,
            cached: true,
            cache_type: "semantic",
            response_time_ms: Date.now() - requestStart,
            access_tier: accessTier,
            live_search_used: false,
            live_search_available: liveSearchAllowed,
            cache_only_mode: accessTier === ACCESS_TIERS.PUBLIC
          });
        }
      }
    }

    await incrementMetricDual("cache_miss");

    if (!liveSearchAllowed) {
      const queueMeta = await markPublicCacheMissRequest(normalizedQuery);
      const missResponse = buildPublicCacheMissResponse(
        normalizedQuery,
        queryType,
        requestStart
      );

      return res.status(200).json({
        ...missResponse,
        query_difficulty: queryDifficulty,
        request_queued: Boolean(queueMeta),
        request_queue_count: queueMeta?.count || 0,
        first_requested_at: queueMeta?.first_requested_at || null,
        last_requested_at: queueMeta?.last_requested_at || null
      });
    }

    await incrementMetricDual("live_search_used");

    const historicalReferencesPromise =
      queryType === "historical"
        ? fetchHistoricalReferences(normalizedQuery, queryType)
        : Promise.resolve([]);

    const providerStateAndStats = await Promise.all(
      PROVIDERS.map(async (provider) => ({
        ...provider,
        state: await getProviderState(provider.name),
        stats: await getProviderStats(provider.name)
      }))
    );

    const providerConfigs = providerStateAndStats.map((provider) => ({
      ...provider,
      enabled: Boolean(getEnvAny(...provider.envKeys)),
      cooling: isProviderCoolingDown(provider.state),
      available: false
    }));

    const routePlan = buildRoutePlan({
      query: normalizedQuery,
      queryType,
      difficulty: queryDifficulty,
      providers: providerConfigs
    });

    const { initialProviders, expansionProviders } = selectProvidersForRoutePlan(
      routePlan,
      providerConfigs
    );

    if (initialProviders.length === 0) {
      await incrementMetricDual("no_provider_configured");
      return res.status(500).json({
        answer: "No AI providers are configured.",
        sources: []
      });
    }

    await trackProviderSelection(initialProviders.map((item) => item.name));
    await incrementMetric("route_mode_used", routePlan.route_mode, 1);
    await incrementMetric("initial_panel_size_used", String(initialProviders.length), 1);

    const initialResults = await executeProviderPanel(initialProviders, normalizedQuery);
    let providerResults = { ...initialResults };
    let providersUsed = [...initialProviders];

    let providerResultsList = buildProviderResultsList(
      providersUsed,
      providerResults,
      normalizedQuery,
      queryType
    );
    let validProviderAnswers = providerResultsList.filter((item) => item.answer);
    let sourceLinks = dedupeSourceLinks(
      validProviderAnswers.flatMap((item) => item.source_links || [])
    );

    let initialCritique = null;

    if (validProviderAnswers.length >= 2) {
      initialCritique = await critiqueProviderAnswers(
        normalizedQuery,
        validProviderAnswers,
        queryType
      );
    }

    const expandNow = shouldExpandPanel({
      routePlan,
      critique: initialCritique,
      validProviderAnswers,
      sourceLinks,
      remainingExpansionCount: expansionProviders.length
    });

    let expansionUsed = false;
    let expansionProvidersUsed = [];

    if (expandNow && expansionProviders.length > 0) {
      const expansionTargetCount = Math.min(
        expansionProviders.length,
        Math.max(1, routePlan.max_panel_size - initialProviders.length)
      );

      expansionProvidersUsed = expansionProviders.slice(0, expansionTargetCount);

      await trackProviderSelection(expansionProvidersUsed.map((item) => item.name));
      await incrementMetricDual("panel_expanded");

      const expansionResults = await executeProviderPanel(
        expansionProvidersUsed,
        normalizedQuery
      );

      providerResults = {
        ...providerResults,
        ...expansionResults
      };

      providersUsed = [...initialProviders, ...expansionProvidersUsed];
      providerResultsList = buildProviderResultsList(
        providersUsed,
        providerResults,
        normalizedQuery,
        queryType
      );
      validProviderAnswers = providerResultsList.filter((item) => item.answer);
      sourceLinks = dedupeSourceLinks(
        validProviderAnswers.flatMap((item) => item.source_links || [])
      );
      expansionUsed = true;
    }

    let finalAnswer = null;
    let provider = "chiron-nexus";
    let confidence = getConfidenceFromAnswers(
      validProviderAnswers.map((item) => item.answer)
    );
    let synthesisSkipped = false;
    let critique = null;

    const sources = validProviderAnswers.map((item) => item.label);

    if (validProviderAnswers.length >= 2) {
      critique = await critiqueProviderAnswers(
        normalizedQuery,
        validProviderAnswers,
        queryType
      );

      if (critique?.needs_synthesis || routePlan.allow_synthesis) {
        finalAnswer = await synthesizeWithOpenAI(
          normalizedQuery,
          validProviderAnswers,
          critique
        );
        confidence = critique?.confidence || confidence;
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

      if (
        !finalAnswer &&
        shouldSkipSynthesis(validProviderAnswers.map((item) => item.answer))
      ) {
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
      await incrementMetricDual("answer_generation_failed");
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

    const historicalReferences = await historicalReferencesPromise;

    const result = {
      answer: finalAnswer,
      sources,
      source_links: sourceLinks,
      reference_image: referenceImage,
      historical_references: historicalReferences,
      provider,
      confidence,
      query_type: queryType,
      query_difficulty: queryDifficulty,
      route_mode: routePlan.route_mode,
      panel_size_initial: initialProviders.length,
      panel_size_final: providersUsed.length,
      panel_expanded: expansionUsed,
      initial_providers: initialProviders.map((item) => item.name),
      expansion_providers: expansionProvidersUsed.map((item) => item.name),
      consensus_level: critique?.consensus_level || null,
      arbitration_reason: critique?.reason || null,
      outlier_providers: critique?.outliers || [],
      synthesis_skipped: synthesisSkipped,
      access_tier: accessTier,
      live_search_used: true,
      live_search_available: liveSearchAllowed,
      cache_only_mode: accessTier === ACCESS_TIERS.PUBLIC
    };

    if (sources.length > 0) {
      await kv.set(cacheKey, result, { ex: EXACT_CACHE_TTL_SECONDS });

      if (semanticKey) {
        await kv.set(semanticKey, result, { ex: SEMANTIC_CACHE_TTL_SECONDS });
      }
    }

    await incrementMetricDual("answer_generated");

    return res.status(200).json({
      ...result,
      cached: false,
      cache_type: "none",
      response_time_ms: Date.now() - requestStart
    });
  } catch (error) {
    console.error("Chiron Engine fatal error:", error);
    await incrementMetricDual("fatal_error");

    return res.status(500).json({
      answer: "Error contacting AI services.",
      sources: []
    });
  }
}

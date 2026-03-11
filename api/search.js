import { kv } from "@vercel/kv";

function normalizeQuery(q = "") {
  return q.toLowerCase().trim().replace(/\s+/g, " ");
}

function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length > 0) {
    return forwarded.split(",")[0].trim();
  }
  return req.socket?.remoteAddress || "unknown";
}

function tokenize(text = "") {
  return text
    .toLowerCase()
    .split(/\W+/)
    .filter(Boolean);
}

function providersDisagree(a, b) {
  if (!a || !b) return false;

  const lengthDiff = Math.abs(a.length - b.length);
  if (lengthDiff > 500) {
    return true;
  }

  const wordsA = new Set(tokenize(a));
  const wordsB = new Set(tokenize(b));

  if (wordsA.size === 0 || wordsB.size === 0) {
    return false;
  }

  let overlap = 0;

  wordsA.forEach((word) => {
    if (wordsB.has(word)) {
      overlap++;
    }
  });

  const similarity = overlap / Math.max(wordsA.size, wordsB.size);

  return similarity < 0.35;
}

function getConfidence(openaiAnswer, geminiAnswer, disagreement) {
  if (!openaiAnswer || !geminiAnswer) {
    return "low";
  }

  if (disagreement) {
    return "low";
  }

  const lengthDiff = Math.abs(openaiAnswer.length - geminiAnswer.length);
  const wordsA = new Set(tokenize(openaiAnswer));
  const wordsB = new Set(tokenize(geminiAnswer));

  let overlap = 0;
  wordsA.forEach((word) => {
    if (wordsB.has(word)) {
      overlap++;
    }
  });

  const similarity =
    overlap / Math.max(wordsA.size || 1, wordsB.size || 1);

  if (similarity >= 0.65 && lengthDiff < 250) {
    return "high";
  }

  return "medium";
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
    "why"
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

async function callOpenAI(query) {
  try {
    const response = await fetchWithAbort(
      "https://api.openai.com/v1/responses",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`
        },
        body: JSON.stringify({
          model: "gpt-4.1-mini",
          tools: [{ type: "web_search" }],
          input: query
        })
      },
      8000,
      "OpenAI"
    );

    const data = await response.json();
    console.error("OpenAI raw response:", JSON.stringify(data, null, 2));

    if (!response.ok) {
      return null;
    }

    const messageItem = (data.output || []).find(
      (item) => item.type === "message"
    );

    return (
      data.output_text ||
      messageItem?.content?.find((part) => part.type === "output_text")?.text ||
      messageItem?.content?.[0]?.text ||
      null
    );
  } catch (error) {
    console.error("OpenAI request error:", error);
    return null;
  }
}

async function callGemini(query) {
  try {
    const response = await fetchWithAbort(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=" +
        process.env.GEMINI_API_KEY,
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
    console.error("Gemini raw response:", JSON.stringify(data, null, 2));

    if (!response.ok) {
      return null;
    }

    return data.candidates?.[0]?.content?.parts?.[0]?.text || null;
  } catch (error) {
    console.error("Gemini request error:", error);
    return null;
  }
}

async function synthesizeWithOpenAI(userQuery, openaiAnswer, geminiAnswer, disagreement) {
  const synthesisPrompt = `
You are Chiron Nexus, an AI broker and synthesis engine.

The user asked:
"${userQuery}"

Below are two AI-generated answers from different providers.

OPENAI ANSWER:
${openaiAnswer}

GEMINI ANSWER:
${geminiAnswer}

Important:
- The two providers ${disagreement ? "appear to disagree in meaningful ways" : "mostly agree"}.
- ${disagreement
    ? "Be cautious, acknowledge uncertainty where needed, and reconcile differences carefully."
    : "Produce a clean merged answer using the strongest parts of both."}

Your task:
- Produce one clear, accurate, concise final answer for the user.
- Synthesize the strongest points from both answers.
- Resolve disagreements cautiously.
- Do not mention internal analysis.
- Do not say "OpenAI says" or "Gemini says" in the main answer.
- Do not use markdown headings.
- Keep the answer clean and natural.
- If both answers are weak or uncertain, say so briefly and give the best cautious answer.
`;

  try {
    const response = await fetchWithAbort(
      "https://api.openai.com/v1/responses",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`
        },
        body: JSON.stringify({
          model: "gpt-4.1-mini",
          input: synthesisPrompt
        })
      },
      6000,
      "Synthesis"
    );

    const data = await response.json();
    console.error("Synthesis raw response:", JSON.stringify(data, null, 2));

    if (!response.ok) {
      return null;
    }

    const messageItem = (data.output || []).find(
      (item) => item.type === "message"
    );

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
          "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`
        },
        body: JSON.stringify({
          model: "gpt-4.1-mini",
          input: cleanupPrompt
        })
      },
      6000,
      "Single-provider cleanup"
    );

    const data = await response.json();
    console.error("Cleanup raw response:", JSON.stringify(data, null, 2));

    if (!response.ok) {
      return null;
    }

    const messageItem = (data.output || []).find(
      (item) => item.type === "message"
    );

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

export default async function handler(req, res) {
  const requestStart = Date.now();

  if (req.method !== "POST") {
    return res.status(405).json({
      answer: "Method not allowed.",
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

  const cacheKey = `search:v10:${normalizedQuery}`;
  const semanticEnabled = isSemanticCacheSafe(normalizedQuery);
  const semanticFingerprint = semanticEnabled
    ? fingerprintQuery(normalizedQuery)
    : "";
  const semanticKey = semanticFingerprint
    ? `semantic:v1:${semanticFingerprint}`
    : "";

  try {
    const cached = await kv.get(cacheKey);

    if (cached) {
      return res.status(200).json({
        ...cached,
        cached: true,
        response_time_ms: Date.now() - requestStart
      });
    }

    if (semanticKey) {
      const semanticCached = await kv.get(semanticKey);

      if (semanticCached) {
        await kv.set(cacheKey, semanticCached, { ex: 3600 });

        return res.status(200).json({
          ...semanticCached,
          cached: true,
          response_time_ms: Date.now() - requestStart
        });
      }
    }

    const providerResults = await Promise.allSettled([
      callOpenAI(normalizedQuery),
      callGemini(normalizedQuery)
    ]);

    const openaiAnswer =
      providerResults[0].status === "fulfilled" ? providerResults[0].value : null;

    const geminiAnswer =
      providerResults[1].status === "fulfilled" ? providerResults[1].value : null;

    if (providerResults[0].status === "rejected") {
      console.error("OpenAI provider error:", providerResults[0].reason);
    }

    if (providerResults[1].status === "rejected") {
      console.error("Gemini provider error:", providerResults[1].reason);
    }

    let finalAnswer = null;
    let provider = "chiron-nexus";
    let confidence = "low";
    const sources = [];

    if (openaiAnswer) {
      sources.push("OpenAI Web Search");
    }

    if (geminiAnswer) {
      sources.push("Gemini");
    }

    if (openaiAnswer && geminiAnswer) {
      const disagreement = providersDisagree(openaiAnswer, geminiAnswer);
      confidence = getConfidence(openaiAnswer, geminiAnswer, disagreement);

      finalAnswer = await synthesizeWithOpenAI(
        normalizedQuery,
        openaiAnswer,
        geminiAnswer,
        disagreement
      );
    }

    if (!finalAnswer && openaiAnswer) {
      finalAnswer =
        (await cleanupSingleProviderAnswer(
          normalizedQuery,
          "OpenAI Web Search",
          openaiAnswer
        )) || openaiAnswer;

      provider = "chiron-nexus";
      confidence = "low";
    }

    if (!finalAnswer && geminiAnswer) {
      finalAnswer =
        (await cleanupSingleProviderAnswer(
          normalizedQuery,
          "Gemini",
          geminiAnswer
        )) || geminiAnswer;

      provider = "chiron-nexus";
      confidence = "low";
    }

    if (!finalAnswer) {
      return res.status(500).json({
        answer: "Both AI providers failed to return a usable answer.",
        sources: []
      });
    }

    const result = {
      answer: finalAnswer,
      sources,
      provider,
      confidence
    };

    if (sources.length > 0) {
      await kv.set(cacheKey, result, { ex: 3600 });

      if (semanticKey) {
        await kv.set(semanticKey, result, { ex: 3600 });
      }
    }

    return res.status(200).json({
      ...result,
      cached: false,
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

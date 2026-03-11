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

async function callOpenAI(query) {
  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
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
    });

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
    const response = await fetch(
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
      }
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

async function synthesizeWithOpenAI(userQuery, openaiAnswer, geminiAnswer) {
  const synthesisPrompt = `
You are Chiron Nexus, an AI broker and synthesis engine.

The user asked:
"${userQuery}"

Below are two AI-generated answers from different providers.

OPENAI ANSWER:
${openaiAnswer}

GEMINI ANSWER:
${geminiAnswer}

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
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        input: synthesisPrompt
      })
    });

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

export default async function handler(req, res) {
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

  const cacheKey = `search:v3:${normalizedQuery}`;

  try {
    const cached = await kv.get(cacheKey);

    if (cached) {
      return res.status(200).json({
        ...cached,
        cached: true
      });
    }

    const [openaiAnswer, geminiAnswer] = await Promise.all([
      callOpenAI(normalizedQuery),
      callGemini(normalizedQuery)
    ]);

    let finalAnswer = null;
    let provider = "chiron-nexus";
    const sources = [];

    if (openaiAnswer) {
      sources.push("OpenAI Web Search");
    }

    if (geminiAnswer) {
      sources.push("Gemini");
    }

    if (openaiAnswer && geminiAnswer) {
      finalAnswer = await synthesizeWithOpenAI(
        normalizedQuery,
        openaiAnswer,
        geminiAnswer
      );
    }

    if (!finalAnswer && openaiAnswer) {
      finalAnswer = openaiAnswer;
      provider = "openai";
    }

    if (!finalAnswer && geminiAnswer) {
      finalAnswer = geminiAnswer;
      provider = "gemini";
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
      provider
    };

    if (sources.length > 0) {
      await kv.set(cacheKey, result, { ex: 3600 });
    }

    return res.status(200).json({
      ...result,
      cached: false
    });
  } catch (error) {
    console.error("Chiron Engine fatal error:", error);

    return res.status(500).json({
      answer: "Error contacting AI services.",
      sources: []
    });
  }
}

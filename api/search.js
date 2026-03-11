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

  const cacheKey = `search:v1:${normalizedQuery}`;

  try {
    const cached = await kv.get(cacheKey);

    if (cached) {
      return res.status(200).json({
        ...cached,
        cached: true
      });
    }

    let openaiAnswer = "OpenAI returned no answer.";
    let geminiAnswer = "Gemini returned no answer.";
    let sources = [];

    try {
      const openaiResponse = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`
        },
        body: JSON.stringify({
          model: "gpt-4.1-mini",
          tools: [{ type: "web_search" }],
          input: normalizedQuery
        })
      });

      const openaiData = await openaiResponse.json();
      console.error("OpenAI raw response:", JSON.stringify(openaiData, null, 2));

      if (!openaiResponse.ok) {
        openaiAnswer = openaiData.error?.message || "OpenAI request failed.";
      } else {
        const messageItem = (openaiData.output || []).find(
          (item) => item.type === "message"
        );

        openaiAnswer =
          openaiData.output_text ||
          messageItem?.content?.find((part) => part.type === "output_text")?.text ||
          messageItem?.content?.[0]?.text ||
          "OpenAI returned no answer.";

        sources.push("OpenAI Web Search");
      }
    } catch (error) {
      console.error("OpenAI request error:", error);
      openaiAnswer = "OpenAI request error.";
    }

    try {
      const geminiResponse = await fetch(
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
                parts: [{ text: normalizedQuery }]
              }
            ]
          })
        }
      );

      const geminiData = await geminiResponse.json();
      console.error("Gemini raw response:", JSON.stringify(geminiData, null, 2));

      if (!geminiResponse.ok) {
        geminiAnswer = geminiData.error?.message || "Gemini request failed.";
      } else {
        geminiAnswer =
          geminiData.candidates?.[0]?.content?.parts?.[0]?.text ||
          "Gemini returned no answer.";

        sources.push("Gemini");
      }
    } catch (error) {
      console.error("Gemini request error:", error);
      geminiAnswer = "Gemini request error.";
    }

    const result = {
      answer:
        "OPENAI:\n\n" +
        openaiAnswer +
        "\n\n-------------------\n\nGEMINI:\n\n" +
        geminiAnswer,
      sources: sources.length ? sources : ["No providers succeeded"]
    };

    const shouldCache =
      sources.length > 0 && !sources.includes("No providers succeeded");

    if (shouldCache) {
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

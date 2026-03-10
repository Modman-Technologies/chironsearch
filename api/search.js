export default async function handler(req, res) {
  const { query } = req.body || {};

  if (!query) {
    return res.status(400).json({
      answer: "No query provided.",
      sources: []
    });
  }

  try {
    let openaiAnswer = "OpenAI returned no answer.";
    let geminiAnswer = "Gemini returned no answer.";
    let sources = [];

    // OPENAI REQUEST
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
          input: query
        })
      });

      const openaiData = await openaiResponse.json();
      console.error("OpenAI raw response:", JSON.stringify(openaiData, null, 2));

      if (!openaiResponse.ok) {
        openaiAnswer =
          openaiData.error?.message || "OpenAI request failed.";
      } else {
        const messageItem = (openaiData.output || []).find(
          item => item.type === "message"
        );

        openaiAnswer =
          openaiData.output_text ||
          messageItem?.content?.find(part => part.type === "output_text")?.text ||
          messageItem?.content?.[0]?.text ||
          "OpenAI returned no answer.";

        sources.push("OpenAI Web Search");
      }
    } catch (error) {
      console.error("OpenAI request error:", error);
      openaiAnswer = "OpenAI request error.";
    }

    // GEMINI REQUEST
    try {
      const geminiResponse = await fetch(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=" +
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

      const geminiData = await geminiResponse.json();
      console.error("Gemini raw response:", JSON.stringify(geminiData, null, 2));

      if (!geminiResponse.ok) {
        geminiAnswer =
          geminiData.error?.message || "Gemini request failed.";
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

    return res.status(200).json({
      answer:
        "OPENAI:\n\n" +
        openaiAnswer +
        "\n\n-------------------\n\nGEMINI:\n\n" +
        geminiAnswer,
      sources: sources.length ? sources : ["No providers succeeded"]
    });
  } catch (error) {
    console.error("Chiron Engine fatal error:", error);

    return res.status(500).json({
      answer: "Error contacting AI services.",
      sources: []
    });
  }
}

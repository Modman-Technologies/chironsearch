export default async function handler(req, res) {
  const { query } = req.body || {};

  if (!query) {
    return res.status(400).json({
      answer: "No query provided.",
      sources: []
    });
  }

  try {

    // OPENAI REQUEST
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

    const openaiAnswer =
      openaiData.output_text ||
      openaiData.output?.[0]?.content?.[0]?.text ||
      "OpenAI returned no answer.";

    // GEMINI REQUEST
    const geminiResponse = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=" +
        process.env.GEMINI_API_KEY,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                { text: query }
              ]
            }
          ]
        })
      }
    );

    const geminiData = await geminiResponse.json();

    const geminiAnswer =
      geminiData.candidates?.[0]?.content?.parts?.[0]?.text ||
      "Gemini returned no answer.";

    res.status(200).json({
      answer:
        "OPENAI:\n\n" +
        openaiAnswer +
        "\n\n-------------------\n\nGEMINI:\n\n" +
        geminiAnswer,
      sources: ["OpenAI Web Search", "Gemini"]
    });

  } catch (error) {
    console.error("Chiron Engine error:", error);

    res.status(500).json({
      answer: "Error contacting AI services.",
      sources: []
    });
  }
}

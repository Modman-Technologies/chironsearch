export default async function handler(req, res) {
  const { query } = req.body || {};

  if (!query) {
    return res.status(400).json({
      answer: "No query provided.",
      sources: []
    });
  }

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
        include: ["web_search_call.action.sources"],
        input: `Provide a clear answer with citations for: ${query}`
      })
    });

    const data = await response.json();

    const answer =
      data.output_text ||
      data.output?.find(item => item.type === "message")?.content?.[0]?.text ||
      "No answer returned.";

    res.status(200).json({
      answer,
      sources: ["OpenAI Web Search"]
    });

  } catch (error) {
    res.status(500).json({
      answer: "Error contacting OpenAI.",
      sources: []
    });
  }
}

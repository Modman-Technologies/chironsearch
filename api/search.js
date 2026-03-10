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

    if (!response.ok) {
      console.error("OpenAI API HTTP error:", data);
      return res.status(response.status).json({
        answer: data.error?.message || "OpenAI request failed.",
        sources: []
      });
    }

    console.error("OpenAI raw response:", JSON.stringify(data, null, 2));

    const messageItem = (data.output || []).find(
      item => item.type === "message"
    );

    const answer =
      data.output_text ||
      messageItem?.content?.find(part => part.type === "output_text")?.text ||
      messageItem?.content?.[0]?.text ||
      "No answer returned.";

    const webSearchItem = (data.output || []).find(
      item => item.type === "web_search_call"
    );

    const sourceTitles =
      webSearchItem?.action?.sources?.map(source => source.title).filter(Boolean) || [];

    res.status(200).json({
      answer,
      sources: sourceTitles.length ? sourceTitles : ["OpenAI Web Search"]
    });
  } catch (error) {
    console.error("OpenAI API error:", error);

    res.status(500).json({
      answer: "Error contacting OpenAI.",
      sources: []
    });
  }
}

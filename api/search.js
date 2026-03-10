export default async function handler(req, res) {

  const { query } = req.body || {};

  if (!query) {
    return res.status(400).json({
      answer: "No query provided.",
      sources: []
    });
  }

  try {

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: "You are Chiron Nexus, a system that provides clear unified answers."
          },
          {
            role: "user",
            content: query
          }
        ]
      })
    });

    const data = await response.json();

    const answer =
      data.choices?.[0]?.message?.content || "No answer returned.";

    res.status(200).json({
      answer,
      sources: ["OpenAI"]
    });

  } catch (error) {

    res.status(500).json({
      answer: "Error contacting AI service.",
      sources: []
    });

  }

}

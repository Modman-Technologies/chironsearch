export default async function handler(req, res) {

  const { query } = req.body || {};

  if (!query) {
    return res.status(400).json({
      answer: "No query provided.",
      sources: []
    });
  }

  res.status(200).json({
    answer: `Chiron Engine received your question: "${query}". AI responses will appear here soon.`,
    sources: ["OpenAI", "Gemini"]
  });

}

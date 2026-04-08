module.exports = function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  const allowedOrigins = String(process.env.ALLOWED_EXTENSION_ORIGINS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  res.status(200).json({
    ok: true,
    hasGeminiKey: Boolean(process.env.GEMINI_API_KEY),
    model: process.env.GEMINI_MODEL || "gemini-2.5-flash",
    allowedOrigins,
    uptimeSeconds: Math.round(process.uptime()),
  });
};

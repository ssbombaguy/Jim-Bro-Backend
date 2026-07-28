const express = require("express");
const requireAuth = require("../middleware/auth");
const { quotaLimiter } = require("../middleware/rateLimit");

const router = express.Router();
router.use(quotaLimiter);

// same model the client already uses for plan generation (gemini.js) — a rolling alias avoids
// hardcoding a version Google later retires
const MODEL = "gemini-flash-latest";
const BASE_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

// the key lives only here, server-side — the chat feature is the one place a user could type
// arbitrary text and pull the key out via a crafted prompt/response, so unlike the plan-
// generation feature (which still calls Gemini directly from the client today) this one is
// never allowed to ship the key to the app bundle
function requireApiKey(res) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) res.status(500).json({ error: "Gemini API key not configured on the server" });
  return key;
}

function sanitizeMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter((m) => m && typeof m.text === "string" && m.text.trim() && (m.role === "user" || m.role === "model"))
    .map((m) => ({ role: m.role, parts: [{ text: m.text }] }));
}

router.post("/", requireAuth, async (req, res) => {
  const apiKey = requireApiKey(res);
  if (!apiKey) return;

  const contents = sanitizeMessages(req.body.messages);
  if (!contents.length) return res.status(400).json({ error: "messages is required" });

  // built client-side from the user's own profile/training log (same data the plan-generation
  // prompt already sends to Gemini) so this route stays a dumb proxy — it doesn't need to know
  // what a "split" or "profile" is, just forwards whatever persona/context the app hands it
  const system = typeof req.body.system === "string" ? req.body.system.slice(0, 4000) : "";

  const body = { contents };
  if (system) body.systemInstruction = { parts: [{ text: system }] };

  try {
    const r = await fetch(`${BASE_URL}?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(502).json({ error: data.error?.message || `Gemini request failed (${r.status})` });
    if (data.promptFeedback?.blockReason) {
      return res.status(400).json({ error: `Gemini blocked this request: ${data.promptFeedback.blockReason}` });
    }
    const candidate = data.candidates?.[0];
    if (candidate && candidate.finishReason && candidate.finishReason !== "STOP") {
      return res.status(400).json({ error: `Gemini stopped early: ${candidate.finishReason}` });
    }
    res.json({ text: candidate?.content?.parts?.[0]?.text ?? "" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal error" });
  }
});

module.exports = router;

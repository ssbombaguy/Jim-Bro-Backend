const express = require("express");
const pool = require("../db");
const requireAuth = require("../middleware/auth");
const requirePremium = require("../middleware/requirePremium");
const { quotaLimiter, lookupLimiter } = require("../middleware/rateLimit");

const router = express.Router();
// no router.use(quotaLimiter) here — the Gemini budget belongs to the one route that spends
// it (see rateLimit.js). The conversation-sync CRUD below is plain Postgres, rate-limited
// per-route by the loose anti-abuse limiter instead.

// rolling aliases avoid hardcoding a version Google later retires. The fallback exists for
// Google-side congestion: "this model is experiencing high demand" 503s are per-model
// capacity shedding (free-tier keys get shed first), and the lite tier runs on separate
// capacity that's rarely congested at the same moment — a slightly simpler reply beats
// surfacing an error to the user every time.
const MODEL = "gemini-flash-latest";
const FALLBACK_MODEL = "gemini-flash-lite-latest";
const geminiUrl = (model) => `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

async function callGemini(model, apiKey, body) {
  const r = await fetch(`${geminiUrl(model)}?key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  return { r, data };
}

const isOverloaded = (r) => r.status === 429 || r.status === 503;

// primary → brief pause → primary again → lite fallback. Kept server-side so both consumers
// of this proxy (and the /ai routes) heal identically without each client reimplementing it.
async function callGeminiResilient(apiKey, body) {
  let attempt = await callGemini(MODEL, apiKey, body);
  if (isOverloaded(attempt.r)) {
    await new Promise((resolve) => setTimeout(resolve, 1200));
    attempt = await callGemini(MODEL, apiKey, body);
  }
  if (isOverloaded(attempt.r)) attempt = await callGemini(FALLBACK_MODEL, apiKey, body);
  return attempt;
}

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

router.post("/", requireAuth, quotaLimiter, requirePremium("chat"), async (req, res) => {
  const apiKey = requireApiKey(res);
  if (!apiKey) return;

  const contents = sanitizeMessages(req.body.messages);
  if (!contents.length) return res.status(400).json({ error: "messages is required" });

  // built client-side from the user's own profile/training log (same data the plan-generation
  // prompt already sends to Gemini) so this route stays a dumb proxy — it doesn't need to know
  // what a "split" or "profile" is, just forwards whatever persona/context the app hands it.
  // Cap is generous, not tight: the client legitimately appends its full exercise-name grounding
  // list (every real exercise in every body part, not a capped sample — see exercisedb.js) plus
  // profile/injury/history context. Measured against the live catalog: ~1500 exercises across
  // all 10 body parts at ~32 chars each is ~48k characters for the list alone, ~54k with the
  // rest of the prompt on a full profile. The old 4000 cap (and a since-fixed 30000 one) both
  // silently truncated that list — and whatever came after it, including forbidden-exercise/
  // injury data — before Gemini ever saw it. Still bounded so a crafted request can't push an
  // unbounded bill through this route.
  const system = typeof req.body.system === "string" ? req.body.system.slice(0, 80000) : "";

  // lower than Gemini's default (~1.0) — this reply is grounded in a supplied exercise list
  // (see chat-modal.jsx's buildSystemPrompt) and needs to copy names from it verbatim, not
  // creatively rephrase them; still well above near-zero so replies don't read as robotic
  const body = { contents, generationConfig: { temperature: 0.4 } };
  if (system) body.systemInstruction = { parts: [{ text: system }] };

  try {
    const { r, data } = await callGeminiResilient(apiKey, body);
    // forward Gemini's real status (503 overloaded, 429 its own rate limit, 400 blocked, ...)
    // instead of collapsing everything to 502 — the client retries transient ones (429/5xx)
    // automatically and only surfaces an error for the rest, but it can't tell those apart
    // once every upstream failure looks identical.
    if (!r.ok) return res.status(r.status || 502).json({ error: data.error?.message || `Gemini request failed (${r.status})` });
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

// stored as-is (role/text/workout/added/candidates) — unlike sanitizeMessages above, this isn't
// shaped for Gemini's request format, it's just what gets persisted and read back by the client.
// `workout` (the parsed "add this to my splits" payload), `added`, and `candidates` (the
// "swap this exercise" suggestion cards) all ride along unvalidated — they're opaque UI state
// to this route, not something it needs to understand.
function sanitizeStoredMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter((m) => m && typeof m.text === "string" && (m.role === "user" || m.role === "model"))
    .map((m) => ({ role: m.role, text: m.text, workout: m.workout ?? null, added: !!m.added, candidates: m.candidates ?? null }));
}

router.post("/conversations", requireAuth, lookupLimiter, async (req, res) => {
  const { clientId, title, messages } = req.body;
  if (!clientId) return res.status(400).json({ error: "clientId is required" });

  try {
    const result = await pool.query(
      `INSERT INTO chat_conversations (user_id, client_id, title, messages)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, client_id)
       DO UPDATE SET title = $3, messages = $4, updated_at = now()
       RETURNING id, client_id, title, messages, updated_at`,
      [req.userId, clientId, title ?? null, JSON.stringify(sanitizeStoredMessages(messages))]
    );
    res.status(201).json({ conversation: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal error" });
  }
});

router.get("/conversations", requireAuth, lookupLimiter, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, client_id, title, messages, updated_at FROM chat_conversations
       WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 50`,
      [req.userId]
    );
    res.json({ conversations: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal error" });
  }
});

// same shape as DELETE /splits/:clientId and /workouts/:clientId — scoped to user_id so one
// account can't delete another's conversation by guessing its client id
router.delete("/conversations/:clientId", requireAuth, lookupLimiter, async (req, res) => {
  const { clientId } = req.params;
  if (!clientId) return res.status(400).json({ error: "clientId is required" });

  try {
    await pool.query(`DELETE FROM chat_conversations WHERE user_id = $1 AND client_id = $2`, [req.userId, clientId]);
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal error" });
  }
});

module.exports = router;

const express = require("express");
const rateLimit = require("express-rate-limit");

const router = express.Router();

// these endpoints run during signup (register-flow.jsx step 8), before an account or JWT
// exists, so they can't sit behind requireAuth the way /chat does. What makes an
// unauthenticated Gemini proxy acceptable here: the prompt is built entirely server-side
// from a few validated fields — a caller can only ever get "exercises to avoid for these
// injuries" out of it, never arbitrary generation, so the endpoint is worthless as a free
// general-purpose LLM. Remaining abuse (burning quota for fun) is bounded by a tight per-IP
// limit; keyed by IP, not user, since there is no user yet — a signup legitimately makes
// 1-3 of these calls total.
const anonLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "too many requests, try again later" },
});
router.use(anonLimiter);

// same rolling alias as routes/chat.js — avoids hardcoding a version Google later retires
const MODEL = "gemini-flash-latest";
const BASE_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

// the app's three UI languages — anything else falls back to English rather than letting a
// crafted "language" value inject free text into the prompt
const LANGUAGES = new Set(["English", "Georgian", "Russian"]);
const langOf = (v) => (LANGUAGES.has(v) ? v : "English");

// bounded free-text field: these are interpolated into the prompt, so they get a hard cap —
// enough for real profile notes, not enough to smuggle a whole replacement prompt through
const s = (v, max) => (typeof v === "string" ? v.slice(0, max).trim() : "");

// same call/error-forwarding shape as routes/chat.js: forward Gemini's real status so the
// client can tell transient failures (429/5xx, worth retrying) from permanent ones
async function proxyGemini(res, parts, generationConfig) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return res.status(500).json({ error: "Gemini API key not configured on the server" });
  try {
    const r = await fetch(`${BASE_URL}?key=${key}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts }], generationConfig }),
    });
    const data = await r.json().catch(() => ({}));
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
}

// ported verbatim from the app's old client-side lib/gemini.js (suggestForbiddenExercises) —
// the JSON parsing/retry stays client-side, this route just returns Gemini's raw text like
// /chat does. Moving the prompt here (not just the key) is the point: it's what pins this
// endpoint to one narrow job.
router.post("/forbidden-exercises", async (req, res) => {
  const issues = s(req.body.issues, 2000);
  if (!issues) return res.status(400).json({ error: "issues is required" });
  const sex = s(req.body.sex, 40);
  const goal = s(req.body.goal, 100);
  const healthNotes = s(req.body.healthNotes, 2000);
  const recentTraining = s(req.body.recentTraining, 4000);
  const age = Number.isFinite(req.body.age) ? req.body.age : null;
  const workoutsPerWeek = Number.isFinite(req.body.workoutsPerWeek) ? req.body.workoutsPerWeek : null;
  const lang = langOf(req.body.language);

  const prompt =
    `A gym-goer${sex ? `, ${sex}` : ""}, age ${age || "unknown"}, training goal "${goal}", working out ${workoutsPerWeek ?? "?"}x/week, ` +
    `has these injury concerns: ${issues}.` +
    (healthNotes ? ` Extra notes: ${healthNotes}.` : "") +
    (recentTraining ? ` Their recent training: ${recentTraining}. Flag any of these specifically if they stress a named injury.` : "") +
    " List up to 20 common gym exercises they should avoid or do with extra caution — only include ones " +
    "that clearly apply; it's fine to list fewer if that's all that clearly applies, don't pad the list, but don't " +
    "stop short either — be thorough and cover every common exercise that fits the criteria below, not just the obvious ones. " +
    "Only include an exercise if it specifically loads or stresses the named injured area — " +
    "(spinal: heavy axial loading or spinal flexion/extension/rotation under load; " +
    "knee: deep knee flexion or high shear/impact on the knee; " +
    "shoulder: overhead pressing or extreme end-range/behind-the-neck shoulder movement; " +
    "hip: deep hip flexion under load, heavy loaded hip extension/abduction, or high-impact single-leg loading; " +
    "ankle: forceful loaded dorsiflexion/plantarflexion, jumping or plyometric impact, or unstable single-leg balance work; " +
    "wrist: loaded wrist extension/flexion (e.g. front rack position, curls) or high-impact wrist loading (push-ups, planks); " +
    "elbow: repetitive loaded elbow flexion/extension (curls, extensions) or heavy pressing/pulling that loads the elbow joint; " +
    "neck: loaded neck flexion/extension/rotation, or extreme end-range neck loading (e.g. behind-the-neck press, heavy shrugs)). " +
    "Do not include an exercise just because it's generally heavy or advanced if it doesn't stress the stated injury. " +
    "For each exercise, give a short reason (under 8 words) tied to the specific injury. " +
    'Respond with ONLY a JSON array of objects like [{"name":"Barbell Squat","reason":"heavy axial spinal loading"}]. ' +
    `Keep "name" in English (it must match exercise database entries), but write "reason" in ${lang}. ` +
    "No markdown, no other text.";

  await proxyGemini(res, [{ text: prompt }], { temperature: 0.2 });
});

// the doctor's-note photo variant — same output contract, image instead of typed symptoms
router.post("/forbidden-exercises/from-image", async (req, res) => {
  const base64 = typeof req.body.base64 === "string" ? req.body.base64 : "";
  if (!base64) return res.status(400).json({ error: "base64 is required" });
  const mimeType = typeof req.body.mimeType === "string" && /^image\//.test(req.body.mimeType) ? req.body.mimeType : "image/jpeg";
  const lang = langOf(req.body.language);

  const prompt =
    "This image is a doctor's note or medical paper. Read any text in it (handwritten or printed) and extract the specific " +
    'gym exercises or movements it says to avoid or restrict — for example "leg press", "shoulder press", "squats with weights". ' +
    'For each, give a short reason (under 8 words) based on what the note says, or "per doctor note" if none is given. ' +
    'Respond with ONLY a JSON array of objects like [{"name":"Leg Press","reason":"per doctor note"}]. ' +
    `Keep "name" in English (it must match exercise database entries), but write "reason" in ${lang}. ` +
    "If the image doesn't contain such a list, respond with []. No markdown, no other text.";

  await proxyGemini(res, [{ text: prompt }, { inline_data: { mime_type: mimeType, data: base64 } }], { temperature: 0.1 });
});

module.exports = router;

// the one Gemini caller every proxy route shares (routes/chat.js, routes/ai.js) — so
// overload handling lives in exactly one place instead of each route reimplementing it.
//
// Rolling model aliases avoid hardcoding a version Google later retires. The fallback model
// exists for Google-side congestion: "this model is experiencing high demand" 503s are
// per-model capacity shedding (free-tier keys get shed first), and the lite tier runs on
// separate capacity that's rarely congested at the same moment — a slightly simpler reply
// beats surfacing an error to the user every time.
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

// primary → brief pause → primary again → lite fallback. Anything still failing after that
// is returned as-is for the route to forward with its real status.
async function callGeminiResilient(apiKey, body) {
  let attempt = await callGemini(MODEL, apiKey, body);
  if (isOverloaded(attempt.r)) {
    await new Promise((resolve) => setTimeout(resolve, 1200));
    attempt = await callGemini(MODEL, apiKey, body);
  }
  if (isOverloaded(attempt.r)) attempt = await callGemini(FALLBACK_MODEL, apiKey, body);
  return attempt;
}

module.exports = { callGeminiResilient };

const express = require("express");
const pool = require("../db");
const requireAuth = require("../middleware/auth");
const requirePremium = require("../middleware/requirePremium");
const { quotaLimiter } = require("../middleware/rateLimit");

const router = express.Router();
router.use(quotaLimiter);
const SPOONACULAR_BASE = "https://api.spoonacular.com";

// the key lives only here, server-side — the app never sees it, so it can't be pulled out
// of the client bundle and used to burn someone else's quota
function requireApiKey(res) {
  const key = process.env.SPOONACULAR_API_KEY;
  if (!key) res.status(500).json({ error: "Spoonacular API key not configured on the server" });
  return key;
}

async function spoonacularGet(path, params) {
  const url = `${SPOONACULAR_BASE}${path}?${new URLSearchParams(params).toString()}`;
  const res = await fetch(url);
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    const err = new Error(res.status === 429 ? "Spoonacular API rate limit exceeded" : data.message || `Spoonacular request failed (${res.status})`);
    err.status = res.status === 429 ? 429 : res.status >= 500 ? 502 : res.status;
    throw err;
  }
  return res.json();
}

// Spoonacular image URLs bake the size into the filename (e.g. ".../716429-312x231.jpg"),
// and complexSearch's default (312x231) is what the recipe detail screen stretches to a
// near-full-width hero image — swap in their largest fixed size instead so it isn't blurry.
// A no-op on anything that isn't shaped like a Spoonacular image URL.
function upsizeImage(url) {
  if (!url) return url;
  return url.replace(/-\d+x\d+(\.\w+)$/, "-636x393$1");
}

const GEMINI_MODEL = "gemini-flash-latest";
const GEMINI_BASE_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

// same key as chat.js's route — server-side only, these routes can take a photo/freeform
// text input same as chat can, so the key needs the same protection
function requireGeminiKey(res) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) res.status(500).json({ error: "Gemini API key not configured on the server" });
  return key;
}

// single-turn Gemini call with an optional image part, expecting a strict-JSON reply — shared
// by /estimate and /analyze-fridge below, neither of which is a conversation (no history), so
// this stays a plain prompt-in-JSON-out helper rather than chat.js's message-array shape
async function geminiJson(apiKey, prompt, image) {
  const parts = [{ text: prompt }];
  if (image?.base64) parts.push({ inline_data: { mime_type: image.mimeType || "image/jpeg", data: image.base64 } });
  const r = await fetch(`${GEMINI_BASE_URL}?key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents: [{ parts }], generationConfig: { temperature: 0.2 } }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(data.error?.message || `Gemini request failed (${r.status})`);
    err.status = 502;
    throw err;
  }
  if (data.promptFeedback?.blockReason) {
    const err = new Error(`Gemini blocked this request: ${data.promptFeedback.blockReason}`);
    err.status = 400;
    throw err;
  }
  const candidate = data.candidates?.[0];
  if (candidate && candidate.finishReason && candidate.finishReason !== "STOP") {
    const err = new Error(`Gemini stopped early: ${candidate.finishReason}`);
    err.status = 400;
    throw err;
  }
  const text = candidate?.content?.parts?.[0]?.text ?? "";
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) {
    const err = new Error("Gemini did not return a usable answer — try again");
    err.status = 502;
    throw err;
  }
  try {
    return JSON.parse(match[0]);
  } catch {
    const err = new Error("Gemini did not return a usable answer — try again");
    err.status = 502;
    throw err;
  }
}

// "what's this food" — a photo or a plain description in, a nutrition estimate out. The
// client shows this as an editable draft before it's ever written to daily_log (see
// useLogFood): a vision-model portion-size guess can be off by a lot, so it's a starting
// point to correct, never a silent write.
router.post("/estimate", requireAuth, requirePremium("meal-estimate"), async (req, res) => {
  const apiKey = requireGeminiKey(res);
  if (!apiKey) return;
  const { text, image } = req.body;
  if (!text?.trim() && !image?.base64) return res.status(400).json({ error: "text or image is required" });
  const prompt =
    "You are a nutrition estimator inside a fitness app. " +
    (image?.base64
      ? "Identify the food shown in this photo and estimate its nutrition for the visible portion."
      : `Estimate the nutrition for this food, as described by the user: "${text.trim().slice(0, 500)}".`) +
    " Give your best realistic estimate even if you're not fully certain — never refuse to answer just because " +
    "the portion size is ambiguous. Respond with ONLY JSON: " +
    '{"description":"short name of the food","calories":number,"protein":number,"carbs":number,"fat":number} ' +
    "(protein/carbs/fat in grams, calories for the whole visible/described portion). No markdown, no other text.";
  try {
    const result = await geminiJson(apiKey, prompt, image);
    res.json({
      description: String(result.description ?? "").slice(0, 200),
      calories: Math.max(0, Math.round(Number(result.calories) || 0)),
      protein: Math.max(0, Math.round(Number(result.protein) || 0)),
      carbs: Math.max(0, Math.round(Number(result.carbs) || 0)),
      fat: Math.max(0, Math.round(Number(result.fat) || 0)),
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// "what can I make with what's in my fridge" — a photo of the fridge/pantry in, a list of
// what Gemini can actually see plus a few dish ideas out. Freeform suggestions only (not
// matched against the recipe catalog/local_recipes) — deliberately simple, no "add to plan"
// action, just ideas to act on yourself
router.post("/analyze-fridge", requireAuth, requirePremium("fridge-analyze"), async (req, res) => {
  const apiKey = requireGeminiKey(res);
  if (!apiKey) return;
  const { image } = req.body;
  if (!image?.base64) return res.status(400).json({ error: "image is required" });
  const prompt =
    "You are a kitchen assistant inside a fitness/nutrition app. This photo shows the inside of a fridge or pantry. " +
    "Identify the visible food items/ingredients you can actually see — don't guess at items you can't make out. " +
    "Then suggest up to 3 simple meals or dishes that could reasonably be made mostly from these ingredients " +
    "(common staples like salt, oil, and basic spices can be assumed available even if not visible). Respond with " +
    'ONLY JSON: {"ingredients":["item1","item2"],"suggestions":[{"title":"Dish name","description":"one short ' +
    'sentence on what to make"}]}. No markdown, no other text.';
  try {
    const result = await geminiJson(apiKey, prompt, image);
    res.json({
      ingredients: Array.isArray(result.ingredients) ? result.ingredients.slice(0, 30).map(String) : [],
      suggestions: Array.isArray(result.suggestions)
        ? result.suggestions
            .slice(0, 3)
            .map((s) => ({ title: String(s?.title ?? "").slice(0, 100), description: String(s?.description ?? "").slice(0, 300) }))
        : [],
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

const USDA_BASE = "https://api.nal.usda.gov/fdc/v1";
// stable across food types, unlike nutrient names which vary in wording/casing between entries
const USDA_NUTRIENT_NUMBERS = { calories: "208", protein_g: "203", carbs_g: "205", fat_g: "204" };

function requireUsdaKey(res) {
  const key = process.env.USDA_API_KEY;
  if (!key) res.status(500).json({ error: "USDA API key not configured on the server" });
  return key;
}

function extractUsdaNutrients(foodNutrients) {
  const out = {};
  for (const [field, number] of Object.entries(USDA_NUTRIENT_NUMBERS)) {
    const match = foodNutrients?.find((n) => n.nutrientNumber === number);
    out[field] = match ? Math.round(match.value) : null;
  }
  return out;
}

// plain-ingredient lookup ("chicken breast", "banana") — Spoonacular's endpoints above are
// recipe/meal-plan focused and don't cover this. Free USDA government database, no paid tier.
router.get("/foods/search", requireAuth, async (req, res) => {
  const apiKey = requireUsdaKey(res);
  if (!apiKey) return;
  if (!req.query.query) return res.status(400).json({ error: "query is required" });
  try {
    const url = `${USDA_BASE}/foods/search?${new URLSearchParams({
      query: req.query.query,
      pageSize: "10",
      api_key: apiKey,
    })}`;
    const usdaRes = await fetch(url);
    if (!usdaRes.ok) {
      const status = usdaRes.status === 429 ? 429 : usdaRes.status >= 500 ? 502 : usdaRes.status;
      return res.status(status).json({ error: "USDA request failed" });
    }
    const data = await usdaRes.json();
    const foods = (data.foods || []).map((f) => ({
      fdcId: f.fdcId,
      description: f.description,
      servingSize: f.servingSize ?? null,
      servingSizeUnit: f.servingSizeUnit ?? null,
      ...extractUsdaNutrients(f.foodNutrients),
    }));
    res.json({ foods });
  } catch {
    res.status(500).json({ error: "internal error" });
  }
});

// packaged/branded product lookup by barcode — Open Food Facts is free, crowd-sourced, no
// API key, and covers local Georgian packaged products far better than any commercial DB
router.get("/foods/barcode/:code", requireAuth, async (req, res) => {
  try {
    const offRes = await fetch(`https://world.openfoodfacts.org/api/v2/product/${req.params.code}.json`);
    if (!offRes.ok) return res.status(502).json({ error: "Open Food Facts request failed" });
    const data = await offRes.json();
    if (data.status !== 1 || !data.product) return res.status(404).json({ error: "product not found" });
    const p = data.product;
    const n = p.nutriments || {};
    res.json({
      barcode: req.params.code,
      name: p.product_name || p.generic_name || null,
      brand: p.brands || null,
      image: p.image_url || null,
      servingSize: p.serving_size || null,
      calories: n["energy-kcal_100g"] ?? null,
      protein_g: n.proteins_100g ?? null,
      carbs_g: n.carbohydrates_100g ?? null,
      fat_g: n.fat_100g ?? null,
    });
  } catch {
    res.status(500).json({ error: "internal error" });
  }
});

router.get("/meal-plan", requireAuth, requirePremium("meal-plan"), async (req, res) => {
  const apiKey = requireApiKey(res);
  if (!apiKey) return;
  try {
    const params = { apiKey, timeFrame: "day", targetCalories: String(req.query.calories || 2000) };
    if (req.query.diet) params.diet = req.query.diet;
    const data = await spoonacularGet("/mealplanner/generate", params);
    const meals = data.meals || [];
    const nutrients = data.nutrients || {};
    // mealplanner/generate has no cuisine param at all (unlike complexSearch below), so the
    // generated 3 meals are always generic/Western. Tack on one real Georgian dish as a bonus
    // regional item instead — light (snack/dessert-sized) so it doesn't blow the day's calorie
    // target, and added rather than swapped in for a generated meal so the math stays exact:
    // Spoonacular's per-meal calorie split isn't in this response, only the day's total, so
    // there's nothing reliable to subtract if a slot were replaced instead.
    const local = (await pool.query("SELECT * FROM local_recipes WHERE type IN ('snack', 'dessert') ORDER BY random() LIMIT 1")).rows[0];
    if (local) {
      meals.push({ id: `local-${local.id}`, title: local.title, readyInMinutes: 15, servings: local.servings });
      nutrients.calories = (nutrients.calories || 0) + (local.calories || 0);
      nutrients.protein = (nutrients.protein || 0) + Number(local.protein_g || 0);
      nutrients.carbohydrates = (nutrients.carbohydrates || 0) + Number(local.carbs_g || 0);
      nutrients.fat = (nutrients.fat || 0) + Number(local.fat_g || 0);
    }
    res.json({ meals, nutrients });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// shapes a local_recipes row to look like a Spoonacular recipe object so the client can
// render both in the same list without knowing which source a result came from
function toSpoonacularShape(row) {
  return {
    id: `local-${row.id}`,
    title: row.title,
    image: row.image_url,
    servings: row.servings,
    summary: row.instructions,
    ingredients: row.ingredients,
    nutrition: {
      nutrients: [
        { name: "Calories", amount: row.calories, unit: "kcal" },
        { name: "Protein", amount: row.protein_g, unit: "g" },
        { name: "Carbohydrates", amount: row.carbs_g, unit: "g" },
        { name: "Fat", amount: row.fat_g, unit: "g" },
      ],
    },
  };
}

router.get("/recipes/search", requireAuth, async (req, res) => {
  const query = req.query.query;
  const offset = Number(req.query.offset) || 0;

  // only on the first page — otherwise these would repeat on every "load more"
  let local = [];
  if (offset === 0) {
    if (query) {
      local = (await pool.query("SELECT * FROM local_recipes WHERE title ILIKE $1 ORDER BY title", [`%${query}%`])).rows;
    } else if (req.query.type) {
      // no search text yet — matches by category tab so these surface in default browsing
      // too, not just when someone already knows to search for a dish by name
      local = (await pool.query("SELECT * FROM local_recipes WHERE type = $1 ORDER BY title LIMIT 5", [req.query.type])).rows;
    }
  }

  const apiKey = requireApiKey(res);
  if (!apiKey) return;
  try {
    const params = {
      apiKey,
      addRecipeNutrition: "true",
      addRecipeInformation: "true",
      number: "10",
      offset: String(req.query.offset || 0),
    };
    if (req.query.type) params.type = req.query.type;
    if (query) params.query = query;
    // no native Georgian tag in Spoonacular's cuisine list — Eastern European/Mediterranean is
    // the closest real match, so at least the generic API results lean regional instead of
    // defaulting to generically American/Western. Only applied to a plain browse/category tab,
    // not a specific search: a named-dish query (e.g. "pad thai") should still find it, and
    // "OR" cuisine matching wouldn't actually narrow anything there anyway.
    if (!query) params.cuisine = "Eastern European,Mediterranean";
    // instructionsRequired drops the stub/incomplete entries Spoonacular's index otherwise
    // includes (no real steps, sometimes no image); sort=popularity biases toward recipes
    // people actually recognize and cook instead of an obscure long-tail match
    params.instructionsRequired = "true";
    params.sort = "popularity";
    const data = await spoonacularGet("/recipes/complexSearch", params);
    for (const r of data.results || []) r.image = upsizeImage(r.image);
    data.results = [...local.map(toSpoonacularShape), ...(data.results || [])];
    res.json(data);
  } catch (err) {
    if (local.length) return res.json({ results: local.map(toSpoonacularShape), totalResults: local.length });
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.get("/recipes/:id", requireAuth, async (req, res) => {
  if (req.params.id.startsWith("local-")) {
    const result = await pool.query("SELECT * FROM local_recipes WHERE id = $1", [req.params.id.slice(6)]);
    if (!result.rows[0]) return res.status(404).json({ error: "not found" });
    return res.json(toSpoonacularShape(result.rows[0]));
  }
  const apiKey = requireApiKey(res);
  if (!apiKey) return;
  try {
    const info = await spoonacularGet(`/recipes/${req.params.id}/information`, { apiKey, includeNutrition: "false" });
    info.image = upsizeImage(info.image);
    res.json(info);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.post("/meal-plans", requireAuth, async (req, res) => {
  const { targetCalories, targetProtein, dietPreference, meals, nutrients } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO meal_plans (user_id, target_calories, target_protein, diet, meals, nutrients)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, target_calories, target_protein, diet, meals, nutrients, created_at`,
      [
        req.userId,
        targetCalories ?? null,
        targetProtein ?? null,
        dietPreference ?? null,
        JSON.stringify(meals ?? []),
        JSON.stringify(nutrients ?? {}),
      ]
    );
    res.status(201).json({ plan: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal error" });
  }
});

router.get("/meal-plans", requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, target_calories, target_protein, diet, meals, nutrients, created_at
       FROM meal_plans WHERE user_id = $1 ORDER BY created_at DESC LIMIT 10`,
      [req.userId]
    );
    res.json({ plans: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal error" });
  }
});

module.exports = router;

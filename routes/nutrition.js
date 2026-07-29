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
    res.json({ meals: data.meals || [], nutrients: data.nutrients || {} });
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
  const local = query
    ? (await pool.query("SELECT * FROM local_recipes WHERE title ILIKE $1 ORDER BY title", [`%${query}%`])).rows
    : [];

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
    const data = await spoonacularGet("/recipes/complexSearch", params);
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
    res.json(await spoonacularGet(`/recipes/${req.params.id}/information`, { apiKey, includeNutrition: "false" }));
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

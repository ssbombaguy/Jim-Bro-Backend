const express = require("express");
const pool = require("../db");
const requireAuth = require("../middleware/auth");

const router = express.Router();
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

router.get("/meal-plan", requireAuth, async (req, res) => {
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

router.get("/recipes/search", requireAuth, async (req, res) => {
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
    if (req.query.query) params.query = req.query.query;
    res.json(await spoonacularGet("/recipes/complexSearch", params));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.get("/recipes/:id", requireAuth, async (req, res) => {
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

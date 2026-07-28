const express = require("express");
const pool = require("../db");
const requireAuth = require("../middleware/auth");

const router = express.Router();

const ADHERENCE_VALUES = new Set(["full", "partial", "none"]);

function sanitizeAdherence(adherence) {
  return ADHERENCE_VALUES.has(adherence) ? adherence : null;
}

function sanitizeSets(sets) {
  if (!Array.isArray(sets)) return [];
  return sets
    .filter((s) => s && typeof s.exercise_name === "string" && Number.isFinite(s.weight_kg) && Number.isFinite(s.reps) && s.weight_kg >= 0 && s.reps > 0)
    .map((s) => ({
      exercise_name: s.exercise_name,
      weight_kg: s.weight_kg,
      reps: s.reps,
      // carried through so a merge on another device can rebuild the exercise correctly
      // instead of defaulting every restored exercise to plain reps
      unit: typeof s.unit === "string" ? s.unit : undefined,
      bodyweight: s.bodyweight ? true : undefined,
      pool_length_m: Number.isFinite(s.pool_length_m) ? s.pool_length_m : undefined,
    }));
}

router.post("/", requireAuth, async (req, res) => {
  const { clientId, date, splitName, adherence, sets } = req.body;

  if (!clientId || !date || !splitName) {
    return res.status(400).json({ error: "clientId, date and splitName are required" });
  }

  try {
    const result = await pool.query(
      `INSERT INTO workout_logs (user_id, client_id, date, split_name, adherence, sets)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (user_id, client_id)
       DO UPDATE SET date = $3, split_name = $4, adherence = $5, sets = $6, updated_at = now()
       RETURNING id, client_id, date, split_name, adherence, sets, updated_at`,
      [req.userId, clientId, date, splitName, sanitizeAdherence(adherence), JSON.stringify(sanitizeSets(sets))]
    );
    res.status(201).json({ workout: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal error" });
  }
});

router.delete("/:clientId", requireAuth, async (req, res) => {
  const { clientId } = req.params;
  if (!clientId) {
    return res.status(400).json({ error: "clientId is required" });
  }

  try {
    await pool.query(`DELETE FROM workout_logs WHERE user_id = $1 AND client_id = $2`, [req.userId, clientId]);
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal error" });
  }
});

router.get("/", requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, client_id, date, split_name, adherence, sets, updated_at FROM workout_logs
       WHERE user_id = $1 ORDER BY date DESC, id DESC LIMIT 100`,
      [req.userId]
    );
    res.json({ workouts: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal error" });
  }
});

module.exports = router;

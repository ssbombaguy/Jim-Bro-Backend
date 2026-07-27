const express = require("express");
const pool = require("../db");
const requireAuth = require("../middleware/auth");

const router = express.Router();

// best-effort mirror of a split's schedule, called from the same places gym.js already syncs
// workouts — lets the missed-workout job know what's scheduled without touching the device
router.post("/", requireAuth, async (req, res) => {
  const { clientId, name, weekdays, defaultTime, defaultEndTime } = req.body;
  if (!clientId || !name) {
    return res.status(400).json({ error: "clientId and name are required" });
  }

  try {
    await pool.query(
      `INSERT INTO splits (user_id, client_id, name, weekdays, default_time, default_end_time)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (user_id, client_id)
       DO UPDATE SET name = $3, weekdays = $4, default_time = $5, default_end_time = $6, updated_at = now()`,
      [req.userId, clientId, name, JSON.stringify(Array.isArray(weekdays) ? weekdays : []), defaultTime || null, defaultEndTime || null]
    );
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal error" });
  }
});

// the counterpart to POST /: lets a device that doesn't have a split locally (reinstall, or
// mergeHistory recreating one from a workout_logs row) find the original by name and reuse its
// client_id/schedule instead of minting a disconnected duplicate
router.get("/", requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT client_id, name, weekdays, default_time, default_end_time FROM splits WHERE user_id = $1`,
      [req.userId]
    );
    res.json({ splits: result.rows });
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
    await pool.query(`DELETE FROM splits WHERE user_id = $1 AND client_id = $2`, [req.userId, clientId]);
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal error" });
  }
});

module.exports = router;

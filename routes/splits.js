const express = require("express");
const pool = require("../db");
const requireAuth = require("../middleware/auth");

const router = express.Router();

// best-effort mirror of a split's schedule, called from the same places gym.js already syncs
// workouts — lets the missed-workout job know what's scheduled without touching the device
router.post("/", requireAuth, async (req, res) => {
  const { localId, name, weekdays, defaultTime, defaultEndTime } = req.body;
  if (!Number.isFinite(localId) || !name) {
    return res.status(400).json({ error: "localId and name are required" });
  }

  try {
    await pool.query(
      `INSERT INTO splits (user_id, local_id, name, weekdays, default_time, default_end_time)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (user_id, local_id)
       DO UPDATE SET name = $3, weekdays = $4, default_time = $5, default_end_time = $6, updated_at = now()`,
      [req.userId, localId, name, JSON.stringify(Array.isArray(weekdays) ? weekdays : []), defaultTime || null, defaultEndTime || null]
    );
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal error" });
  }
});

router.delete("/:localId", requireAuth, async (req, res) => {
  const localId = Number(req.params.localId);
  if (!Number.isFinite(localId)) {
    return res.status(400).json({ error: "localId must be a number" });
  }

  try {
    await pool.query(`DELETE FROM splits WHERE user_id = $1 AND local_id = $2`, [req.userId, localId]);
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal error" });
  }
});

module.exports = router;

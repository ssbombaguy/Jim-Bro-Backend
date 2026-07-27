const express = require("express");
const pool = require("../db");
const requireAuth = require("../middleware/auth");

const router = express.Router();

// client evaluates achievement triggers locally (RPE/swim/timing data never leaves the
// device) and just reports which ones unlocked, so this is a dumb persist-and-list sync
router.post("/", requireAuth, async (req, res) => {
  const { achievementId } = req.body;
  if (!achievementId) {
    return res.status(400).json({ error: "achievementId is required" });
  }

  try {
    await pool.query(
      `INSERT INTO user_achievements (user_id, achievement_id)
       VALUES ($1, $2)
       ON CONFLICT (user_id, achievement_id) DO NOTHING`,
      [req.userId, achievementId]
    );
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal error" });
  }
});

router.get("/", requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT achievement_id, unlocked_at FROM user_achievements WHERE user_id = $1`,
      [req.userId]
    );
    res.json({ achievements: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal error" });
  }
});

module.exports = router;

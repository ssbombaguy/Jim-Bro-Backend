const express = require("express");
const pool = require("../db");
const requireAuth = require("../middleware/auth");

const router = express.Router();

router.post("/", requireAuth, async (req, res) => {
  const { token, platform, timezone } = req.body;
  if (!token || typeof token !== "string") {
    return res.status(400).json({ error: "token is required" });
  }

  try {
    if (timezone) {
      await pool.query(`UPDATE users SET timezone = $1 WHERE id = $2`, [timezone, req.userId]);
    }
    await pool.query(
      `INSERT INTO push_tokens (user_id, token, platform)
       VALUES ($1, $2, $3)
       ON CONFLICT (token) DO UPDATE SET user_id = $1, platform = $3, updated_at = now()`,
      [req.userId, token, platform || null]
    );
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal error" });
  }
});

module.exports = router;

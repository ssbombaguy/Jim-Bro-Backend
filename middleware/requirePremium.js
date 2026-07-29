const pool = require("../db");

const FREE_LIMIT = 3; // free calls per feature per calendar month

// gates a route behind users.plan = 'premium', but lets free users through up to FREE_LIMIT
// times a month per feature first. Counts attempts, not successes — simplest thing that works,
// upgrade to counting only on success if a flaky downstream API starts burning users' quota.
function requirePremium(feature) {
  return async function (req, res, next) {
    const { rows } = await pool.query("SELECT plan FROM users WHERE id = $1", [req.userId]);
    if (rows[0]?.plan === "premium") return next();

    const period = new Date();
    period.setDate(1);
    const periodStart = period.toISOString().slice(0, 10);

    const usage = await pool.query(
      `INSERT INTO feature_usage (user_id, feature, period_start, count)
       VALUES ($1, $2, $3, 1)
       ON CONFLICT (user_id, feature, period_start)
       DO UPDATE SET count = feature_usage.count + 1
       RETURNING count`,
      [req.userId, feature, periodStart]
    );

    if (usage.rows[0].count > FREE_LIMIT) {
      return res.status(403).json({ error: "Free usage limit reached for this month", freeLimit: FREE_LIMIT });
    }
    next();
  };
}

module.exports = requirePremium;

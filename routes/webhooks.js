const express = require("express");
const pool = require("../db");

const router = express.Router();

// events that mean the subscriber currently has the entitlement
const GRANTS = new Set([
  "INITIAL_PURCHASE",
  "RENEWAL",
  "UNCANCELLATION",
  "PRODUCT_CHANGE",
  "NON_RENEWING_PURCHASE",
  "TRANSFER",
]);
// only a real expiration should pull it back — CANCELLATION just turns off
// auto-renew and BILLING_ISSUE keeps entitlement through RevenueCat's grace period
const REVOKES = new Set(["EXPIRATION"]);

// RevenueCat calls this on every purchase/renewal/expiration; app_user_id is whatever
// the client passed to Purchases.configure(), which is our own users.id as a string
router.post("/revenuecat", express.json(), async (req, res) => {
  if (req.headers.authorization !== process.env.REVENUECAT_WEBHOOK_SECRET) {
    return res.status(401).end();
  }

  const event = req.body?.event || {};
  const userId = Number(event.app_user_id);
  if (!Number.isInteger(userId)) return res.status(200).end(); // anonymous/test id, nothing to do

  if (GRANTS.has(event.type)) {
    await pool.query("UPDATE users SET plan = 'premium' WHERE id = $1", [userId]);
  } else if (REVOKES.has(event.type)) {
    await pool.query("UPDATE users SET plan = 'free' WHERE id = $1", [userId]);
  }

  res.status(200).end();
});

module.exports = router;

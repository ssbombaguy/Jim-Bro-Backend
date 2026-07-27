const rateLimit = require("express-rate-limit");

// shared by any route that spends a scarce resource per request (a third-party API quota,
// a paid AI call) — one JWT shouldn't be able to exhaust it for every other user
const quotaLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "too many requests, try again later" },
});

module.exports = { quotaLimiter };

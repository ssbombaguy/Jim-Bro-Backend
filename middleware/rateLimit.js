const rateLimit = require("express-rate-limit");

// shared by any route that spends a scarce/paid resource per request (Gemini, Spoonacular) —
// one JWT shouldn't be able to exhaust it for every other user
const quotaLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "too many requests, try again later" },
});

// barcode/ingredient lookups (Open Food Facts, USDA) are free and have no per-call cost to
// protect — this only exists to stop outright abuse, not to ration a scarce budget, so it's
// far looser than quotaLimiter and, being a separate instance, doesn't share its counter
const lookupLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "too many requests, try again later" },
});

module.exports = { quotaLimiter, lookupLimiter };

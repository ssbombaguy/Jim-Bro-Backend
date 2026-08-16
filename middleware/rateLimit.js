const rateLimit = require("express-rate-limit");

// both limiters sit AFTER requireAuth on every route that uses them, so req.userId always
// exists — keying on it instead of the default req.ip matters on mobile: carrier NAT puts
// many users behind one shared IP, so IP keying let one busy user (or just a busy gym's
// wifi) exhaust the budget for everyone else on that address
const keyByUser = (req) => String(req.userId);

// shared by any route that spends a scarce/paid resource per request (Gemini, Spoonacular) —
// one account shouldn't be able to exhaust it for every other user. Attach this to exactly
// the route handler that spends the money, never router.use(...): mounted router-wide on
// /chat it also counted every conversation-sync save (~3-4 per chat turn, plus a full resync
// on app resume), which drained the whole 15-minute budget from normal use and 429'd real
// chat messages for premium users who'd paid to not hit limits
const quotaLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: keyByUser,
  message: { error: "too many requests, try again later" },
});

// cheap DB/free-API routes (conversation sync, barcode/ingredient lookups) — this only
// exists to stop outright abuse, not to ration a scarce budget, so it's far looser than
// quotaLimiter and, being a separate instance, doesn't share its counter
const lookupLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 300,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: keyByUser,
  message: { error: "too many requests, try again later" },
});

module.exports = { quotaLimiter, lookupLimiter };

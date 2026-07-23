const express = require("express");
const pool = require("../db");

const router = express.Router();

// called by an external scheduler (GitHub Actions cron), not a logged-in user — a shared
// secret instead of requireAuth keeps random public hits from spamming everyone's phone
function requireCronSecret(req, res, next) {
  if (!process.env.CRON_SECRET || req.headers["x-cron-secret"] !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
}

// "now" as this user would read a clock, from an IANA zone name instead of device local time —
// same "treat the date part as a stable calendar key" trick the client's weekdayOf() uses
function nowInTimezone(timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const get = (type) => parts.find((p) => p.type === type).value;
  const date = `${get("year")}-${get("month")}-${get("day")}`;
  return {
    date,
    minutesSinceMidnight: Number(get("hour")) * 60 + Number(get("minute")),
    weekday: new Date(`${date}T00:00:00Z`).getUTCDay(),
  };
}

function toMinutes(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

// matches the client's sessionNeedsCheckIn default buffer, so a server push and the in-app
// check-in prompt fire around the same time past the planned window
const GRACE_MINUTES = 120;

async function sendExpoPush(messages) {
  for (let i = 0; i < messages.length; i += 100) {
    const chunk = messages.slice(i, i + 100);
    await fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(chunk),
    }).catch((err) => console.error("expo push send failed", err));
  }
}

// finds splits scheduled for "today" (per the user's own timezone) whose window+grace has
// passed with nothing logged, and pushes a reminder — at most once per split per date.
//
// ponytail: "did they work out" is approximated by a workout_logs row existing for that
// user/date/split_name, not by the session's actual adherence value (adherence never leaves
// the device today). A user who opened the app and explicitly marked the session "skipped"
// can still get this push. Add a synced adherence field if that false positive matters.
router.post("/check-missed-workouts", requireCronSecret, async (req, res) => {
  try {
    const { rows: splits } = await pool.query(
      `SELECT s.id AS split_id, s.user_id, s.name, s.weekdays, s.default_time, s.default_end_time,
              u.timezone, array_agg(DISTINCT pt.token) AS tokens
       FROM splits s
       JOIN users u ON u.id = s.user_id
       JOIN push_tokens pt ON pt.user_id = u.id
       WHERE s.default_time IS NOT NULL OR s.default_end_time IS NOT NULL
       GROUP BY s.id, u.id`
    );

    const messages = [];
    for (const split of splits) {
      const weekdays = split.weekdays || [];
      const { date, minutesSinceMidnight, weekday } = nowInTimezone(split.timezone || "UTC");
      if (!weekdays.includes(weekday)) continue;

      const windowEnd = toMinutes(split.default_end_time || split.default_time) + GRACE_MINUTES;
      if (minutesSinceMidnight < windowEnd) continue;

      const { rows: logged } = await pool.query(
        `SELECT 1 FROM workout_logs WHERE user_id = $1 AND date = $2 AND split_name = $3`,
        [split.user_id, date, split.name]
      );
      if (logged.length) continue;

      const { rows: claimed } = await pool.query(
        `INSERT INTO missed_workout_notifications (user_id, split_id, date)
         VALUES ($1, $2, $3) ON CONFLICT (user_id, split_id, date) DO NOTHING RETURNING id`,
        [split.user_id, split.split_id, date]
      );
      if (!claimed.length) continue; // another run already notified for this split/date

      for (const token of split.tokens) {
        messages.push({
          to: token,
          sound: "default",
          title: "Missed a workout?",
          body: `Looks like you haven't logged ${split.name} today.`,
          data: { type: "missed_workout", splitId: split.split_id, date },
        });
      }
    }

    await sendExpoPush(messages);
    res.json({ splitsChecked: splits.length, notified: messages.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal error" });
  }
});

module.exports = router;

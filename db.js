require("dotenv").config();
const { Pool, types } = require("pg");

// pg defaults to parsing DATE columns into JS Date objects, which JSON.stringify then
// serializes as a full UTC-midnight timestamp (e.g. "2026-07-23T00:00:00.000Z") instead of
// the plain "2026-07-23" every DATE column actually holds — keep it as the raw string.
types.setTypeParser(types.builtins.DATE, (v) => v);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

module.exports = pool;

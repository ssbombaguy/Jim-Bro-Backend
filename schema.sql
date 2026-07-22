CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT,
  google_id TEXT UNIQUE,
  name TEXT NOT NULL,
  age INTEGER,
  weight NUMERIC,
  height_cm NUMERIC,
  goal TEXT,
  has_spinal_issue BOOLEAN NOT NULL DEFAULT FALSE,
  has_knee_issue BOOLEAN NOT NULL DEFAULT FALSE,
  has_shoulder_issue BOOLEAN NOT NULL DEFAULT FALSE,
  health_notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT;

ALTER TABLE users ADD COLUMN IF NOT EXISTS injuries JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE users ADD COLUMN IF NOT EXISTS sex TEXT;

ALTER TABLE users ADD COLUMN IF NOT EXISTS birth_date DATE;

ALTER TABLE users ADD COLUMN IF NOT EXISTS workouts_per_week INTEGER;

ALTER TABLE users ADD COLUMN IF NOT EXISTS forbidden_exercises JSONB NOT NULL DEFAULT '[]'::jsonb;

-- one-time: fold the old fixed spinal/knee/shoulder flags into the injuries list, then drop them
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'has_spinal_issue') THEN
    UPDATE users SET injuries = (
      SELECT COALESCE(jsonb_agg(issue), '[]'::jsonb) FROM (
        SELECT 'Spinal issues' AS issue WHERE has_spinal_issue
        UNION ALL SELECT 'Knee issues' WHERE has_knee_issue
        UNION ALL SELECT 'Shoulder issues' WHERE has_shoulder_issue
      ) t
    ) WHERE injuries = '[]'::jsonb;

    ALTER TABLE users DROP COLUMN has_spinal_issue;
    ALTER TABLE users DROP COLUMN has_knee_issue;
    ALTER TABLE users DROP COLUMN has_shoulder_issue;
  END IF;
END $$;

-- one row per local workout session, upserted by (user_id, local_id) every time a set is
-- logged; local_id is the device's SQLite sessions.id, not globally unique on its own
CREATE TABLE IF NOT EXISTS workout_logs (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  local_id INTEGER NOT NULL,
  date DATE NOT NULL,
  split_name TEXT NOT NULL,
  sets JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, local_id)
);

CREATE INDEX IF NOT EXISTS idx_workout_logs_user_date ON workout_logs (user_id, date DESC);

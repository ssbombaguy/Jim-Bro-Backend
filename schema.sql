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

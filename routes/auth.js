const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const rateLimit = require("express-rate-limit");
const pool = require("../db");
const requireAuth = require("../middleware/auth");

const router = express.Router();

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "too many attempts, try again later" },
});

const USER_COLUMNS =
  "id, email, name, age, weight, height_cm, goal, sex, injuries, health_notes, avatar_url, created_at";

const AVATAR_DIR = path.join(__dirname, "..", "uploads", "avatars");
fs.mkdirSync(AVATAR_DIR, { recursive: true });

const AVATAR_MIME_EXT = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp" };

const avatarUpload = multer({
  storage: multer.diskStorage({
    destination: AVATAR_DIR,
    // extension comes from the validated mimetype, never the client-supplied
    // filename, so an attacker can't smuggle a .html/.svg file onto the server
    filename: (req, file, cb) => cb(null, `${req.userId}-${Date.now()}${AVATAR_MIME_EXT[file.mimetype]}`),
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, file.mimetype in AVATAR_MIME_EXT),
});

function signToken(userId) {
  return jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: "30d" });
}

router.post("/register", authLimiter, async (req, res) => {
  const {
    email,
    password,
    name,
    age,
    weight,
    heightCm,
    goal,
    sex,
    injuries,
    healthNotes,
  } = req.body;

  if (!email || !password || !name) {
    return res.status(400).json({ error: "email, password and name are required" });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: "password must be at least 8 characters" });
  }

  try {
    const passwordHash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      `INSERT INTO users
        (email, password_hash, name, age, weight, height_cm, goal, sex, injuries, health_notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING ${USER_COLUMNS}`,
      [
        email.toLowerCase().trim(),
        passwordHash,
        name,
        age ?? null,
        weight ?? null,
        heightCm ?? null,
        goal ?? null,
        sex ?? null,
        JSON.stringify(Array.isArray(injuries) ? injuries : []),
        healthNotes ?? null,
      ]
    );

    const user = result.rows[0];
    res.status(201).json({ token: signToken(user.id), user });
  } catch (err) {
    if (err.code === "23505") {
      return res.status(409).json({ error: "email already registered" });
    }
    console.error(err);
    res.status(500).json({ error: "internal error" });
  }
});

router.post("/login", authLimiter, async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: "email and password are required" });
  }

  try {
    const result = await pool.query(
      "SELECT * FROM users WHERE email = $1",
      [email.toLowerCase().trim()]
    );
    const user = result.rows[0];
    if (!user || !user.password_hash) {
      return res.status(401).json({ error: "invalid email or password" });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: "invalid email or password" });
    }

    delete user.password_hash;
    res.json({ token: signToken(user.id), user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal error" });
  }
});

router.get("/me", requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT ${USER_COLUMNS} FROM users WHERE id = $1`,
      [req.userId]
    );
    if (!result.rows[0]) return res.status(404).json({ error: "user not found" });
    res.json({ user: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal error" });
  }
});

router.post("/me/avatar", requireAuth, avatarUpload.single("avatar"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "avatar file is required" });

  try {
    const avatarUrl = `/uploads/avatars/${req.file.filename}`;
    const result = await pool.query(
      `UPDATE users SET avatar_url = $1 WHERE id = $2 RETURNING ${USER_COLUMNS}`,
      [avatarUrl, req.userId]
    );
    res.json({ user: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal error" });
  }
});

module.exports = router;

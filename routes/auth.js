const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const pool = require("../db");
const requireAuth = require("../middleware/auth");

const router = express.Router();

const USER_COLUMNS =
  "id, email, name, age, weight, height_cm, goal, has_spinal_issue, has_knee_issue, has_shoulder_issue, health_notes, avatar_url, created_at";

const AVATAR_DIR = path.join(__dirname, "..", "uploads", "avatars");
fs.mkdirSync(AVATAR_DIR, { recursive: true });

const avatarUpload = multer({
  storage: multer.diskStorage({
    destination: AVATAR_DIR,
    filename: (req, file, cb) =>
      cb(null, `${req.userId}-${Date.now()}${path.extname(file.originalname).toLowerCase()}`),
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^image\/(jpe?g|png|webp)$/.test(file.mimetype)),
});

function signToken(userId) {
  return jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: "30d" });
}

router.post("/register", async (req, res) => {
  const {
    email,
    password,
    name,
    age,
    weight,
    heightCm,
    goal,
    hasSpinalIssue,
    hasKneeIssue,
    hasShoulderIssue,
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
        (email, password_hash, name, age, weight, height_cm, goal, has_spinal_issue, has_knee_issue, has_shoulder_issue, health_notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING ${USER_COLUMNS}`,
      [
        email.toLowerCase().trim(),
        passwordHash,
        name,
        age ?? null,
        weight ?? null,
        heightCm ?? null,
        goal ?? null,
        !!hasSpinalIssue,
        !!hasKneeIssue,
        !!hasShoulderIssue,
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

router.post("/login", async (req, res) => {
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

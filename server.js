require("dotenv").config();
const express = require("express");
const cors = require("cors");
const authRoutes = require("./routes/auth");
const workoutsRoutes = require("./routes/workouts");
const nutritionRoutes = require("./routes/nutrition");
const splitsRoutes = require("./routes/splits");
const pushTokensRoutes = require("./routes/push-tokens");
const jobsRoutes = require("./routes/jobs");
const achievementsRoutes = require("./routes/achievements");
const chatRoutes = require("./routes/chat");
const webhooksRoutes = require("./routes/webhooks");

const app = express();
app.set("trust proxy", 1);
app.use(cors());
app.use(express.json());

app.get("/health", (req, res) => res.json({ ok: true }));
app.use("/auth", authRoutes);
app.use("/workouts", workoutsRoutes);
app.use("/nutrition", nutritionRoutes);
app.use("/splits", splitsRoutes);
app.use("/push-tokens", pushTokensRoutes);
app.use("/jobs", jobsRoutes);
app.use("/achievements", achievementsRoutes);
app.use("/chat", chatRoutes);
app.use("/webhooks", webhooksRoutes);

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`jim-bro-backend listening on :${port}`));

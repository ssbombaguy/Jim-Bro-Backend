require("dotenv").config();
const express = require("express");
const cors = require("cors");
const authRoutes = require("./routes/auth");

const app = express();
app.set("trust proxy", 1);
app.use(cors());
app.use(express.json());
app.use("/uploads", express.static("uploads"));

app.get("/health", (req, res) => res.json({ ok: true }));
app.use("/auth", authRoutes);

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`jim-bro-backend listening on :${port}`));

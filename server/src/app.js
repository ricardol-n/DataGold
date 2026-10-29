
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const authRoutes = require("./routes/authRoutes");
const walletRoutes = require("./routes/walletRoutes");
const dataRoutes = require("./routes/dataRoutes");
const dataPurchaseRoutes = require("./routes/dataPurchaseRoutes");
const paybetaWebhookRoutes = require("./routes/paybetaWebhookRoutes");   
const app = express();

app.disable("x-powered-by");

app.use(helmet());

app.use(
  cors({
    origin: process.env.CLIENT_URL || "http://localhost:5173",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

app.use(express.json({ limit: "20kb" }));

app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    message: "DataGold API is running",
  });
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    message: "Too many requests. Please try again later.",
  },
});

app.use("/api/auth", authLimiter, authRoutes);
app.use("/api/wallet", walletRoutes);
app.use("/api/data", dataRoutes);
app.use("/api/data/purchase", dataPurchaseRoutes);
app.use("/api/webhooks/paybeta", paybetaWebhookRoutes);

// Handle unknown endpoints.
app.use((req, res) => {
  res.status(404).json({
    message: "Endpoint not found.",
  });
});

// Central error handler.
app.use((error, req, res, next) => {
  console.error("API error:", error.message);

  if (res.headersSent) {
    return next(error);
  }

  res.status(500).json({
    message: "An unexpected error occurred.",
  });
});

module.exports = app;
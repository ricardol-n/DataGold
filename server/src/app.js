
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


const allowedOrigins = [
  "http://localhost:5173",
  "http://localhost:5174",
  ...(process.env.CLIENT_URL || "")
    .split(",")
    .map((url) => url.trim())
    .filter(Boolean),
];

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests without an Origin header (e.g. server-to-server).
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      return callback(null, false);
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "Idempotency-Key",
    ],
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

// Central error handler.
app.use((error, req, res, next) => {
  console.error("API error:", error.message);

  if (res.headersSent) {
    return next(error);
  }

  // Handle malformed JSON request bodies.
  if (
    error instanceof SyntaxError &&
    error.status === 400 &&
    "body" in error
  ) {
    return res.status(400).json({
      success: false,
      message: "Invalid JSON request body.",
    });
  }

  res.status(500).json({
    success: false,
    message: "An unexpected error occurred.",
  });
});

module.exports = app;
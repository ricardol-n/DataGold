
const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const nodemailer = require("nodemailer");
const { z } = require("zod");
const User = require("../models/user");

const router = express.Router();

const registerSchema = z.object({
  name: z.string().trim().min(2).max(80),
  email: z.string().trim().email().max(254),
  password: z.string().min(12).max(128),
});

const loginSchema = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().min(1).max(128),
});

const forgotPasswordSchema = z.object({
  email: z.string().trim().email().max(254),
});

const resetPasswordSchema = z.object({
  token: z.string().min(32).max(256),
  password: z.string().min(12).max(128),
});

function validate(schema, body) {
  const result = schema.safeParse(body);

  if (!result.success) {
    return {
      success: false,
      message: "Please check the information you entered.",
      errors: result.error.issues.map((issue) => ({
        field: issue.path.join("."),
        message: issue.message,
      })),
    };
  }

  return { success: true, data: result.data };
}

function createAccessToken(user) {
  const secret = process.env.JWT_ACCESS_SECRET;

  if (!secret || secret.length < 32) {
    throw new Error("JWT_ACCESS_SECRET is missing or too short");
  }

  return jwt.sign(
    {
      role: user.role,
    },
    secret,
    {
      subject: user._id.toString(),
      expiresIn: "15m",
      issuer: "datagold-api",
      audience: "datagold-app",
    }
  );
}

async function sendPasswordResetEmail(email, resetUrl) {
  // Development fallback: the URL is logged only in the backend terminal.
  if (
    process.env.NODE_ENV === "development" &&
    (!process.env.SMTP_HOST ||
      !process.env.SMTP_USER ||
      !process.env.SMTP_PASS ||
      !process.env.EMAIL_FROM)
  ) {
    console.log("Development password-reset URL:", resetUrl);
    return;
  }

  const port = Number(process.env.SMTP_PORT || 587);

  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: port === 465,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

  await transporter.sendMail({
    from: process.env.EMAIL_FROM,
    to: email,
    subject: "Reset your DataGold password",
    text: [
      "We received a request to reset your DataGold password.",
      "",
      `Use this link within 15 minutes: ${resetUrl}`,
      "",
      "If you did not request this, you can ignore this email.",
    ].join("\n"),
  });
}

// REGISTER
router.post("/register", async (req, res) => {
  const result = validate(registerSchema, req.body);

  if (!result.success) {
    return res.status(400).json(result);
  }

  const { name, password } = result.data;
  const email = result.data.email.toLowerCase();

  try {
    const existingUser = await User.findOne({ email });

    if (existingUser) {
      return res.status(409).json({
        message: "An account with this email already exists.",
      });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const user = await User.create({
      name,
      email,
      password: passwordHash,
    });

    const accessToken = createAccessToken(user);

    return res.status(201).json({
      message: "Account created successfully.",
      accessToken,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
      },
    });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({
        message: "An account with this email already exists.",
      });
    }

    throw error;
  }
});

// LOGIN
router.post("/login", async (req, res) => {
  const result = validate(loginSchema, req.body);

  if (!result.success) {
    return res.status(400).json(result);
  }

  const email = result.data.email.toLowerCase();
  const { password } = result.data;

  const user = await User.findOne({ email }).select("+password");

  if (!user || !(await bcrypt.compare(password, user.password))) {
    return res.status(401).json({
      message: "Invalid email or password.",
    });
  }

  const accessToken = createAccessToken(user);

  return res.json({
    message: "Login successful.",
    accessToken,
    user: {
      id: user._id,
      name: user.name,
      email: user.email,
      role: user.role,
    },
  });
});

// REQUEST PASSWORD RESET
router.post("/forgot-password", async (req, res) => {
  const result = validate(forgotPasswordSchema, req.body);

  if (!result.success) {
    return res.status(400).json(result);
  }

  const email = result.data.email.toLowerCase();

  const genericResponse = {
    message:
      "If an account exists for that email, password-reset instructions will be sent.",
  };

  try {
    const user = await User.findOne({ email });

    if (!user) {
      return res.json(genericResponse);
    }

    // Generate a random token; store only its SHA-256 hash.
    const resetToken = crypto.randomBytes(32).toString("hex");
    const resetTokenHash = crypto
      .createHash("sha256")
      .update(resetToken)
      .digest("hex");

    user.resetTokenHash = resetTokenHash;
    user.resetTokenExpires = new Date(Date.now() + 15 * 60 * 1000);

    await user.save();

    const clientUrl = process.env.CLIENT_URL;

    if (!clientUrl) {
      throw new Error("CLIENT_URL is not configured");
    }

    const resetUrl =
      `${clientUrl.replace(/\/$/, "")}/reset-password` +
      `?token=${encodeURIComponent(resetToken)}`;

    try {
      await sendPasswordResetEmail(email, resetUrl);
    } catch (emailError) {
      // Do not disclose whether an email account exists.
      console.error("Password-reset email delivery failed:", emailError.message);
    }

    return res.json(genericResponse);
  } catch (error) {
    console.error("Password-reset request failed:", error.message);

    return res.status(500).json({
      message: "Unable to process your request right now. Please try again.",
    });
  }
});

// RESET PASSWORD
router.post("/reset-password", async (req, res) => {
  const result = validate(resetPasswordSchema, req.body);

  if (!result.success) {
    return res.status(400).json(result);
  }

  const { token, password } = result.data;

  const tokenHash = crypto
    .createHash("sha256")
    .update(token)
    .digest("hex");

  const user = await User.findOne({
    resetTokenHash: tokenHash,
    resetTokenExpires: { $gt: new Date() },
  }).select("+resetTokenHash +resetTokenExpires");

  if (!user) {
    return res.status(400).json({
      message: "The reset link is invalid or has expired.",
    });
  }

  user.password = await bcrypt.hash(password, 12);
  user.resetTokenHash = undefined;
  user.resetTokenExpires = undefined;

  await user.save();

  return res.json({
    message: "Password reset successfully. Please log in again.",
  });
});

module.exports = router;

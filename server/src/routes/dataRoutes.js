
const express = require("express");
const router = express.Router();
const { protect } = require("../middleware/authMiddleware");

const NETWORKS = {
  mtn: "mtn_data",
  airtel: "airtel_data",
  glo: "glo_data",
  "9mobile": "9mobile_data",
};

const EXPECTED_BASE_URLS = {
  sandbox: "https://api.sandbox.paybeta.ng",
  production: "https://api.paybeta.ng",
};

router.get("/plans", protect, async (req, res) => {
  const network = String(req.query.network || "")
    .toLowerCase()
    .trim();

  const service = NETWORKS[network];

  if (!service) {
    return res.status(400).json({
      success: false,
      message: "Choose MTN, Airtel, Glo, or 9mobile.",
    });
  }

  const mode = process.env.PAYBETA_MODE;
  const baseUrl = (process.env.PAYBETA_BASE_URL || "").replace(/\/+$/, "");
  const expectedBaseUrl = EXPECTED_BASE_URLS[mode];

  if (
    !expectedBaseUrl ||
    baseUrl !== expectedBaseUrl ||
    !process.env.PAYBETA_SECRET_KEY
  ) {
    return res.status(503).json({
      success: false,
      message: "Paybeta environment is not configured correctly.",
    });
  }

  try {
    

    const url = `${baseUrl}/v2/data-bundle/list?service=${encodeURIComponent(service)}`;

    const response = await fetch(url, {
    method: "GET",
    headers: {
        Accept: "application/json",
        "P-API-KEY": process.env.PAYBETA_SECRET_KEY,
    },
    signal: AbortSignal.timeout(15000),
    });

    const rawBody = await response.text();

    let result;

    try {
      result = JSON.parse(rawBody);
    } catch {
      result = null;
    }

    if (
      !response.ok ||
      result?.status !== "successful" ||
      !Array.isArray(result?.data?.packages)
    ) {
      console.error("Paybeta plan request failed:", {
        requestedUrl: url,
        httpStatus: response.status,
        contentType: response.headers.get("content-type"),
        providerStatus: result?.status,
        providerMessage: result?.message,
        responseBody: rawBody.slice(0, 2000),
      });

      return res.status(502).json({
        success: false,
        message: "Unable to retrieve data plans from the provider.",
      });
    }

    const plans = result.data.packages
      .map((item) => ({
        code: item.code,
        description: item.description,
        price: Number(item.price),
      }))
      .filter(
        (item) =>
          typeof item.code === "string" &&
          item.code.length > 0 &&
          typeof item.description === "string" &&
          Number.isFinite(item.price) &&
          item.price > 0
      );

    return res.json({
      success: true,
      network,
      plans,
    });
  } catch (error) {
    console.error("Paybeta connection error:", error.message);

    return res.status(502).json({
      success: false,
      message: "Could not connect to the data provider. Please try again.",
    });
  }
});

module.exports = router;

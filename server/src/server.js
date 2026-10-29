
require("dotenv").config();

const app = require("./app");
const connectDB = require("./config/db");

async function startServer() {
  const secret = process.env.JWT_ACCESS_SECRET;

  if (!secret || secret.length < 32) {
    throw new Error(
      "JWT_ACCESS_SECRET must be at least 32 characters long."
    );
  }

  await connectDB();

  const port = Number(process.env.PORT) || 4000;

  app.listen(port, () => {
    console.log(`DataGold API running at http://localhost:${port}`);
    console.log(`Health check: http://localhost:${port}/api/health`);
  });
}

startServer().catch((error) => {
  console.error("Startup failed:", error.message);
  process.exit(1);
});

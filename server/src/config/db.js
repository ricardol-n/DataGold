
const mongoose = require("mongoose");
const dns = require("node:dns");

async function connectDB() {
  const mongoUri = process.env.MONGODB_URI;

  if (!mongoUri) {
    throw new Error("MONGODB_URI is missing from the server .env file");
  }

  // Work around the current default DNS resolver issue.
  dns.setServers(["8.8.8.8", "8.8.4.4"]);

  await mongoose.connect(mongoUri);

  console.log("MongoDB Atlas connected successfully");
}

module.exports = connectDB;

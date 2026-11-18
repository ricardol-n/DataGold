
const mongoose = require("mongoose");
const dns = require("node:dns");

async function connectDB() {
  const mongoUri = process.env.MONGODB_URI;

  if (!mongoUri) {
    throw new Error("MONGODB_URI is missing from environment variables");
  }

  // Use reliable public DNS resolvers for MongoDB Atlas SRV lookup.
  dns.setServers(["8.8.8.8", "8.8.4.4"]);

  await mongoose.connect(mongoUri, {
    serverSelectionTimeoutMS: 15000,
  });

  console.log("MongoDB Atlas connected successfully");
}

module.exports = connectDB;

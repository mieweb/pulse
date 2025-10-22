const express = require("express");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { v4: uuidv4 } = require("uuid");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;

// Simple middleware
app.use(express.json());

// Configure AWS S3 Client
const s3Client = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "OK" });
});

// Get presigned URL for upload
app.post("/upload-url", async (req, res) => {
  try {
    const { filename, contentType, title, description } = req.body;

    // Extract fileId from filename (remove .mp4 extension)
    const fileId = filename.replace(".mp4", "");
    const key = `pulsecam/${fileId}.mp4`;

    const command = new PutObjectCommand({
      Bucket: process.env.S3_BUCKET_NAME,
      Key: key,
      ContentType: contentType,
    });

    const presignedUrl = await getSignedUrl(s3Client, command, {
      expiresIn: 1800,
    });

    // Store metadata (you can save this to a database later)
    const metadata = {
      fileId,
      title: title || "",
      description: description || "",
      uploadTime: new Date().toISOString(),
    };

    console.log("📝 Video metadata:", metadata);

    res.json({
      presignedUrl,
      fileId,
      key,
      metadata,
    });
  } catch (error) {
    console.error("Error:", error);
    res.status(500).json({ error: "Failed to create upload URL" });
  }
});

// Error handling to keep server running
process.on("uncaughtException", (error) => {
  console.error("Uncaught Exception:", error);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
});

// Add debugging
console.log("Starting server...");
console.log("Port:", PORT);
console.log("AWS Region:", process.env.AWS_REGION);

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📱 Accessible at: http://10.3.226.63:${PORT}`);
  console.log("Server started successfully!");
});

module.exports = app;

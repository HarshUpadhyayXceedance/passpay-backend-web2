import express from "express";
import cors from "cors";
import { env } from "./config/env";
import { connectRedis } from "./services/redis";
import { isLiveKitConfigured } from "./services/livekit";
import roomRoutes from "./routes/rooms";
import meetingRoutes from "./routes/meetings";

const app = express();

// ─── Middleware ─────────────────────────────────────────────
app.use(cors());
app.use(express.json());

// ─── Routes ────────────────────────────────────────────────
app.use("/api/rooms", roomRoutes);
app.use("/api/meetings", meetingRoutes);

// Health check
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    livekit: isLiveKitConfigured(),
    timestamp: Date.now(),
  });
});

// ─── Start ─────────────────────────────────────────────────
async function start() {
  // Connect Redis
  try {
    await connectRedis();
    console.log("[Server] Redis connected");
  } catch (err: any) {
    console.warn("[Server] Redis not available:", err.message);
    console.warn("[Server] Rooms will not persist — running in degraded mode");
  }

  // Check LiveKit
  if (!isLiveKitConfigured()) {
    console.warn("[Server] LiveKit not configured — audio/video will be disabled");
    console.warn("[Server] Set LIVEKIT_API_KEY, LIVEKIT_API_SECRET, LIVEKIT_URL in .env");
  }

  app.listen(env.port, () => {
    console.log(`[Server] PassPay backend running on port ${env.port}`);
    console.log(`[Server] Health: http://localhost:${env.port}/health`);
    console.log(`[Server] Rooms API: http://localhost:${env.port}/api/rooms`);
    console.log(`[Server] Meetings API: http://localhost:${env.port}/api/meetings`);
  });
}

start().catch((err) => {
  console.error("[Server] Failed to start:", err);
  process.exit(1);
});

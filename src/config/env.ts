import dotenv from "dotenv";
dotenv.config();

export const env = {
  port: parseInt(process.env.PORT || "3001", 10),
  redisUrl: process.env.REDIS_URL || "redis://localhost:6379",
  solanaRpcUrl: process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com",
  programId: process.env.PROGRAM_ID || "3NG6FWSQhnA5gsM4pFMft8YE6TExaFmbjmR5Ck2EQkZq",
  // Secret for signing JWTs — MUST be set in production via environment variable
  jwtSecret: process.env.JWT_SECRET || "passpay-dev-jwt-secret-change-in-production",
  // Legacy pubkey-only auth (no signature). Only enable locally during dev.
  // MUST remain false (default) in production — no signature = full wallet impersonation.
  allowLegacyAuth: process.env.ALLOW_LEGACY_AUTH === "true",
  livekit: {
    apiKey: process.env.LIVEKIT_API_KEY || "",
    apiSecret: process.env.LIVEKIT_API_SECRET || "",
    url: process.env.LIVEKIT_URL || "",
  },
  // Room defaults
  roomMaxDurationMs: 4 * 60 * 60 * 1000, // 4 hours
  roomDefaultMaxParticipants: 50,
  meetingTokenTtlSeconds: 30 * 60, // 30 minutes
  signatureMaxAgeSeconds: 60, // signatures must be < 60s old
  // Solana mainnet RPC for SKR token verification (Seeker-gated rooms)
  solanaMainnetRpcUrl: process.env.SOLANA_MAINNET_RPC_URL || "https://api.mainnet-beta.solana.com",
  // Official Solana Mobile Seeker (SKR) token mint on mainnet
  skrMintAddress: process.env.SKR_MINT_ADDRESS || "SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3",
} as const;

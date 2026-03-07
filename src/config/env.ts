import dotenv from "dotenv";
dotenv.config();

export const env = {
  port: parseInt(process.env.PORT || "3001", 10),
  redisUrl: process.env.REDIS_URL || "redis://localhost:6379",
  solanaRpcUrl: process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com",
  programId: process.env.PROGRAM_ID || "3NG6FWSQhnA5gsM4pFMft8YE6TExaFmbjmR5Ck2EQkZq",
  jwtSecret: process.env.JWT_SECRET || "passpay-dev-jwt-secret-change-in-production",
  allowLegacyAuth: process.env.ALLOW_LEGACY_AUTH === "true",
  livekit: {
    apiKey: process.env.LIVEKIT_API_KEY || "",
    apiSecret: process.env.LIVEKIT_API_SECRET || "",
    url: process.env.LIVEKIT_URL || "",
  },
  roomMaxDurationMs: 4 * 60 * 60 * 1000,
  roomDefaultMaxParticipants: 50,
  meetingTokenTtlSeconds: 30 * 60,
  signatureMaxAgeSeconds: 60,
  solanaMainnetRpcUrl: process.env.SOLANA_MAINNET_RPC_URL || "https://api.mainnet-beta.solana.com",
  skrMintAddress: process.env.SKR_MINT_ADDRESS || "SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3",
} as const;

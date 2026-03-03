/**
 * Minimal JWT implementation using Node.js built-in `crypto`.
 * No external dependencies — HS256 HMAC-SHA256 signing.
 *
 * Token payload: { sub: walletPubkey, iat: unixSeconds, exp: unixSeconds }
 */
import crypto from "crypto";

interface JWTPayload {
  sub: string; // wallet pubkey (base58)
  iat: number; // issued at (unix seconds)
  exp: number; // expires at (unix seconds)
}

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function hmac(secret: string, data: string): Buffer {
  return crypto.createHmac("sha256", secret).update(data).digest();
}

/** Issue a signed JWT for a wallet pubkey. Default TTL = 7 days. */
export function issueToken(pubkey: string, secret: string, ttlSeconds = 7 * 24 * 3600): string {
  const header  = b64url(Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const now     = Math.floor(Date.now() / 1000);
  const payload = b64url(Buffer.from(JSON.stringify({ sub: pubkey, iat: now, exp: now + ttlSeconds })));
  const sig     = b64url(hmac(secret, `${header}.${payload}`));
  return `${header}.${payload}.${sig}`;
}

/** Verify a JWT and return its payload, or null if invalid/expired. */
export function verifyToken(token: string, secret: string): JWTPayload | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;

    // Constant-time signature comparison to prevent timing attacks
    const expected = b64url(hmac(secret, `${parts[0]}.${parts[1]}`));
    if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(parts[2]))) return null;

    const payload: JWTPayload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    if (!payload.exp || Math.floor(Date.now() / 1000) > payload.exp) return null;

    return payload;
  } catch {
    return null;
  }
}

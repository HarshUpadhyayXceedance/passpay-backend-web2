import crypto from "crypto";

interface JWTPayload {
  sub: string;
  iat: number;
  exp: number;
}

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function hmac(secret: string, data: string): Buffer {
  return crypto.createHmac("sha256", secret).update(data).digest();
}

export function issueToken(pubkey: string, secret: string, ttlSeconds = 7 * 24 * 3600): string {
  const header  = b64url(Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const now     = Math.floor(Date.now() / 1000);
  const payload = b64url(Buffer.from(JSON.stringify({ sub: pubkey, iat: now, exp: now + ttlSeconds })));
  const sig     = b64url(hmac(secret, `${header}.${payload}`));
  return `${header}.${payload}.${sig}`;
}

export function verifyToken(token: string, secret: string): JWTPayload | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;

    const expected = b64url(hmac(secret, `${parts[0]}.${parts[1]}`));
    if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(parts[2]))) return null;

    const payload: JWTPayload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    if (!payload.exp || Math.floor(Date.now() / 1000) > payload.exp) return null;

    return payload;
  } catch {
    return null;
  }
}

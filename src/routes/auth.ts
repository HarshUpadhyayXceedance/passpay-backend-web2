import { Router, Request, Response } from "express";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { issueToken } from "../services/jwt";
import { env } from "../config/env";

const router = Router();

const AUTH_MESSAGE_MAX_AGE_MS = 5 * 60 * 1000;

router.post("/", async (req: Request, res: Response) => {
  const { pubkey, signedMessage } = req.body as {
    pubkey?: string;
    signedMessage?: string;
  };

  if (!pubkey || typeof pubkey !== "string") {
    res.status(400).json({ error: "Missing pubkey" });
    return;
  }
  if (!signedMessage || typeof signedMessage !== "string") {
    res.status(400).json({ error: "Missing signedMessage" });
    return;
  }

  try {
    let pubkeyBytes: Uint8Array;
    try {
      pubkeyBytes = bs58.decode(pubkey);
      if (pubkeyBytes.length !== 32) throw new Error("bad length");
    } catch {
      res.status(400).json({ error: "Invalid pubkey encoding" });
      return;
    }

    let signedBytes: Uint8Array;
    try {
      signedBytes = new Uint8Array(Buffer.from(signedMessage, "base64"));
      if (signedBytes.length < 65) throw new Error("too short");
    } catch {
      res.status(400).json({ error: "Invalid signedMessage encoding" });
      return;
    }

    const messageBytes = nacl.sign.open(signedBytes, pubkeyBytes);
    if (!messageBytes) {
      res.status(401).json({ error: "Signature verification failed" });
      return;
    }

    let msg: { app?: string; pubkey?: string; ts?: number };
    try {
      msg = JSON.parse(Buffer.from(messageBytes).toString("utf8"));
    } catch {
      res.status(400).json({ error: "Invalid message format" });
      return;
    }

    if (msg.app !== "passpay") {
      res.status(400).json({ error: "Invalid app identifier in message" });
      return;
    }
    if (msg.pubkey !== pubkey) {
      res.status(400).json({ error: "Message pubkey mismatch" });
      return;
    }
    if (typeof msg.ts !== "number") {
      res.status(400).json({ error: "Missing timestamp in message" });
      return;
    }

    const ageMs = Date.now() - msg.ts;
    if (ageMs < 0 || ageMs > AUTH_MESSAGE_MAX_AGE_MS) {
      res.status(401).json({ error: "Message expired. Please reconnect." });
      return;
    }

    const token = issueToken(pubkey, env.jwtSecret);
    console.log(`[Auth] Authenticated wallet: ${pubkey.slice(0, 8)}...`);
    res.json({ token });
  } catch (error: any) {
    console.error("[Auth] Error:", error.message);
    res.status(500).json({ error: "Authentication failed" });
  }
});

export default router;

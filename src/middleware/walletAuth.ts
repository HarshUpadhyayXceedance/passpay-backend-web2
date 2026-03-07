import { Request, Response, NextFunction } from "express";
import bs58 from "bs58";
import { verifyToken } from "../services/jwt";
import { env } from "../config/env";
import { WalletAuth } from "../types";

export function walletAuth(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers["authorization"] as string | undefined;
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice(7);
    const payload = verifyToken(token, env.jwtSecret);
    if (!payload) {
      res.status(401).json({ error: "Invalid or expired token. Please reconnect your wallet." });
      return;
    }
    (req as Request & { wallet: WalletAuth }).wallet = { pubkey: payload.sub };
    next();
    return;
  }

  if (env.allowLegacyAuth) {
    const pubkeyHeader = req.headers["x-wallet-pubkey"] as string | undefined;
    if (pubkeyHeader) {
      try {
        const bytes = bs58.decode(pubkeyHeader);
        if (bytes.length !== 32) {
          res.status(401).json({ error: "Invalid public key" });
          return;
        }
      } catch {
        res.status(401).json({ error: "Invalid public key encoding" });
        return;
      }
      console.warn(`[Auth] Legacy pubkey-only access from ${pubkeyHeader.slice(0, 8)}...`);
      (req as Request & { wallet: WalletAuth }).wallet = { pubkey: pubkeyHeader };
      next();
      return;
    }
  }

  res.status(401).json({ error: "Authentication required. Connect your wallet." });
}

export function getWallet(req: Request): WalletAuth {
  return (req as Request & { wallet: WalletAuth }).wallet;
}

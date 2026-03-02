import { Request, Response, NextFunction } from "express";
import bs58 from "bs58";
import { WalletAuth } from "../types";

/**
 * Wallet identity middleware.
 *
 * Expects header:
 *   x-wallet-pubkey: base58 Solana public key
 *
 * The real security gate for meetings is on-chain ticket ownership verification.
 * Community rooms use LiveKit tokens (server-signed) as the access control layer.
 */
export function walletAuth(req: Request, res: Response, next: NextFunction): void {
  const pubkeyHeader = req.headers["x-wallet-pubkey"] as string | undefined;

  if (!pubkeyHeader) {
    res.status(401).json({ error: "Missing x-wallet-pubkey header" });
    return;
  }

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

  (req as Request & { wallet: WalletAuth }).wallet = { pubkey: pubkeyHeader };
  next();
}

export function getWallet(req: Request): WalletAuth {
  return (req as Request & { wallet: WalletAuth }).wallet;
}

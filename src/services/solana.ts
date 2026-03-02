import { Connection, PublicKey } from "@solana/web3.js";
import { AccountLayout } from "@solana/spl-token";
import { env } from "../config/env";

const PROGRAM_ID = new PublicKey(env.programId);
const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TICKET_SEED = Buffer.from("ticket");

let connection: Connection;

function getConnection(): Connection {
  if (!connection) {
    connection = new Connection(env.solanaRpcUrl, "confirmed");
  }
  return connection;
}

/**
 * Verify that a wallet owns a valid ticket NFT for a specific event.
 *
 * Flow:
 * 1. Get all SPL token accounts owned by the user
 * 2. For each token with balance >= 1, derive the ticket PDA
 * 3. Check if the ticket PDA exists and belongs to the target event
 */
export async function verifyTicketOwnership(
  userPubkey: string,
  eventPda: string
): Promise<boolean> {
  const conn = getConnection();
  const user = new PublicKey(userPubkey);
  const event = new PublicKey(eventPda);

  try {
    // Get all token accounts for this user
    const tokenAccounts = await conn.getTokenAccountsByOwner(user, {
      programId: TOKEN_PROGRAM_ID,
    });

    for (const { account } of tokenAccounts.value) {
      const data = AccountLayout.decode(account.data);

      // Only check tokens with balance >= 1 (user holds the NFT)
      if (data.amount < 1n) continue;

      const mint = data.mint;

      // Derive ticket PDA: seeds = ["ticket", eventPda, mint]
      const [ticketPda] = PublicKey.findProgramAddressSync(
        [TICKET_SEED, event.toBuffer(), mint.toBuffer()],
        PROGRAM_ID
      );

      // Check if this ticket PDA exists on-chain
      const ticketInfo = await conn.getAccountInfo(ticketPda);
      if (ticketInfo && ticketInfo.data.length >= 127) {
        // event pubkey is at offset 8 (after 8-byte discriminator)
        const ticketEvent = new PublicKey(ticketInfo.data.subarray(8, 40));
        if (ticketEvent.equals(event)) {
          return true;
        }
      }
    }

    return false;
  } catch (error) {
    console.error("[Solana] Ticket verification failed:", error);
    return false;
  }
}

/**
 * Check if an event exists, is active, is online, and return who the admin is.
 *
 * Event struct layout (after is_online field added):
 *   disc(8) + admin(32) + name(4+N) + venue(4+N) + desc(4+N) + image(4+N)
 *   + event_date(8) + base_ticket_price(8) + current_ticket_price(8)
 *   + total_seats(4) + tickets_sold(4) + is_active(1) + is_cancelled(1) + is_online(1) + ...
 */
export async function getEventInfo(eventPda: string): Promise<{
  exists: boolean;
  isActive: boolean;
  isOnline: boolean;
  eventType: "online" | "offline";
  adminPubkey: string;
} | null> {
  const conn = getConnection();
  try {
    const info = await conn.getAccountInfo(new PublicKey(eventPda));
    if (!info || info.data.length < 50) return null;

    // disc(8) + admin(32) — admin pubkey is at bytes 8–40
    const adminPubkey = new PublicKey(info.data.subarray(8, 40)).toBase58();

    // Parse through variable-length string fields
    let offset = 40;

    // name: 4-byte length prefix + bytes
    const nameLen = info.data.readUInt32LE(offset);
    offset += 4 + nameLen;

    // venue: 4-byte length prefix + bytes
    const venueLen = info.data.readUInt32LE(offset);
    const venueBytes = info.data.subarray(offset + 4, offset + 4 + venueLen);
    const venue = Buffer.from(venueBytes).toString("utf-8");
    offset += 4 + venueLen;

    // description
    const descLen = info.data.readUInt32LE(offset);
    offset += 4 + descLen;

    // image_url
    const imgLen = info.data.readUInt32LE(offset);
    offset += 4 + imgLen;

    // event_date(8) + base_ticket_price(8) + current_ticket_price(8) + total_seats(4) + tickets_sold(4)
    offset += 32;

    // is_active: 1 byte
    const isActive = info.data[offset] !== 0;
    offset += 1;

    // is_cancelled: 1 byte
    const isCancelled = info.data[offset] !== 0;
    offset += 1;

    // is_online: 1 byte (new field — fall back to venue-name detection for old accounts)
    let isOnline: boolean;
    if (offset < info.data.length) {
      isOnline = info.data[offset] !== 0;
    } else {
      isOnline = venue.toLowerCase().startsWith("online");
    }

    return {
      exists: true,
      isActive: isActive && !isCancelled,
      isOnline,
      eventType: isOnline ? "online" : "offline",
      adminPubkey,
    };
  } catch (error) {
    console.error("[Solana] Event info fetch failed:", error);
    return null;
  }
}

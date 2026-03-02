import { Connection, PublicKey } from "@solana/web3.js";
import { AccountLayout } from "@solana/spl-token";
import { env } from "../config/env";

const PROGRAM_ID = new PublicKey(env.programId);
const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TICKET_SEED = Buffer.from("ticket");
const EVENT_SEED = Buffer.from("event");

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
        // Verify the ticket's event field matches (event pubkey at offset 8)
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
 * Check if an event exists and is active on-chain.
 * Reads the Event account and checks is_active flag.
 *
 * Event struct layout (relevant fields):
 *   disc(8) + admin(32) + name(4+N) + venue(4+N) + desc(4+N) + image(4+N)
 *   + event_date(8) + base_ticket_price(8) + current_ticket_price(8)
 *   + total_seats(4) + tickets_sold(4) + is_active(1) + is_cancelled(1)
 *
 * For simplicity, we just check that the account exists and has data.
 * The venue field tells us if it's online or offline.
 */
export async function getEventInfo(eventPda: string): Promise<{
  exists: boolean;
  isActive: boolean;
  isOnline: boolean;
} | null> {
  const conn = getConnection();
  try {
    const info = await conn.getAccountInfo(new PublicKey(eventPda));
    if (!info || info.data.length < 50) return null;

    // The Event struct has variable-length string fields, so we need to
    // parse through them to find is_active.
    // For hackathon: trust the account exists = event is valid.
    // A more thorough check would fully deserialize the struct.

    // Read the venue string to determine online/offline
    // After disc(8) + admin(32) = offset 40
    // name is a Borsh string: 4-byte length prefix + bytes
    let offset = 40;
    const nameLen = info.data.readUInt32LE(offset);
    offset += 4 + nameLen;

    // venue: 4-byte length + bytes
    const venueLen = info.data.readUInt32LE(offset);
    const venueBytes = info.data.subarray(offset + 4, offset + 4 + venueLen);
    const venue = Buffer.from(venueBytes).toString("utf-8");
    offset += 4 + venueLen;

    // Skip description
    const descLen = info.data.readUInt32LE(offset);
    offset += 4 + descLen;

    // Skip image_url
    const imgLen = info.data.readUInt32LE(offset);
    offset += 4 + imgLen;

    // Skip event_date(8) + base_ticket_price(8) + current_ticket_price(8)
    offset += 24;

    // Skip total_seats(4) + tickets_sold(4)
    offset += 8;

    // is_active: 1 byte
    const isActive = info.data[offset] !== 0;
    offset += 1;

    // is_cancelled: 1 byte
    const isCancelled = info.data[offset] !== 0;

    const isOnline = venue.toLowerCase().startsWith("online");

    return {
      exists: true,
      isActive: isActive && !isCancelled,
      isOnline,
    };
  } catch (error) {
    console.error("[Solana] Event info fetch failed:", error);
    return null;
  }
}

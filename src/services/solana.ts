import { Connection, PublicKey } from "@solana/web3.js";
import { AccountLayout } from "@solana/spl-token";
import { env } from "../config/env";

const PROGRAM_ID = new PublicKey(env.programId);
const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TICKET_SEED = Buffer.from("ticket");

// Devnet connection for ticket/event verification
let connection: Connection | null = null;

function getConnection(): Connection {
  if (!connection) {
    connection = new Connection(env.solanaRpcUrl, "finalized");
  }
  return connection;
}

function resetConnection(): void {
  connection = null;
}

// Separate mainnet connection for SKR token verification (Seeker-gated rooms)
let mainnetConnection: Connection | null = null;

function getMainnetConnection(): Connection {
  if (!mainnetConnection) {
    mainnetConnection = new Connection(env.solanaMainnetRpcUrl, "confirmed");
  }
  return mainnetConnection;
}

function resetMainnetConnection(): void {
  mainnetConnection = null;
}

/**
 * Verify that a wallet holds the Seeker (SKR) token on Solana mainnet.
 * A single getTokenAccountsByOwner call filtered by the SKR mint is sufficient.
 * Returns true if the wallet has any SKR balance > 0.
 * @throws if the RPC call fails (network error, rate limit, etc.)
 */
export async function verifySeekerToken(userPubkey: string): Promise<boolean> {
  const conn = getMainnetConnection();
  const user = new PublicKey(userPubkey);
  const skrMint = new PublicKey(env.skrMintAddress);

  let tokenAccounts;
  try {
    tokenAccounts = await conn.getTokenAccountsByOwner(user, { mint: skrMint });
  } catch (error: any) {
    resetMainnetConnection();
    throw new Error(`[Solana] RPC error checking SKR balance: ${error.message}`);
  }

  for (const { account } of tokenAccounts.value) {
    const data = AccountLayout.decode(account.data);
    if (data.amount > 0n) return true;
  }
  return false;
}

/** Returns true when `str` is a valid 32-byte Solana base58 public key. */
export function isValidSolanaPubkey(str: string): boolean {
  try {
    new PublicKey(str);
    return true;
  } catch {
    return false;
  }
}

/**
 * Verify that a wallet owns a valid ticket NFT for a specific event.
 *
 * Flow:
 * 1. Get all SPL token accounts owned by the user
 * 2. For each token with balance >= 1, derive the ticket PDA
 * 3. Check if the ticket PDA exists and belongs to the target event
 *
 * Throws on RPC / network failure so callers can return 503 instead of
 * silently treating the error as "no ticket found".
 */
export async function verifyTicketOwnership(
  userPubkey: string,
  eventPda: string
): Promise<boolean> {
  const result = await getTicketStatus(userPubkey, eventPda);
  return result.hasTicket;
}

/**
 * Get full ticket status for a wallet + event combination.
 *
 * Ticket struct byte layout (127 bytes total):
 *   disc(8) + event(32) + owner(32) + mint(32) + seat_number(4)
 *   + seat_tier(1) + is_checked_in(1) + checked_in_at(8) + price_paid(8) + bump(1)
 *
 * is_checked_in is at byte offset 109.
 *
 * NOTE: Update the offset comment above if the Ticket struct ever changes.
 *
 * @throws if the RPC call fails (network error, rate limit, etc.)
 */
export async function getTicketStatus(
  userPubkey: string,
  eventPda: string
): Promise<{ hasTicket: boolean; isCheckedIn: boolean; ticketMint: string | null }> {
  const conn = getConnection();
  const user = new PublicKey(userPubkey);
  const event = new PublicKey(eventPda);

  // Any exception here is a genuine RPC/network failure — reset the connection
  // so the next caller gets a fresh one, then re-throw to signal 503 upstream.
  let tokenAccounts;
  try {
    tokenAccounts = await conn.getTokenAccountsByOwner(user, {
      programId: TOKEN_PROGRAM_ID,
    });
  } catch (error: any) {
    resetConnection();
    throw new Error(`[Solana] RPC error fetching token accounts: ${error.message}`);
  }

  for (const { account } of tokenAccounts.value) {
    const data = AccountLayout.decode(account.data);
    if (data.amount < 1n) continue;

    const mint = data.mint;

    const [ticketPda] = PublicKey.findProgramAddressSync(
      [TICKET_SEED, event.toBuffer(), mint.toBuffer()],
      PROGRAM_ID
    );

    let ticketInfo;
    try {
      ticketInfo = await conn.getAccountInfo(ticketPda, "finalized");
    } catch (error: any) {
      resetConnection();
      throw new Error(`[Solana] RPC error fetching ticket account: ${error.message}`);
    }

    if (ticketInfo && ticketInfo.data.length >= 127) {
      const ticketEvent = new PublicKey(ticketInfo.data.subarray(8, 40));
      if (ticketEvent.equals(event)) {
        // is_checked_in is a bool at byte offset 109
        // Layout: disc(8)+event(32)+owner(32)+mint(32)+seat_number(4)+seat_tier(1) = 109
        const isCheckedIn = ticketInfo.data[109] !== 0;
        return { hasTicket: true, isCheckedIn, ticketMint: mint.toBase58() };
      }
    }
  }

  return { hasTicket: false, isCheckedIn: false, ticketMint: null };
}

/**
 * Check if an event exists, is active, is online, and return who the admin is.
 *
 * Event struct layout (after is_online field added):
 *   disc(8) + admin(32) + name(4+N) + venue(4+N) + desc(4+N) + image(4+N)
 *   + event_date(8) + base_ticket_price(8) + current_ticket_price(8)
 *   + total_seats(4) + tickets_sold(4) + is_active(1) + is_cancelled(1) + is_online(1) + ...
 *
 * Returns null only when the account does not exist on-chain.
 * @throws if the RPC call fails (network error, rate limit, etc.)
 */
export async function getEventInfo(eventPda: string): Promise<{
  exists: boolean;
  isActive: boolean;
  isOnline: boolean;
  isMeetingEnded: boolean;
  eventType: "online" | "offline";
  adminPubkey: string;
  /** Event start time as Unix timestamp in seconds (0 if unreadable) */
  eventDate: number;
} | null> {
  const conn = getConnection();

  let info;
  try {
    info = await conn.getAccountInfo(new PublicKey(eventPda), "finalized");
  } catch (error: any) {
    resetConnection();
    throw new Error(`[Solana] RPC error fetching event account: ${error.message}`);
  }

  // Account doesn't exist — return null (not an error)
  if (!info || info.data.length < 50) return null;

  // disc(8) + admin(32) — admin pubkey is at bytes 8–40
  const adminPubkey = new PublicKey(info.data.subarray(8, 40)).toBase58();

  // Parse through variable-length string fields (Borsh: 4-byte length prefix + UTF-8 bytes)
  let offset = 40;

  // name
  const nameLen = info.data.readUInt32LE(offset);
  offset += 4 + nameLen;

  // venue (also used as fallback online-detection for old accounts without is_online)
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
  const eventDate = Number(info.data.readBigInt64LE(offset));
  offset += 32;

  // is_active: 1 byte
  const isActive = info.data[offset] !== 0;
  offset += 1;

  // is_cancelled: 1 byte
  const isCancelled = info.data[offset] !== 0;
  offset += 1;

  // is_online: 1 byte
  let isOnline: boolean;
  if (offset < info.data.length) {
    isOnline = info.data[offset] !== 0;
  } else {
    isOnline = venue.toLowerCase().startsWith("online");
  }
  offset += 1;

  // is_meeting_ended: 1 byte
  let isMeetingEnded = false;
  if (offset < info.data.length) {
    isMeetingEnded = info.data[offset] !== 0;
  }

  return {
    exists: true,
    isActive: isActive && !isCancelled,
    isOnline,
    isMeetingEnded,
    eventType: isOnline ? "online" : "offline",
    adminPubkey,
    eventDate,
  };
}

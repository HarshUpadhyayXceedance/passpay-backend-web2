import { Connection, PublicKey } from "@solana/web3.js";
import { AccountLayout } from "@solana/spl-token";
import { env } from "../config/env";

const PROGRAM_ID = new PublicKey(env.programId);
const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TICKET_SEED = Buffer.from("ticket");

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

export function isValidSolanaPubkey(str: string): boolean {
  try {
    new PublicKey(str);
    return true;
  } catch {
    return false;
  }
}

export async function verifyTicketOwnership(
  userPubkey: string,
  eventPda: string
): Promise<boolean> {
  const result = await getTicketStatus(userPubkey, eventPda);
  return result.hasTicket;
}

export async function getTicketStatus(
  userPubkey: string,
  eventPda: string
): Promise<{ hasTicket: boolean; isCheckedIn: boolean; ticketMint: string | null }> {
  const conn = getConnection();
  const user = new PublicKey(userPubkey);
  const event = new PublicKey(eventPda);

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
        const isCheckedIn = ticketInfo.data[109] !== 0;
        return { hasTicket: true, isCheckedIn, ticketMint: mint.toBase58() };
      }
    }
  }

  return { hasTicket: false, isCheckedIn: false, ticketMint: null };
}

export async function getEventInfo(eventPda: string): Promise<{
  exists: boolean;
  isActive: boolean;
  isOnline: boolean;
  isMeetingEnded: boolean;
  eventType: "online" | "offline";
  adminPubkey: string;
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

  if (!info || info.data.length < 50) return null;

  const adminPubkey = new PublicKey(info.data.subarray(8, 40)).toBase58();

  let offset = 40;

  const nameLen = info.data.readUInt32LE(offset);
  offset += 4 + nameLen;

  const venueLen = info.data.readUInt32LE(offset);
  const venueBytes = info.data.subarray(offset + 4, offset + 4 + venueLen);
  const venue = Buffer.from(venueBytes).toString("utf-8");
  offset += 4 + venueLen;

  const descLen = info.data.readUInt32LE(offset);
  offset += 4 + descLen;

  const imgLen = info.data.readUInt32LE(offset);
  offset += 4 + imgLen;

  const eventDate = Number(info.data.readBigInt64LE(offset));
  offset += 32;

  const isActive = info.data[offset] !== 0;
  offset += 1;

  const isCancelled = info.data[offset] !== 0;
  offset += 1;

  let isOnline: boolean;
  if (offset < info.data.length) {
    isOnline = info.data[offset] !== 0;
  } else {
    isOnline = venue.toLowerCase().startsWith("online");
  }
  offset += 1;

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

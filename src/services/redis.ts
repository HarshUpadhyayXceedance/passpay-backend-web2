import Redis from "ioredis";
import { env } from "../config/env";
import { Room, RoomWithCount } from "../types";

let redis: Redis;

export function getRedis(): Redis {
  if (!redis) {
    redis = new Redis(env.redisUrl, {
      maxRetriesPerRequest: 3,
      lazyConnect: true,
    });
    redis.on("error", (err) => console.error("[Redis] Error:", err.message));
    redis.on("connect", () => console.log("[Redis] Connected"));
  }
  return redis;
}

export async function connectRedis(): Promise<void> {
  const r = getRedis();
  if (r.status === "ready") return;
  await r.connect();
}

// ─── Room Operations ───────────────────────────────────────

const ROOM_KEY = (id: string) => `room:${id}`;
const ROOM_PARTICIPANTS_KEY = (id: string) => `room:${id}:participants`;
const ACTIVE_ROOMS_KEY = "rooms:active";

/** Create a room in Redis with TTL */
export async function createRoom(room: Room): Promise<void> {
  const r = getRedis();
  const ttlMs = room.expiresAt - Date.now();
  const ttlSeconds = Math.max(Math.ceil(ttlMs / 1000), 60); // min 60s

  const pipeline = r.pipeline();
  pipeline.hset(ROOM_KEY(room.id), {
    id: room.id,
    creator: room.creator,
    title: room.title,
    type: room.type,
    eventPda: room.eventPda || "",
    livekitRoom: room.livekitRoom,
    maxParticipants: room.maxParticipants.toString(),
    createdAt: room.createdAt.toString(),
    expiresAt: room.expiresAt.toString(),
  });
  pipeline.expire(ROOM_KEY(room.id), ttlSeconds);
  // Also set TTL on participants set
  pipeline.expire(ROOM_PARTICIPANTS_KEY(room.id), ttlSeconds);
  // Add to active rooms sorted set (score = createdAt for ordering)
  pipeline.zadd(ACTIVE_ROOMS_KEY, room.createdAt, room.id);
  await pipeline.exec();
}

/** Get a single room by ID */
export async function getRoom(id: string): Promise<Room | null> {
  const r = getRedis();
  const data = await r.hgetall(ROOM_KEY(id));
  if (!data || !data.id) return null;
  return deserializeRoom(data);
}

/** Get a room with live participant count */
export async function getRoomWithCount(id: string): Promise<RoomWithCount | null> {
  const r = getRedis();
  const [data, count] = await Promise.all([
    r.hgetall(ROOM_KEY(id)),
    r.scard(ROOM_PARTICIPANTS_KEY(id)),
  ]);
  if (!data || !data.id) return null;
  return { ...deserializeRoom(data), participantCount: count };
}

/** List all active rooms (with participant counts) */
export async function listActiveRooms(): Promise<RoomWithCount[]> {
  const r = getRedis();

  // Clean up expired rooms from the sorted set
  await r.zremrangebyscore(ACTIVE_ROOMS_KEY, 0, Date.now() - env.roomMaxDurationMs);

  // Get room IDs sorted by newest first
  const roomIds = await r.zrevrange(ACTIVE_ROOMS_KEY, 0, 99);
  if (roomIds.length === 0) return [];

  const rooms: RoomWithCount[] = [];
  for (const id of roomIds) {
    const room = await getRoomWithCount(id);
    if (room) rooms.push(room);
  }
  return rooms;
}

/** Delete a room */
export async function deleteRoom(id: string): Promise<void> {
  const r = getRedis();
  const pipeline = r.pipeline();
  pipeline.del(ROOM_KEY(id));
  pipeline.del(ROOM_PARTICIPANTS_KEY(id));
  pipeline.zrem(ACTIVE_ROOMS_KEY, id);
  await pipeline.exec();
}

const ROOM_CREATE_LOCK_KEY = (id: string) => `room:${id}:lock`;

/**
 * Atomically get or create a meeting room.
 *
 * Uses a Redis SET NX lock so that concurrent join requests for the same
 * event cannot race through the `if (!room) createRoom()` check and produce
 * duplicate entries. Only the request that acquires the lock creates the room;
 * all others spin-wait (up to 3 s) and then read the room written by the winner.
 *
 * @param roomId   Deterministic room ID (e.g. `meeting-<eventPda>`)
 * @param build    Factory that produces the Room object if it doesn't exist yet
 * @returns        The existing or newly-created Room
 */
export async function getOrCreateRoom(
  roomId: string,
  build: () => Room
): Promise<Room> {
  const r = getRedis();
  const lockKey = ROOM_CREATE_LOCK_KEY(roomId);
  const LOCK_TTL_S = 10; // lock expires after 10 s if holder crashes
  const POLL_MS = 50;    // retry interval while waiting for lock
  const TIMEOUT_MS = 3000;

  const start = Date.now();

  while (true) {
    // Fast path: room already exists — no lock needed
    const existing = await getRoom(roomId);
    if (existing) return existing;

    // Try to acquire the creation lock (SET NX EX)
    const acquired = await r.set(lockKey, "1", "EX", LOCK_TTL_S, "NX");

    if (acquired === "OK") {
      try {
        // Double-check: another holder may have created it between our read and lock
        const doubleCheck = await getRoom(roomId);
        if (doubleCheck) return doubleCheck;

        // We hold the lock and the room still doesn't exist — create it
        const room = build();
        await createRoom(room);
        return room;
      } finally {
        // Release the lock immediately after creation
        await r.del(lockKey);
      }
    }

    // Lock is held by another request — wait and retry
    if (Date.now() - start > TIMEOUT_MS) {
      // Fallback: return whatever is in Redis now (may be null if all holders failed)
      const fallback = await getRoom(roomId);
      if (fallback) return fallback;
      throw new Error("Timed out waiting for room creation lock");
    }

    await new Promise<void>((resolve) => setTimeout(resolve, POLL_MS));
  }
}

// ─── Verified Joiners (Rejoin Grace) ────────────────────────
// Tracks wallets that have successfully passed ticket verification for a room.
// Allows them to rejoin without re-verifying on-chain (e.g. after internet drop
// or after self_check_in before the transaction finalizes).

const ROOM_VERIFIED_KEY = (id: string) => `room:${id}:verified`;

/**
 * Record that a wallet has passed ticket verification for this meeting.
 * Uses the same TTL as the room so the record expires with the session.
 */
export async function recordVerifiedJoiner(
  roomId: string,
  pubkey: string,
  roomTtlSeconds: number
): Promise<void> {
  const r = getRedis();
  await r.sadd(ROOM_VERIFIED_KEY(roomId), pubkey);
  await r.expire(ROOM_VERIFIED_KEY(roomId), roomTtlSeconds);
}

/** Returns true if this wallet previously passed ticket verification for the room. */
export async function isVerifiedJoiner(roomId: string, pubkey: string): Promise<boolean> {
  return (await getRedis().sismember(ROOM_VERIFIED_KEY(roomId), pubkey)) === 1;
}

/** Add a participant to a room */
export async function addParticipant(roomId: string, pubkey: string): Promise<number> {
  const r = getRedis();
  await r.sadd(ROOM_PARTICIPANTS_KEY(roomId), pubkey);
  return r.scard(ROOM_PARTICIPANTS_KEY(roomId));
}

/** Remove a participant from a room */
export async function removeParticipant(roomId: string, pubkey: string): Promise<number> {
  const r = getRedis();
  await r.srem(ROOM_PARTICIPANTS_KEY(roomId), pubkey);
  return r.scard(ROOM_PARTICIPANTS_KEY(roomId));
}

/** Check if a user is in a room */
export async function isParticipant(roomId: string, pubkey: string): Promise<boolean> {
  const r = getRedis();
  return (await r.sismember(ROOM_PARTICIPANTS_KEY(roomId), pubkey)) === 1;
}

/** Get participant count for a room */
export async function getParticipantCount(roomId: string): Promise<number> {
  return getRedis().scard(ROOM_PARTICIPANTS_KEY(roomId));
}

// ─── Helpers ────────────────────────────────────────────────

function deserializeRoom(data: Record<string, string>): Room {
  return {
    id: data.id,
    creator: data.creator,
    title: data.title,
    type: data.type as "public" | "ticket",
    eventPda: data.eventPda || undefined,
    livekitRoom: data.livekitRoom,
    maxParticipants: parseInt(data.maxParticipants, 10),
    createdAt: parseInt(data.createdAt, 10),
    expiresAt: parseInt(data.expiresAt, 10),
  };
}

// ─── Rate Limiting ──────────────────────────────────────────

/**
 * Increment and check a rate limit counter for a given key.
 * Returns true if the request is allowed, false if the rate limit is exceeded.
 *
 * @param key     Unique rate limit key (e.g. `rate:meeting:join:{eventPda}:{wallet}`)
 * @param limit   Max allowed requests within the window
 * @param windowS Window duration in seconds
 */
export async function checkRateLimit(
  key: string,
  limit: number,
  windowS: number
): Promise<boolean> {
  const r = getRedis();
  const count = await r.incr(key);
  if (count === 1) {
    // First request — set expiry for the window
    await r.expire(key, windowS);
  }
  return count <= limit;
}

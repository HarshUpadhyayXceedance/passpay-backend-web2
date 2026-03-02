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

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

const ROOM_KEY = (id: string) => `room:${id}`;
const ROOM_PARTICIPANTS_KEY = (id: string) => `room:${id}:participants`;
const ACTIVE_ROOMS_KEY = "rooms:active";

export async function createRoom(room: Room): Promise<void> {
  const r = getRedis();
  const ttlMs = room.expiresAt - Date.now();
  const ttlSeconds = Math.max(Math.ceil(ttlMs / 1000), 60);

  const pipeline = r.pipeline();
  pipeline.hset(ROOM_KEY(room.id), {
    id: room.id,
    creator: room.creator,
    title: room.title,
    type: room.type,
    eventPda: room.eventPda || "",
    isSeekerGated: room.isSeekerGated ? "1" : "0",
    livekitRoom: room.livekitRoom,
    maxParticipants: room.maxParticipants.toString(),
    createdAt: room.createdAt.toString(),
    expiresAt: room.expiresAt.toString(),
  });
  pipeline.expire(ROOM_KEY(room.id), ttlSeconds);
  pipeline.expire(ROOM_PARTICIPANTS_KEY(room.id), ttlSeconds);
  pipeline.zadd(ACTIVE_ROOMS_KEY, room.createdAt, room.id);
  await pipeline.exec();
}

export async function getRoom(id: string): Promise<Room | null> {
  const r = getRedis();
  const data = await r.hgetall(ROOM_KEY(id));
  if (!data || !data.id) return null;
  return deserializeRoom(data);
}

export async function getRoomWithCount(id: string): Promise<RoomWithCount | null> {
  const r = getRedis();
  const [data, count] = await Promise.all([
    r.hgetall(ROOM_KEY(id)),
    r.scard(ROOM_PARTICIPANTS_KEY(id)),
  ]);
  if (!data || !data.id) return null;
  return { ...deserializeRoom(data), participantCount: count };
}

export async function listActiveRooms(): Promise<RoomWithCount[]> {
  const r = getRedis();

  await r.zremrangebyscore(ACTIVE_ROOMS_KEY, 0, Date.now() - env.roomMaxDurationMs);

  const roomIds = await r.zrevrange(ACTIVE_ROOMS_KEY, 0, 99);
  if (roomIds.length === 0) return [];

  const rooms: RoomWithCount[] = [];
  for (const id of roomIds) {
    const room = await getRoomWithCount(id);
    if (room) rooms.push(room);
  }
  return rooms;
}

export async function deleteRoom(id: string): Promise<void> {
  const r = getRedis();
  const pipeline = r.pipeline();
  pipeline.del(ROOM_KEY(id));
  pipeline.del(ROOM_PARTICIPANTS_KEY(id));
  pipeline.zrem(ACTIVE_ROOMS_KEY, id);
  await pipeline.exec();
}

const ROOM_CREATE_LOCK_KEY = (id: string) => `room:${id}:lock`;

export async function getOrCreateRoom(
  roomId: string,
  build: () => Room
): Promise<Room> {
  const r = getRedis();
  const lockKey = ROOM_CREATE_LOCK_KEY(roomId);
  const LOCK_TTL_S = 10;
  const POLL_MS = 50;
  const TIMEOUT_MS = 3000;

  const start = Date.now();

  while (true) {
    const existing = await getRoom(roomId);
    if (existing) return existing;

    const acquired = await r.set(lockKey, "1", "EX", LOCK_TTL_S, "NX");

    if (acquired === "OK") {
      try {
        const doubleCheck = await getRoom(roomId);
        if (doubleCheck) return doubleCheck;

        const room = build();
        await createRoom(room);
        return room;
      } finally {
        await r.del(lockKey);
      }
    }

    if (Date.now() - start > TIMEOUT_MS) {
      const fallback = await getRoom(roomId);
      if (fallback) return fallback;
      throw new Error("Timed out waiting for room creation lock");
    }

    await new Promise<void>((resolve) => setTimeout(resolve, POLL_MS));
  }
}

const ROOM_VERIFIED_KEY = (id: string) => `room:${id}:verified`;

export async function recordVerifiedJoiner(
  roomId: string,
  pubkey: string,
  roomTtlSeconds: number
): Promise<void> {
  const r = getRedis();
  await r.sadd(ROOM_VERIFIED_KEY(roomId), pubkey);
  await r.expire(ROOM_VERIFIED_KEY(roomId), roomTtlSeconds);
}

export async function isVerifiedJoiner(roomId: string, pubkey: string): Promise<boolean> {
  return (await getRedis().sismember(ROOM_VERIFIED_KEY(roomId), pubkey)) === 1;
}

export async function addParticipant(roomId: string, pubkey: string): Promise<number> {
  const r = getRedis();
  await r.sadd(ROOM_PARTICIPANTS_KEY(roomId), pubkey);
  return r.scard(ROOM_PARTICIPANTS_KEY(roomId));
}

export async function removeParticipant(roomId: string, pubkey: string): Promise<number> {
  const r = getRedis();
  await r.srem(ROOM_PARTICIPANTS_KEY(roomId), pubkey);
  return r.scard(ROOM_PARTICIPANTS_KEY(roomId));
}

export async function isParticipant(roomId: string, pubkey: string): Promise<boolean> {
  const r = getRedis();
  return (await r.sismember(ROOM_PARTICIPANTS_KEY(roomId), pubkey)) === 1;
}

export async function getParticipantCount(roomId: string): Promise<number> {
  return getRedis().scard(ROOM_PARTICIPANTS_KEY(roomId));
}

function deserializeRoom(data: Record<string, string>): Room {
  return {
    id: data.id,
    creator: data.creator,
    title: data.title,
    type: data.type as "public" | "ticket",
    eventPda: data.eventPda || undefined,
    isSeekerGated: data.isSeekerGated === "1",
    livekitRoom: data.livekitRoom,
    maxParticipants: parseInt(data.maxParticipants, 10),
    createdAt: parseInt(data.createdAt, 10),
    expiresAt: parseInt(data.expiresAt, 10),
  };
}

export async function checkRateLimit(
  key: string,
  limit: number,
  windowS: number
): Promise<boolean> {
  const r = getRedis();
  const count = await r.incr(key);
  if (count === 1) {
    await r.expire(key, windowS);
  }
  return count <= limit;
}

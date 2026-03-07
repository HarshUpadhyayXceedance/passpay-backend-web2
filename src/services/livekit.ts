import { AccessToken, RoomServiceClient } from "livekit-server-sdk";
import { env } from "../config/env";

function getRoomServiceClient(): RoomServiceClient {
  if (!env.livekit.apiKey || !env.livekit.apiSecret || !env.livekit.url) {
    throw new Error("LiveKit credentials not configured");
  }
  const httpUrl = env.livekit.url.replace(/^wss?:\/\//, "https://");
  return new RoomServiceClient(httpUrl, env.livekit.apiKey, env.livekit.apiSecret);
}

export async function generateLiveKitToken(
  roomName: string,
  identity: string,
  canPublish: boolean = true,
  ttlSeconds: number = env.meetingTokenTtlSeconds
): Promise<string> {
  if (!env.livekit.apiKey || !env.livekit.apiSecret) {
    throw new Error("LiveKit credentials not configured");
  }

  const token = new AccessToken(env.livekit.apiKey, env.livekit.apiSecret, {
    identity,
    ttl: ttlSeconds,
  });

  token.addGrant({
    room: roomName,
    roomJoin: true,
    canPublish,
    canSubscribe: true,
    canPublishData: true,
  });

  return await token.toJwt();
}

export function getLiveKitUrl(): string {
  return env.livekit.url;
}

export function isLiveKitConfigured(): boolean {
  return !!(env.livekit.apiKey && env.livekit.apiSecret && env.livekit.url);
}

export async function updateParticipantPermissions(
  roomName: string,
  identity: string,
  canPublish: boolean
): Promise<void> {
  const client = getRoomServiceClient();
  await client.updateParticipant(roomName, identity, {
    permission: {
      canPublish,
      canSubscribe: true,
      canPublishData: true,
    },
  });
}

export async function deleteLiveKitRoom(roomName: string): Promise<void> {
  const client = getRoomServiceClient();
  try {
    await client.deleteRoom(roomName);
  } catch (err: any) {
    if (!err?.message?.includes("not found") && !err?.message?.includes("404")) {
      throw err;
    }
  }
}

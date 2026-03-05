import { AccessToken, RoomServiceClient } from "livekit-server-sdk";
import { env } from "../config/env";

function getRoomServiceClient(): RoomServiceClient {
  if (!env.livekit.apiKey || !env.livekit.apiSecret || !env.livekit.url) {
    throw new Error("LiveKit credentials not configured");
  }
  // Convert wss:// URL to https:// for RoomServiceClient
  const httpUrl = env.livekit.url.replace(/^wss?:\/\//, "https://");
  return new RoomServiceClient(httpUrl, env.livekit.apiKey, env.livekit.apiSecret);
}

/**
 * Generate a LiveKit access token for a participant.
 *
 * @param roomName  - The LiveKit room name to grant access to
 * @param identity  - Participant identity (wallet pubkey)
 * @param canPublish - Whether the participant can publish audio/video (speaker vs listener)
 * @param ttlSeconds - Token time-to-live
 */
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
    canPublishData: true, // needed for text chat via data channels
  });

  return await token.toJwt();
}

/** Get the LiveKit WebSocket URL for clients to connect to */
export function getLiveKitUrl(): string {
  return env.livekit.url;
}

/** Check if LiveKit is configured */
export function isLiveKitConfigured(): boolean {
  return !!(env.livekit.apiKey && env.livekit.apiSecret && env.livekit.url);
}

/**
 * Grant canPublish=true to an existing participant without requiring them to
 * disconnect and reconnect. The permission change takes effect immediately on
 * the existing WebRTC connection.
 */
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

/**
 * Delete a LiveKit room, force-disconnecting all active participants.
 * Used when an admin ends the meeting.
 */
export async function deleteLiveKitRoom(roomName: string): Promise<void> {
  const client = getRoomServiceClient();
  try {
    await client.deleteRoom(roomName);
  } catch (err: any) {
    // Room may not exist in LiveKit (e.g. never had a LiveKit connection)
    if (!err?.message?.includes("not found") && !err?.message?.includes("404")) {
      throw err;
    }
  }
}

import { AccessToken } from "livekit-server-sdk";
import { env } from "../config/env";

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

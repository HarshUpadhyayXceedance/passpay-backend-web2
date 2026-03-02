import { Router, Request, Response } from "express";
import { walletAuth, getWallet } from "../middleware/walletAuth";
import { verifyTicketOwnership, getEventInfo } from "../services/solana";
import { generateLiveKitToken, getLiveKitUrl, isLiveKitConfigured } from "../services/livekit";
import {
  getRoom,
  createRoom,
  addParticipant,
  getParticipantCount,
  listActiveRooms,
  getRoomWithCount,
} from "../services/redis";
import { v4 as uuidv4 } from "uuid";
import { env } from "../config/env";

const router = Router();

/**
 * POST /api/meetings/:eventPda/join
 * Join a token-gated event meeting.
 *
 * Flow:
 * 1. Verify wallet signature (middleware)
 * 2. Check event exists and is online
 * 3. Verify user owns a ticket NFT for this event
 * 4. Create or find the meeting room for this event
 * 5. Issue LiveKit token
 *
 * The event creator (admin) gets speaker rights.
 * Everyone else joins as a listener.
 */
router.post("/:eventPda/join", walletAuth, async (req: Request, res: Response) => {
  const wallet = getWallet(req);
  const { eventPda } = req.params;

  if (!eventPda || eventPda.length < 32) {
    res.status(400).json({ error: "Invalid event PDA" });
    return;
  }

  try {
    // 1. Check the event on-chain
    const eventInfo = await getEventInfo(eventPda);
    if (!eventInfo || !eventInfo.exists) {
      res.status(404).json({ error: "Event not found" });
      return;
    }

    if (!eventInfo.isActive) {
      res.status(403).json({ error: "Event is not active" });
      return;
    }

    if (!eventInfo.isOnline) {
      res.status(400).json({ error: "This is an offline event — use QR check-in instead" });
      return;
    }

    // 2. Verify ticket ownership
    const hasTicket = await verifyTicketOwnership(wallet.pubkey, eventPda);
    if (!hasTicket) {
      res.status(403).json({
        error: "No valid ticket found",
        details: "You need to purchase a ticket for this event to join the meeting",
      });
      return;
    }

    // 3. Find or create the meeting room for this event
    const meetingRoomId = `meeting-${eventPda}`;
    let room = await getRoom(meetingRoomId);

    if (!room) {
      // First person joining — create the meeting room
      const now = Date.now();
      room = {
        id: meetingRoomId,
        creator: wallet.pubkey,
        title: `Event Meeting`,
        type: "ticket",
        eventPda,
        livekitRoom: `passpay-meeting-${eventPda.slice(0, 16)}`,
        maxParticipants: 200,
        createdAt: now,
        expiresAt: now + env.roomMaxDurationMs,
      };
      await createRoom(room);
    }

    // 4. Check capacity
    const count = await getParticipantCount(meetingRoomId);
    if (count >= room.maxParticipants) {
      res.status(403).json({ error: "Meeting is full" });
      return;
    }

    // 5. Add participant
    const newCount = await addParticipant(meetingRoomId, wallet.pubkey);

    // 6. Generate LiveKit token
    // Room creator gets speaker rights; others are listeners by default
    const canPublish = wallet.pubkey === room.creator;

    let token: string | null = null;
    let livekitUrl: string | null = null;
    if (isLiveKitConfigured()) {
      token = await generateLiveKitToken(room.livekitRoom, wallet.pubkey, canPublish);
      livekitUrl = getLiveKitUrl();
    }

    res.json({
      room: { ...room, participantCount: newCount },
      token,
      livekitUrl,
      role: canPublish ? "speaker" : "listener",
    });
  } catch (error: any) {
    console.error("[Meetings] Join error:", error.message);
    res.status(500).json({ error: "Failed to join meeting" });
  }
});

/**
 * POST /api/meetings/:eventPda/request-speak
 * Request speaker access in a meeting.
 * For now, auto-grants. In production, this could notify the host.
 */
router.post("/:eventPda/request-speak", walletAuth, async (req: Request, res: Response) => {
  const wallet = getWallet(req);
  const { eventPda } = req.params;

  const meetingRoomId = `meeting-${eventPda}`;
  const room = await getRoom(meetingRoomId);

  if (!room) {
    res.status(404).json({ error: "Meeting not found" });
    return;
  }

  try {
    // Re-issue token with publish rights
    let token: string | null = null;
    let livekitUrl: string | null = null;
    if (isLiveKitConfigured()) {
      token = await generateLiveKitToken(room.livekitRoom, wallet.pubkey, true);
      livekitUrl = getLiveKitUrl();
    }

    res.json({
      granted: true,
      token,
      livekitUrl,
      role: "speaker",
    });
  } catch (error: any) {
    console.error("[Meetings] Request speak error:", error.message);
    res.status(500).json({ error: "Failed to grant speaker access" });
  }
});

/**
 * GET /api/meetings/:eventPda/info
 * Get meeting info for an event (public — shows if meeting is active + participant count)
 */
router.get("/:eventPda/info", async (req: Request, res: Response) => {
  const { eventPda } = req.params;
  const meetingRoomId = `meeting-${eventPda}`;

  try {
    const room = await getRoomWithCount(meetingRoomId);
    if (!room) {
      res.json({ active: false, participantCount: 0 });
      return;
    }

    res.json({
      active: true,
      participantCount: room.participantCount,
      createdAt: room.createdAt,
      expiresAt: room.expiresAt,
    });
  } catch (error: any) {
    console.error("[Meetings] Info error:", error.message);
    res.status(500).json({ error: "Failed to get meeting info" });
  }
});

export default router;

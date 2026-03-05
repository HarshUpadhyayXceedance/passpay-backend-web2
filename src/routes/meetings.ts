import { Router, Request, Response } from "express";
import { walletAuth, getWallet } from "../middleware/walletAuth";
import { getTicketStatus, getEventInfo, isValidSolanaPubkey } from "../services/solana";
import {
  generateLiveKitToken,
  getLiveKitUrl,
  isLiveKitConfigured,
  updateParticipantPermissions,
  deleteLiveKitRoom,
} from "../services/livekit";
import {
  getRoom,
  createRoom,
  addParticipant,
  getParticipantCount,
  getRoomWithCount,
  deleteRoom,
  checkRateLimit,
} from "../services/redis";
import { env } from "../config/env";

const router = Router();

/** Validate that a route param is a legitimate Solana public key. */
function validateEventPda(eventPda: string | undefined, res: Response): boolean {
  if (!eventPda || !isValidSolanaPubkey(eventPda)) {
    res.status(400).json({ error: "Invalid event PDA — must be a valid Solana public key" });
    return false;
  }
  return true;
}

router.post("/:eventPda/join", walletAuth, async (req: Request, res: Response) => {
  const wallet = getWallet(req);
  const { eventPda } = req.params;

  if (!validateEventPda(eventPda, res)) return;

  try {
    // ── Rate limit: max 10 join attempts per wallet per event per hour ────
    const rateKey = `rate:meeting:join:${eventPda}:${wallet.pubkey}`;
    const allowed = await checkRateLimit(rateKey, 10, 3600);
    if (!allowed) {
      res.status(429).json({ error: "Too many join attempts. Please wait before trying again." });
      return;
    }

    // ── 1. Verify event on-chain ──────────────────────────────────────────
    let eventInfo;
    try {
      eventInfo = await getEventInfo(eventPda);
    } catch {
      res.status(503).json({ error: "Blockchain temporarily unavailable. Please try again shortly." });
      return;
    }

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

    // ── 2. Check if meeting was permanently ended on-chain ────────────
    if (eventInfo.isMeetingEnded) {
      res.status(403).json({ error: "This meeting has ended and cannot be rejoined." });
      return;
    }

    // ── 3. Event date gate: allow entry up to 15 min before start ─────────
    const nowSec = Math.floor(Date.now() / 1000);
    const EARLY_ENTRY_BUFFER_SEC = 15 * 60;
    if (eventInfo.eventDate > 0 && nowSec < eventInfo.eventDate - EARLY_ENTRY_BUFFER_SEC) {
      const minutesUntilOpen = Math.ceil((eventInfo.eventDate - EARLY_ENTRY_BUFFER_SEC - nowSec) / 60);
      res.status(403).json({
        error: `Meeting not open yet. Access opens ${minutesUntilOpen} minute(s) before the event starts.`,
        eventDate: eventInfo.eventDate,
        opensAt: eventInfo.eventDate - EARLY_ENTRY_BUFFER_SEC,
      });
      return;
    }

    // ── 4. Admin bypass — event creator always gets speaker rights ────────
    const isEventAdmin = wallet.pubkey === eventInfo.adminPubkey;

    // ── 5. Ticket verification for non-admins ─────────────────────────────
    if (!isEventAdmin) {
      let ticketStatus;
      try {
        ticketStatus = await getTicketStatus(wallet.pubkey, eventPda);
      } catch {
        // RPC failure — don't falsely deny access; surface as a transient error
        res.status(503).json({ error: "Unable to verify ticket ownership. Please try again shortly." });
        return;
      }

      if (!ticketStatus.hasTicket) {
        res.status(403).json({
          error: "No valid ticket found",
          details: "Purchase a ticket for this event to join the meeting.",
        });
        return;
      }

      // Note: isCheckedIn=true is allowed — attendance confirmation and room participation
      // are independent. A user who confirmed attendance can still re-join the meeting.
    }

    // ── 6. Find or create the meeting room ────────────────────────────────
    const meetingRoomId = `meeting-${eventPda}`;
    let room = await getRoom(meetingRoomId);

    if (!room) {
      const now = Date.now();
      room = {
        id: meetingRoomId,
        creator: eventInfo.adminPubkey,
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

    // ── 7. Check capacity ─────────────────────────────────────────────────
    const count = await getParticipantCount(meetingRoomId);
    if (count >= room.maxParticipants) {
      res.status(403).json({ error: "Meeting is full" });
      return;
    }

    // ── 8. Add participant + issue LiveKit token ───────────────────────────
    const newCount = await addParticipant(meetingRoomId, wallet.pubkey);
    const canPublish = isEventAdmin || wallet.pubkey === room.creator;

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

router.post("/:eventPda/request-speak", walletAuth, async (req: Request, res: Response) => {
  const wallet = getWallet(req);
  const { eventPda } = req.params;

  if (!validateEventPda(eventPda, res)) return;

  try {
    // ── Rate limit: 5 speaker requests per wallet per event per 10 min ────
    const rateKey = `rate:meeting:speak:${eventPda}:${wallet.pubkey}`;
    const allowed = await checkRateLimit(rateKey, 5, 600);
    if (!allowed) {
      res.status(429).json({ error: "Too many speaker requests. Please wait before trying again." });
      return;
    }

    const meetingRoomId = `meeting-${eventPda}`;
    const room = await getRoom(meetingRoomId);

    if (!room) {
      res.status(404).json({ error: "Meeting not found" });
      return;
    }

    let token: string | null = null;
    let livekitUrl: string | null = null;
    if (isLiveKitConfigured()) {
      // Update participant permissions server-side so the existing WebRTC
      // connection gets canPublish=true immediately (no disconnect/reconnect needed).
      try {
        await updateParticipantPermissions(room.livekitRoom, wallet.pubkey, true);
      } catch {
        // Participant may not be in LiveKit yet — still return the token so
        // the client can reconnect as a speaker if needed.
      }
      token = await generateLiveKitToken(room.livekitRoom, wallet.pubkey, true);
      livekitUrl = getLiveKitUrl();
    }

    res.json({ granted: true, token, livekitUrl, role: "speaker" });
  } catch (error: any) {
    console.error("[Meetings] Request speak error:", error.message);
    res.status(500).json({ error: "Failed to grant speaker access" });
  }
});

/**
 * DELETE /api/meetings/:eventPda/end
 *
 * Admin-only: cleans up LiveKit room + Redis entry after the admin has
 * already set is_meeting_ended=true on-chain via the end_meeting instruction.
 * The on-chain flag permanently prevents rejoining.
 */
router.delete("/:eventPda/end", walletAuth, async (req: Request, res: Response) => {
  const wallet = getWallet(req);
  const { eventPda } = req.params;

  if (!validateEventPda(eventPda, res)) return;

  try {
    // Only the event admin can end the meeting
    let eventInfo;
    try {
      eventInfo = await getEventInfo(eventPda);
    } catch {
      res.status(503).json({ error: "Blockchain temporarily unavailable. Please try again shortly." });
      return;
    }

    if (!eventInfo || !eventInfo.exists) {
      res.status(404).json({ error: "Event not found" });
      return;
    }

    if (wallet.pubkey !== eventInfo.adminPubkey) {
      res.status(403).json({ error: "Only the event admin can end the meeting" });
      return;
    }

    const meetingRoomId = `meeting-${eventPda}`;
    const room = await getRoom(meetingRoomId);

    // Force-disconnect all LiveKit participants first
    if (room && isLiveKitConfigured()) {
      await deleteLiveKitRoom(room.livekitRoom);
    }

    await deleteRoom(meetingRoomId);

    console.log(`[Meetings] Meeting ended by admin: ${eventPda.slice(0, 8)}... (${wallet.pubkey.slice(0, 8)}...)`);
    res.json({ ended: true });
  } catch (error: any) {
    console.error("[Meetings] End meeting error:", error.message);
    res.status(500).json({ error: "Failed to end meeting" });
  }
});

router.get("/:eventPda/info", async (req: Request, res: Response) => {
  const { eventPda } = req.params;

  if (!validateEventPda(eventPda, res)) return;

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

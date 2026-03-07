import { Router, Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import { walletAuth, getWallet } from "../middleware/walletAuth";
import {
  createRoom,
  getRoom,
  getRoomWithCount,
  listActiveRooms,
  deleteRoom,
  addParticipant,
  removeParticipant,
  getParticipantCount,
  checkRateLimit,
} from "../services/redis";
import { generateLiveKitToken, getLiveKitUrl, isLiveKitConfigured } from "../services/livekit";
import { verifySeekerToken } from "../services/solana";
import { env } from "../config/env";
import { CreateRoomBody } from "../types";

const router = Router();

router.get("/", async (_req: Request, res: Response) => {
  try {
    const rooms = await listActiveRooms();
    const publicRooms = rooms.filter((r) => r.type === "public");
    res.json({ rooms: publicRooms });
  } catch (error: any) {
    console.error("[Rooms] List error:", error.message);
    res.status(500).json({ error: "Failed to list rooms" });
  }
});

router.get("/:id", async (req: Request, res: Response) => {
  try {
    const room = await getRoomWithCount(req.params.id);
    if (!room) {
      res.status(404).json({ error: "Room not found or expired" });
      return;
    }
    res.json({ room });
  } catch (error: any) {
    console.error("[Rooms] Get error:", error.message);
    res.status(500).json({ error: "Failed to get room" });
  }
});

router.post("/", walletAuth, async (req: Request, res: Response) => {
  const wallet = getWallet(req);
  const body = req.body as CreateRoomBody;

  if (!body.title || body.title.trim().length === 0) {
    res.status(400).json({ error: "Room title is required" });
    return;
  }

  if (body.title.length > 100) {
    res.status(400).json({ error: "Room title must be under 100 characters" });
    return;
  }

  if (body.type && body.type !== "public" && body.type !== "ticket") {
    res.status(400).json({ error: "Room type must be 'public' or 'ticket'" });
    return;
  }

  if (body.type === "ticket" && !body.eventPda) {
    res.status(400).json({ error: "eventPda is required for ticket-gated rooms" });
    return;
  }

  try {
    const createRateKey = `rate:rooms:create:${wallet.pubkey}`;
    const allowed = await checkRateLimit(createRateKey, 5, 3600);
    if (!allowed) {
      res.status(429).json({ error: "Too many rooms created. Please wait before creating another." });
      return;
    }

    const roomId = uuidv4();
    const now = Date.now();

    const room = {
      id: roomId,
      creator: wallet.pubkey,
      title: body.title.trim(),
      type: (body.type || "public") as "public" | "ticket",
      eventPda: body.eventPda,
      isSeekerGated: body.isSeekerGated === true,
      livekitRoom: `passpay-${roomId}`,
      maxParticipants: Math.min(body.maxParticipants || env.roomDefaultMaxParticipants, 100),
      createdAt: now,
      expiresAt: now + env.roomMaxDurationMs,
    };

    await createRoom(room);

    await addParticipant(roomId, wallet.pubkey);

    let token: string | null = null;
    let livekitUrl: string | null = null;
    if (isLiveKitConfigured()) {
      token = await generateLiveKitToken(room.livekitRoom, wallet.pubkey, true);
      livekitUrl = getLiveKitUrl();
    }

    res.status(201).json({
      room: { ...room, participantCount: 1 },
      token,
      livekitUrl,
      role: "speaker",
    });
  } catch (error: any) {
    console.error("[Rooms] Create error:", error.message);
    res.status(500).json({ error: "Failed to create room" });
  }
});

router.post("/:id/join", walletAuth, async (req: Request, res: Response) => {
  const wallet = getWallet(req);
  const roomId = req.params.id;

  try {
    const joinRateKey = `rate:rooms:join:${wallet.pubkey}`;
    const joinAllowed = await checkRateLimit(joinRateKey, 20, 3600);
    if (!joinAllowed) {
      res.status(429).json({ error: "Too many join attempts. Please wait before trying again." });
      return;
    }

    const room = await getRoom(roomId);
    if (!room) {
      res.status(404).json({ error: "Room not found or expired" });
      return;
    }

    if (room.isSeekerGated) {
      try {
        const holdsSKR = await verifySeekerToken(wallet.pubkey);
        if (!holdsSKR) {
          res.status(403).json({
            error: "SEEKER_REQUIRED",
            details: "This room is exclusive to Seeker (SKR) token holders.",
          });
          return;
        }
      } catch (rpcError: any) {
        console.error("[Rooms] SKR verification RPC error:", rpcError.message);
        res.status(503).json({ error: "Could not verify Seeker token. Please try again." });
        return;
      }
    }

    const count = await getParticipantCount(roomId);
    if (count >= room.maxParticipants) {
      res.status(403).json({ error: "Room is full" });
      return;
    }

    const newCount = await addParticipant(roomId, wallet.pubkey);

    let token: string | null = null;
    let livekitUrl: string | null = null;
    if (isLiveKitConfigured()) {
      token = await generateLiveKitToken(room.livekitRoom, wallet.pubkey, true);
      livekitUrl = getLiveKitUrl();
    }

    res.json({
      room: { ...room, participantCount: newCount },
      token,
      livekitUrl,
      role: "speaker",
    });
  } catch (error: any) {
    console.error("[Rooms] Join error:", error.message);
    res.status(500).json({ error: "Failed to join room" });
  }
});

router.post("/:id/leave", walletAuth, async (req: Request, res: Response) => {
  const wallet = getWallet(req);
  const roomId = req.params.id;

  try {
    const room = await getRoom(roomId);
    if (!room) {
      res.status(404).json({ error: "Room not found or expired" });
      return;
    }

    const remaining = await removeParticipant(roomId, wallet.pubkey);
    res.json({ success: true, participantCount: remaining });
  } catch (error: any) {
    console.error("[Rooms] Leave error:", error.message);
    res.status(500).json({ error: "Failed to leave room" });
  }
});

router.delete("/:id", walletAuth, async (req: Request, res: Response) => {
  const wallet = getWallet(req);
  const roomId = req.params.id;

  try {
    const room = await getRoom(roomId);
    if (!room) {
      res.status(404).json({ error: "Room not found or expired" });
      return;
    }

    if (room.creator !== wallet.pubkey) {
      res.status(403).json({ error: "Only the room creator can close it" });
      return;
    }

    await deleteRoom(roomId);
    res.json({ success: true });
  } catch (error: any) {
    console.error("[Rooms] Delete error:", error.message);
    res.status(500).json({ error: "Failed to delete room" });
  }
});

export default router;

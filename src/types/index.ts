/** Room stored in Redis */
export interface Room {
  id: string;
  creator: string; // wallet pubkey (base58)
  title: string;
  type: "public" | "ticket"; // public = community, ticket = event-gated
  eventPda?: string; // only for ticket-gated rooms
  isSeekerGated?: boolean; // true = only SKR token holders can join
  livekitRoom: string; // LiveKit room name
  maxParticipants: number;
  createdAt: number; // unix ms
  expiresAt: number; // unix ms
}

/** Room with live participant count (returned to clients) */
export interface RoomWithCount extends Room {
  participantCount: number;
}

/** Chat message sent via LiveKit data channel (client-side type, shared for reference) */
export interface ChatMessage {
  sender: string; // wallet pubkey
  text: string;
  timestamp: number; // unix ms
}

/** Request body for creating a room */
export interface CreateRoomBody {
  title: string;
  type: "public" | "ticket";
  eventPda?: string;
  maxParticipants?: number;
  isSeekerGated?: boolean;
}

/** Request body for joining a room or meeting */
export interface JoinRoomBody {
  // wallet auth headers provide identity
}

/** Wallet auth payload extracted by middleware */
export interface WalletAuth {
  pubkey: string; // base58 wallet public key
}

/** Error response shape */
export interface ApiError {
  error: string;
  details?: string;
}

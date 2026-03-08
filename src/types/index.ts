
export interface Room {
  id: string;
  creator: string;
  title: string;
  type: "public" | "ticket";
  eventPda?: string;
  isSeekerGated?: boolean;
  livekitRoom: string;
  maxParticipants: number;
  createdAt: number;
  expiresAt: number;
}

export interface RoomWithCount extends Room {
  participantCount: number;
}

export interface ChatMessage {
  sender: string;
  text: string;
  timestamp: number;
}

export interface CreateRoomBody {
  title: string;
  type: "public" | "ticket";
  eventPda?: string;
  maxParticipants?: number;
  isSeekerGated?: boolean;
}

export interface JoinRoomBody {

}

export interface WalletAuth {
  pubkey: string;
}

export interface ApiError {
  error: string;
  details?: string;
}

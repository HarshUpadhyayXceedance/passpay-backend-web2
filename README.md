# PassPay Backend

Express + Redis backend handling live room management, LiveKit token generation, and on-chain ticket verification for PassPay.

**Production URL**: `https://passpay-backend-web2.vercel.app`

## Stack

- **Node.js** · **Express** 4.21 · **TypeScript** 5.6
- **Redis** (ioredis 5.4) — room state, rate limiting, verified-joiner cache
- **LiveKit** Server SDK 2.9 — audio/video room tokens
- **Solana** @solana/web3.js 1.98 — on-chain ticket & SKR token verification

## Environment Variables

Create a `.env` file:

```env
PORT=3001
REDIS_URL=redis://localhost:6379

# Solana
SOLANA_RPC_URL=https://api.devnet.solana.com
PROGRAM_ID=3NG6FWSQhnA5gsM4pFMft8YE6TExaFmbjmR5Ck2EQkZq
SOLANA_MAINNET_RPC_URL=https://api.mainnet-beta.solana.com
SKR_MINT_ADDRESS=SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3

# LiveKit
LIVEKIT_API_KEY=your_api_key
LIVEKIT_API_SECRET=your_api_secret
LIVEKIT_URL=wss://your-project.livekit.cloud

# Auth
JWT_SECRET=your_jwt_secret
```

## Scripts

```bash
npm run dev      # dev server with hot reload
npm run build    # compile TypeScript
npm start        # run compiled build
```

## API Endpoints

### Auth
| Method | Endpoint | Auth | Description |
|--------|----------|:----:|-------------|
| POST | `/api/auth` | — | Exchange wallet pubkey for JWT |

### Community Rooms
| Method | Endpoint | Auth | Description |
|--------|----------|:----:|-------------|
| GET | `/api/rooms` | — | List active public rooms |
| GET | `/api/rooms/:id` | — | Get room details |
| POST | `/api/rooms` | ✓ | Create room |
| POST | `/api/rooms/:id/join` | ✓ | Join room → LiveKit token |
| POST | `/api/rooms/:id/leave` | ✓ | Leave room |
| DELETE | `/api/rooms/:id` | ✓ | Close room (creator only) |

### Event Meetings (ticket-gated)
| Method | Endpoint | Auth | Description |
|--------|----------|:----:|-------------|
| GET | `/api/meetings/:eventPda/info` | — | Meeting status |
| POST | `/api/meetings/:eventPda/join` | ✓ | Join meeting (verifies ticket on-chain) |
| POST | `/api/meetings/:eventPda/request-speak` | ✓ | Request speaker role |
| POST | `/api/meetings/:eventPda/revoke-speak` | ✓ | Revoke speaker (admin only) |
| DELETE | `/api/meetings/:eventPda/end` | ✓ | End meeting (admin only) |

### Health
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Server health check |

## Auth

Requests pass `x-wallet-pubkey` header. The `/api/auth` endpoint returns a JWT signed with the wallet's Ed25519 key, which is then sent as `Authorization: Bearer <token>`.

## Key Design Decisions

- **Rooms** expire via Redis TTL (4 hours max). No manual cleanup needed.
- **Meeting rooms** use a deterministic ID (`meeting-<eventPda>`) with a Redis `SET NX` lock to prevent duplicate creation on concurrent joins.
- **Verified joiners** are cached in Redis after ticket verification so reconnecting users skip the Solana RPC call.
- **SKR-gated rooms** verify Seeker token balance against **Solana mainnet** (separate from devnet used for ticketing).
- **Rate limits**: 5 room creates/hr, 20 room joins/hr per wallet.

## Deployment (Vercel)

```bash
vercel deploy --prod
```

Set all env vars as Vercel environment variables or via `vercel env add`.

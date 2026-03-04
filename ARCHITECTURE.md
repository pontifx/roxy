# Roxy — Metaproxy Session Marketplace Architecture

## Overview

Roxy is a two-sided marketplace for browser sessions. **Hosts** install a browser
extension (or mobile app) that makes their browsing session available as a proxy
endpoint. **Buyers** (security researchers, bug-bounty hunters, pricing analysts)
purchase session packages to route traffic through these real residential/business
IPs.

```
┌─────────────────┐         ┌──────────────────────────┐        ┌─────────────────┐
│  Roxy Extension │ ◄─WSS──►│     Roxy Gateway          │◄─HTTPS─│  Buyer Client   │
│  (Session Host) │         │  (Envoy + Session Mgr)    │        │  (curl/burp/   │
│                 │         │                            │        │   browser)      │
│  - Chrome MV3   │         │  ┌──────────┐ ┌─────────┐ │        └─────────────────┘
│  - Proxy toggle │         │  │  Envoy   │ │ Session │ │
│  - Rule engine  │         │  │  Proxy   │ │ Manager │ │
│  - Earnings UI  │         │  │          │ │  (API)  │ │
└─────────────────┘         │  └──────────┘ └─────────┘ │
                            │  ┌──────────┐ ┌─────────┐ │
                            │  │ Ext Authz│ │  Redis  │ │
                            │  │ (gRPC)   │ │  State  │ │
                            │  └──────────┘ └─────────┘ │
                            └──────────────────────────┘
```

## Component Design

### 1. Envoy Proxy (Traffic Router)

**Role:** Receives buyer CONNECT/HTTP requests and routes them through the
appropriate host session tunnel.

**Key Configuration:**
- Listens on port 10000 (HTTP/HTTPS proxy)
- Uses ext_authz filter (gRPC) to validate buyer session tokens
- Dynamic cluster discovery via EDS (Endpoint Discovery Service) — each host
  session registers as an endpoint
- Session affinity via hash policy on the `X-Roxy-Session` header
- Rate limiting per buyer tier (Scout/Recon/Breach/Siege)
- TLS termination for buyer connections
- Circuit breakers per session to prevent host overload

**Why Envoy:** Native ext_authz for session validation, dynamic endpoint
discovery, ring-hash load balancing for session affinity, built-in rate limiting,
and excellent observability via stats/prometheus.

### 2. Session Manager API (Node.js/Express)

**Role:** Central brain. Manages session lifecycle, buyer authentication,
package tracking, and the marketplace matching engine.

**Endpoints:**
```
POST   /api/sessions/register    — Host registers available session
DELETE /api/sessions/:id          — Host disconnects session  
GET    /api/sessions/available    — List sessions (internal, for matching)
POST   /api/sessions/claim        — Buyer claims a session from their package
POST   /api/sessions/release      — Buyer releases session back to pool

POST   /api/packages/purchase     — Buyer purchases a package tier
GET    /api/packages/:id          — Get package details & remaining quota

POST   /api/auth/host/register    — Host account creation
POST   /api/auth/buyer/register   — Buyer account creation
POST   /api/auth/login             — JWT token issuance

GET    /api/earnings/:hostId      — Host earnings dashboard data
POST   /api/bounties/report       — Report a bug bounty for split

GET    /api/health                 — Health check
```

**Data Model (Redis + SQLite for persistence):**
- Sessions: `session:{id}` → `{hostId, ip, geo, browser, status, claimedBy, expiresAt}`
- Packages: `package:{id}` → `{buyerId, tier, sessionsRemaining, reqResQuota, createdAt}`
- Hosts: `host:{id}` → `{email, earnings, sessionsServed, rating}`
- Buyers: `buyer:{id}` → `{email, activePackages, sessionsUsed}`

### 3. External Authorization Service (gRPC)

**Role:** Envoy calls this on every buyer request. Validates the session token,
checks package quota, and tells Envoy which host session to route to.

**Flow:**
1. Buyer sends request with `X-Roxy-Token` and `X-Roxy-Session` headers
2. Envoy ext_authz calls the gRPC service
3. Service validates token → checks package quota → verifies session ownership
4. Returns OK with routing headers or DENIED with error

**Why separate from Session Manager:** Latency-critical path. This runs as a
thin, fast gRPC service. The Session Manager handles CRUD; this handles the
hot path per-request authorization.

### 4. Chrome Extension (Manifest V3)

**Role:** Turns the host's browser into a proxy endpoint.

**Architecture:**
- `manifest.json` — MV3, permissions: `proxy`, `webRequest`, `webRequestAuthProvider`, `storage`
- `background.js` (Service Worker) — WebSocket connection to Session Manager,
  session state machine, proxy configuration via `chrome.proxy.settings`
- `popup.html/js` — Toggle on/off, earnings display, rule configuration
- `options.html/js` — Blocked sites list, schedule, minimum payout settings

**Session Flow:**
1. Host clicks "Go Live" in popup
2. Service worker opens WSS to Session Manager: `wss://gateway.roxy.market/ws/host`
3. Session Manager registers the session, returns session ID
4. When a buyer claims this session, the Session Manager signals via WSS
5. Service worker configures `chrome.proxy.settings` to route buyer traffic
6. On disconnect/timeout, proxy settings revert to direct

**MV3 Constraints:**
- No `webRequestBlocking` — we use `webRequestAuthProvider` for proxy auth
- Service worker can be killed — we use alarms to keep WSS alive, reconnect on wake
- No localStorage in sandboxed context — use `chrome.storage.local`

### 5. Session Delivery / Tunneling

**How buyer traffic reaches the host browser:**

```
Buyer → Envoy (port 10000)
         ↓ ext_authz validates token
         ↓ routes to session cluster
         ↓
     Session Tunnel (WSS)
         ↓
     Host Extension receives proxied request
         ↓
     Extension uses chrome.proxy to route through host's network
         ↓
     Response flows back through WSS → Envoy → Buyer
```

The tunnel is a WebSocket between the extension and the gateway. The Session
Manager maintains the mapping. Envoy routes to the correct tunnel endpoint
using dynamic clusters.

**Alternative considered:** SOCKS5 tunneling. Rejected because Chrome MV3
doesn't allow raw socket access. WSS is the only viable transport from the
extension service worker.

### 6. Pricing Tiers (Package System)

| Package | Sessions | Req/Res Pairs | Rate Limit    | Price  |
|---------|----------|---------------|---------------|--------|
| Scout   | 10       | 500           | 10 req/s      | $29    |
| Recon   | 50       | 3,000         | 25 req/s      | $119   |
| Breach  | 200      | 15,000        | 50 req/s      | $399   |
| Siege   | 1,000    | 100,000       | 100 req/s     | $1,499 |

Rate limits enforced at Envoy via the local rate limiter filter, keyed on
buyer token.

### 7. Bug Bounty Split System

When a buyer discovers a vulnerability through a Roxy session:
1. Buyer reports via `/api/bounties/report` with session ID + proof
2. Session Manager looks up which host served that session
3. Default split: 70% buyer / 30% host (configurable per host)
4. Bounty enters "pending" state until buyer confirms payout from target
5. On confirmation, host earnings update and payout queues

### 8. Dynamic Pricing Data Pipeline

As sessions route through diverse IPs, the extension passively observes
HTTP response headers that indicate dynamic pricing (e.g., price variations
for the same URL from different geos). This is:
- Anonymized at the extension level (no PII, no form data, no auth tokens)
- Sent as structured price signals to the data pipeline
- Aggregated by URL pattern + geography + time
- Sold to research subscribers; hosts get a revenue share

## Project Structure

```
roxy/
├── docker-compose.yml
├── envoy/
│   ├── Dockerfile
│   ├── envoy.yaml              # Main Envoy config
│   └── certs/                  # TLS certs (dev self-signed)
├── session-manager/
│   ├── Dockerfile
│   ├── package.json
│   ├── src/
│   │   ├── index.js            # Express app entry
│   │   ├── routes/
│   │   │   ├── sessions.js
│   │   │   ├── packages.js
│   │   │   ├── auth.js
│   │   │   ├── earnings.js
│   │   │   └── bounties.js
│   │   ├── services/
│   │   │   ├── sessionPool.js  # Session matching engine
│   │   │   ├── packageManager.js
│   │   │   └── pricingPipeline.js
│   │   ├── ws/
│   │   │   └── hostConnection.js  # WebSocket handler for hosts
│   │   ├── db/
│   │   │   └── store.js        # SQLite + Redis abstraction
│   │   └── middleware/
│   │       └── auth.js         # JWT middleware
│   └── tests/
├── ext-authz/
│   ├── Dockerfile
│   ├── package.json
│   └── src/
│       └── server.js           # gRPC ext_authz implementation
├── extension/
│   ├── manifest.json
│   ├── background.js           # Service worker
│   ├── popup.html
│   ├── popup.js
│   ├── popup.css
│   ├── options.html
│   ├── options.js
│   └── icons/
└── docs/
    ├── ARCHITECTURE.md
    └── API.md
```

## Development Phases

### Phase 1: Foundation (Commits 1-2)
- Envoy proxy with static config, ext_authz stub
- Session Manager with in-memory session pool
- Docker Compose to orchestrate

### Phase 2: Extension + Tunneling (Commit 3)
- Chrome extension with WSS connection
- Session registration/deregistration
- Basic proxy toggle

### Phase 3: Marketplace (Commit 4)
- Package purchase and tracking
- Session claiming and matching
- Rate limiting per tier

### Phase 4: Revenue Features (Commit 5)
- Bug bounty reporting and split calculation
- Dynamic pricing signal collection
- Earnings dashboard data

## Security Considerations

- All buyer↔gateway traffic over TLS
- All host↔gateway traffic over WSS (TLS)
- JWT tokens with short TTL (15 min) + refresh tokens
- Hosts can blocklist URLs/domains — enforced at extension level before proxying
- Session tokens are single-use per claim, non-transferable
- Rate limiting at Envoy prevents abuse
- Request/response body logging is opt-in and anonymized

# Roxy — Metaproxy Session Marketplace

Roxy is a two-sided marketplace for real browser sessions. **Hosts** install the Roxy browser extension to earn passive income by sharing their session. **Buyers** — security researchers, bug-bounty hunters, and pricing analysts — purchase session packages to route traffic through authentic residential and business IPs.

Unlike traditional proxy providers that scrape datacenter IPs, Roxy routes traffic through real, consenting human browsers. Every request exits through an extension running on a real person's Chrome — with their actual browser fingerprint, cookies, and network context intact.

---

## Architecture Overview

```
┌─────────────────┐         ┌──────────────────────────────┐        ┌──────────────────┐
│  Roxy Extension │ ◄─WSS──►│     Roxy Gateway              │◄─HTTPS─│  Buyer Client    │
│  (Session Host) │         │  (Envoy + Session Manager)    │        │  (curl/Burp/     │
│                 │         │                                │        │   custom client) │
│  - Chrome MV3   │         │  ┌──────────┐  ┌───────────┐  │        └──────────────────┘
│  - WS tunnel    │         │  │  Envoy   │  │  Session  │  │
│  - Rule engine  │         │  │  Proxy   │  │  Manager  │  │
│  - Earnings UI  │         │  │ :10000   │  │  :3000    │  │
└─────────────────┘         │  └──────────┘  └───────────┘  │
                            │  ┌──────────┐  ┌───────────┐  │
                            │  │ ext-authz│  │   Redis   │  │
                            │  │  :9191   │  │   :6379   │  │
                            │  └──────────┘  └───────────┘  │
                            └──────────────────────────────┘
```

### Components

| Component | Role |
|-----------|------|
| **Envoy Proxy** | Receives all buyer HTTPS/CONNECT requests. Calls ext-authz on every request. Routes validated traffic through the correct host WSS tunnel. |
| **Session Manager** | Node.js/Express API. Manages the session marketplace: host registration, buyer auth, package purchases, session claiming/releasing, bounties, earnings. |
| **ext-authz** | Thin HTTP authorization service. Called by Envoy on every request. Validates buyer token + session ownership + package quota. Returns 200/403. |
| **Redis** | Ephemeral session state: available sessions, active claims, rate counters. |
| **SQLite** | Persistent data: hosts, buyers, packages, earnings ledger, bounties. |
| **Chrome Extension** | Turns host's browser into a WSS tunnel endpoint. Receives proxied requests, fetches via host's network, returns responses through tunnel. |

For the complete architecture document, see [ARCHITECTURE.md](./ARCHITECTURE.md).

---

## Quick Start (Docker Compose)

### Prerequisites

- Docker 24+ with Compose v2
- Node.js 20+ (for local extension development)
- Chrome 120+ (for the extension)

### 1. Clone and configure

```bash
git clone https://github.com/pontifx/roxy.git
cd roxy

# Copy and edit environment variables
cp .env.example .env
# At minimum, set JWT_SECRET to a strong random string
```

### 2. Start all services

```bash
docker-compose up --build
```

This starts:
- **Envoy** at `http://localhost:10000` (buyer proxy endpoint)
- **Envoy admin** at `http://localhost:9901`
- **Session Manager API** at `http://localhost:3000`
- **ext-authz** at `http://localhost:9191` (internal only)
- **Redis** at `localhost:6379`

### 3. Verify health

```bash
curl http://localhost:3000/api/health
# → {"status":"ok","redis":"ok","sqlite":"ok","timestamp":"..."}
```

### 4. Register and log in as a buyer

```bash
# Register
curl -X POST http://localhost:3000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"buyer@example.com","password":"s3cr3t","role":"buyer"}'

# Login
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"buyer@example.com","password":"s3cr3t"}'
# → {"token":"eyJ...","user":{...}}
```

---

## Extension Installation

The Roxy Chrome extension is the host-side component. It maintains a WebSocket tunnel to the gateway and forwards proxied requests using `fetch()` from within the host's browser context.

### Development install (unpacked)

1. Navigate to `chrome://extensions/`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the `extension/` directory from this repo

### Configure the extension

1. Click the Roxy icon → gear icon → Options
2. Set **Gateway URL** to `wss://localhost:10000/ws/host` (dev) or your deployed gateway
3. Optionally add blocked domains (one per line)
4. Set your minimum payout threshold

### Go Live

1. Register a host account via the Session Manager API
2. Log in through the extension popup → enter credentials
3. Click **Go Live** — the extension opens a WSS connection and registers your session

---

## Buyer API Usage

Full documentation is in [docs/API.md](./docs/API.md). Quick reference:

### Authentication

```bash
# Set your token after login
TOKEN="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."

# Purchase a Scout package ($29 — 10 sessions, 500 req/res)
curl -X POST http://localhost:3000/api/packages/purchase \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"tier":"scout"}'
# → {"id":"pkg_...","tier":"scout","sessionsRemaining":10,"reqResRemaining":500,...}

# Claim a session
curl -X POST http://localhost:3000/api/sessions/claim \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"packageId":"pkg_..."}'
# → {"sessionId":"sess_...","proxyHost":"localhost","proxyPort":10000,"token":"...","..."}

# Use the session via Envoy proxy
curl -x http://localhost:10000 \
  -H "X-Roxy-Token: $TOKEN" \
  -H "X-Roxy-Session: sess_..." \
  https://example.com

# Release the session when done
curl -X POST http://localhost:3000/api/sessions/release \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"sessionId":"sess_..."}'
```

### Report a Bug Bounty

```bash
curl -X POST http://localhost:3000/api/bounties/report \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "sessionId": "sess_...",
    "amount": 50000,
    "proofUrl": "https://hackerone.com/reports/..."
  }'
# Default split: 70% to you, 30% to the host who provided the session
```

---

## Pricing Tiers

| Package | Sessions | Req/Res Pairs | Rate Limit | Price  |
|---------|----------|---------------|------------|--------|
| **Scout**  | 10       | 500           | 10 req/s   | $29    |
| **Recon**  | 50       | 3,000         | 25 req/s   | $119   |
| **Breach** | 200      | 15,000        | 50 req/s   | $399   |
| **Siege**  | 1,000    | 100,000       | 100 req/s  | $1,499 |

- **Sessions**: How many distinct host sessions you can claim (one at a time)
- **Req/Res Pairs**: Total proxied request/response pairs across all sessions
- **Rate Limit**: Maximum concurrent requests per second through the Envoy proxy
- Packages expire **30 days** from purchase

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `JWT_SECRET` | `dev-secret-change-me` | Secret for JWT signing — **change in production** |
| `JWT_TTL` | `900` | JWT expiry in seconds (15 min) |
| `PORT` | `3000` | Session Manager HTTP port |
| `REDIS_URL` | `redis://redis:6379` | Redis connection string |
| `SQLITE_PATH` | `./data/roxy.db` | SQLite database file path |
| `BOUNTY_HOST_SHARE` | `0.30` | Default host share of reported bounties |
| `SESSION_MAX_CLAIM_HOURS` | `48` | Hours before an unclaimed session auto-expires |

---

## Contributing

1. Fork the repo and create a feature branch: `git checkout -b feat/my-feature`
2. Follow the existing code style (ESLint config in package roots)
3. Write tests for new routes in `session-manager/tests/`
4. Ensure `docker-compose up --build` succeeds cleanly
5. Open a pull request — describe the problem, the solution, and any tradeoffs

### Code Organization

- Keep services thin and focused. Routes validate input; services contain business logic; `db/store.js` owns all persistence.
- Redis is for ephemeral data that can be lost on restart. SQLite is the source of truth.
- The ext-authz service must stay fast — no heavy computation on the hot path.
- Extension code must work offline (no ES modules that require bundling; keep it vanilla JS for easy debugging).

### Testing

```bash
cd session-manager
npm test        # Jest unit + integration tests
npm run lint    # ESLint
```

---

## License

MIT © 2026 pontifx. See [LICENSE](./LICENSE).

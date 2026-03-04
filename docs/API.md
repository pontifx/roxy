# Roxy Buyer API Reference

Base URL (local dev): `http://localhost:3000`  
All requests/responses use `application/json`.  
Authentication uses `Authorization: Bearer <JWT>`.

---

## Table of Contents

1. [Authentication](#authentication)
2. [Packages](#packages)
3. [Sessions](#sessions)
4. [Making Proxied Requests](#making-proxied-requests)
5. [Bug Bounties](#bug-bounties)
6. [Errors](#errors)

---

## Authentication

Roxy uses short-lived JWTs (15 minutes by default). All buyer endpoints require a valid `Bearer` token.

### Register a buyer account

```
POST /api/auth/register
```

**Request body:**

```json
{
  "email": "researcher@example.com",
  "password": "your-password-min-8-chars",
  "role": "buyer"
}
```

**Response 201:**

```json
{
  "id": "a3f4c7e1-...",
  "email": "researcher@example.com",
  "role": "buyer",
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

**curl:**

```bash
curl -X POST http://localhost:3000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "email": "researcher@example.com",
    "password": "hunter2hunter2",
    "role": "buyer"
  }'
```

---

### Login

```
POST /api/auth/login
```

**Request body:**

```json
{
  "email": "researcher@example.com",
  "password": "hunter2hunter2",
  "role": "buyer"
}
```

**Response 200:**

```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "user": {
    "id": "a3f4c7e1-...",
    "email": "researcher@example.com",
    "role": "buyer"
  }
}
```

**curl:**

```bash
TOKEN=$(curl -s -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"researcher@example.com","password":"hunter2hunter2","role":"buyer"}' \
  | jq -r '.token')

echo "JWT: $TOKEN"
```

---

## Packages

Packages are bundles of session credits and req/res quota. Purchase one before claiming sessions.

### Pricing Tiers

| Tier       | Sessions | Req/Res Pairs | Rate Limit | Price   |
|------------|----------|---------------|------------|---------|
| `scout`    | 10       | 500           | 10 req/s   | $29.00  |
| `recon`    | 50       | 3,000         | 25 req/s   | $119.00 |
| `breach`   | 200      | 15,000        | 50 req/s   | $399.00 |
| `siege`    | 1,000    | 100,000       | 100 req/s  | $1,499  |

- **Sessions**: How many distinct host sessions you can claim. Sessions are claimed one at a time from the pool.
- **Req/Res Pairs**: Total proxied HTTP request/response pairs across all sessions. Decremented on every request through Envoy.
- **Rate Limit**: Maximum requests per second through the Envoy proxy endpoint.
- Packages expire **30 days** from purchase.

---

### Purchase a package

```
POST /api/packages/purchase
Authorization: Bearer <token>
```

**Request body:**

```json
{
  "tier": "scout"
}
```

**Response 201:**

```json
{
  "id": "pkg_7a3bc...",
  "tier": "scout",
  "sessionsRemaining": 10,
  "sessionsTotal": 10,
  "reqResRemaining": 500,
  "reqResTotal": 500,
  "purchasedAt": "2026-03-04T10:00:00.000Z",
  "expiresAt": "2026-04-03T10:00:00.000Z",
  "price": 2900,
  "rateLimit": 10
}
```

**curl:**

```bash
curl -X POST http://localhost:3000/api/packages/purchase \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"tier": "recon"}'
```

---

### List your packages

```
GET /api/packages
Authorization: Bearer <token>
```

**Response 200:**

```json
{
  "packages": [
    {
      "id": "pkg_7a3bc...",
      "tier": "recon",
      "sessionsRemaining": 42,
      "sessionsTotal": 50,
      "reqResRemaining": 2847,
      "reqResTotal": 3000,
      "purchasedAt": "2026-03-04T10:00:00.000Z",
      "expiresAt": "2026-04-03T10:00:00.000Z",
      "rateLimit": 25
    }
  ],
  "total": 1
}
```

**curl:**

```bash
curl http://localhost:3000/api/packages \
  -H "Authorization: Bearer $TOKEN"
```

---

### Get a specific package

```
GET /api/packages/:id
Authorization: Bearer <token>
```

**curl:**

```bash
curl http://localhost:3000/api/packages/pkg_7a3bc... \
  -H "Authorization: Bearer $TOKEN"
```

---

## Sessions

Sessions represent a live host browser extension. Claim one from your package, use it for proxied requests, then release it when done.

### Claim a session

```
POST /api/sessions/claim
Authorization: Bearer <token>
```

**Request body:**

```json
{
  "packageId": "pkg_7a3bc...",
  "geo": "US",
  "browser": "chrome"
}
```

`geo` and `browser` are optional matching hints. If specified, the pool returns the best-matching session. If no match is found, any available session is returned.

**Response 200:**

```json
{
  "sessionId": "sess_4f2a1c...",
  "proxyHost": "localhost",
  "proxyPort": 10000,
  "headers": {
    "X-Roxy-Token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "X-Roxy-Session": "sess_4f2a1c..."
  },
  "tier": "recon",
  "expiresAt": "2026-03-06T10:00:00.000Z",
  "quotaRemaining": {
    "sessions": 41,
    "reqRes": 2846
  },
  "hostInfo": {
    "geo": "US",
    "browser": "chrome"
  }
}
```

**curl:**

```bash
SESSION=$(curl -s -X POST http://localhost:3000/api/sessions/claim \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"packageId": "pkg_7a3bc...", "geo": "US"}' \
  | jq -r '.sessionId')

echo "Session: $SESSION"
```

---

### Release a session

When you're done with a session, release it back to the pool so the host can serve other buyers.

```
POST /api/sessions/release
Authorization: Bearer <token>
```

**Request body:**

```json
{
  "sessionId": "sess_4f2a1c..."
}
```

**Response 200:**

```json
{
  "message": "Session released",
  "sessionId": "sess_4f2a1c..."
}
```

**curl:**

```bash
curl -X POST http://localhost:3000/api/sessions/release \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"sessionId": "sess_4f2a1c..."}'
```

---

## Making Proxied Requests

Once you have a claimed session, route your HTTP/HTTPS traffic through the Envoy proxy at port 10000. Include your JWT and session ID as headers on every request.

The proxy validates your headers via ext-authz on each request and decrements your req/res quota.

### Required headers

| Header | Description |
|--------|-------------|
| `X-Roxy-Token` | Your buyer JWT (same as your Bearer token) |
| `X-Roxy-Session` | The session ID returned from `/api/sessions/claim` |

### curl — single request

```bash
curl -x http://localhost:10000 \
  -H "X-Roxy-Token: $TOKEN" \
  -H "X-Roxy-Session: $SESSION" \
  https://httpbin.org/ip
```

The response IP address will be the host's network IP, not your own.

### curl — check your apparent IP

```bash
curl -x http://localhost:10000 \
  -H "X-Roxy-Token: $TOKEN" \
  -H "X-Roxy-Session: $SESSION" \
  https://api.ipify.org?format=json
```

### curl — custom headers and POST

```bash
curl -x http://localhost:10000 \
  -H "X-Roxy-Token: $TOKEN" \
  -H "X-Roxy-Session: $SESSION" \
  -H "Content-Type: application/json" \
  -X POST \
  -d '{"key": "value"}' \
  https://httpbin.org/post
```

### Use with Burp Suite

Configure Burp's upstream proxy:

1. Burp → Project Options → Connections → Upstream Proxy Servers
2. Add rule: destination host `*`, proxy host `localhost`, port `10000`
3. Set custom headers on all requests: `X-Roxy-Token: <token>` and `X-Roxy-Session: <sessionId>`

### Use with Python (requests)

```python
import requests

TOKEN = "eyJhbG..."
SESSION = "sess_4f2a1c..."

proxies = {
    "http": "http://localhost:10000",
    "https": "http://localhost:10000",
}

headers = {
    "X-Roxy-Token": TOKEN,
    "X-Roxy-Session": SESSION,
}

response = requests.get("https://httpbin.org/ip", proxies=proxies, headers=headers)
print(response.json())
```

### Rate limits

Rate limits are enforced at Envoy based on your package tier:

| Tier    | Rate Limit |
|---------|------------|
| Scout   | 10 req/s   |
| Recon   | 25 req/s   |
| Breach  | 50 req/s   |
| Siege   | 100 req/s  |

Exceeding the rate limit returns HTTP `429 Too Many Requests`.

---

## Bug Bounties

If you discover a vulnerability while using a Roxy session, you can report it to split the bounty with the host who provided the session.

Default split: **70% buyer / 30% host**

### Report a bounty

```
POST /api/bounties/report
Authorization: Bearer <token>
```

**Request body:**

```json
{
  "sessionId": "sess_4f2a1c...",
  "amount": 50000,
  "proofUrl": "https://hackerone.com/reports/12345678"
}
```

- `amount`: Total bounty amount in **cents** (e.g., `50000` = $500)
- `proofUrl`: Link to the public bug bounty report (HackerOne, Bugcrowd, etc.)

**Response 201:**

```json
{
  "id": "bnty_9e4c...",
  "sessionId": "sess_4f2a1c...",
  "amount_cents": 50000,
  "buyerShare_cents": 35000,
  "hostShare_cents": 15000,
  "splitPercentage": { "buyer": 70, "host": 30 },
  "proofUrl": "https://hackerone.com/reports/12345678",
  "status": "pending",
  "message": "Bounty reported. Call /api/bounties/:id/confirm once you receive the payout."
}
```

**curl:**

```bash
curl -X POST http://localhost:3000/api/bounties/report \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "sessionId": "sess_4f2a1c...",
    "amount": 50000,
    "proofUrl": "https://hackerone.com/reports/12345678"
  }'
```

---

### Confirm a bounty payout

Once you receive the bounty payout from the target program, call this endpoint to credit the host with their share.

```
POST /api/bounties/:id/confirm
Authorization: Bearer <token>
```

**Response 200:**

```json
{
  "id": "bnty_9e4c...",
  "status": "confirmed",
  "hostShare_cents": 15000,
  "message": "Bounty confirmed. Host earnings credited."
}
```

**curl:**

```bash
curl -X POST http://localhost:3000/api/bounties/bnty_9e4c.../confirm \
  -H "Authorization: Bearer $TOKEN"
```

---

### List your bounties

```
GET /api/bounties
Authorization: Bearer <token>
```

Returns bounties you've reported (as a buyer).

**curl:**

```bash
curl http://localhost:3000/api/bounties \
  -H "Authorization: Bearer $TOKEN"
```

---

## Errors

All errors follow a consistent format:

```json
{
  "error": "Error Type",
  "message": "Human-readable description",
  "code": "MACHINE_READABLE_CODE"
}
```

### Common HTTP status codes

| Status | Meaning |
|--------|---------|
| `400` | Bad Request — missing or invalid parameters |
| `401` | Unauthorized — missing, invalid, or expired JWT |
| `402` | Payment Required / Quota Exceeded |
| `403` | Forbidden — you don't have permission to this resource |
| `404` | Not Found — resource doesn't exist |
| `409` | Conflict — duplicate or state conflict |
| `429` | Too Many Requests — rate limit exceeded |
| `503` | Service Unavailable — no sessions in pool, or upstream unreachable |

### Common error codes

| Code | Meaning |
|------|---------|
| `MISSING_HEADERS` | X-Roxy-Token or X-Roxy-Session missing on proxy request |
| `INVALID_TOKEN` | JWT is expired or has invalid signature |
| `SESSION_NOT_FOUND` | Session ID doesn't exist in the pool |
| `SESSION_NOT_CLAIMED` | Session exists but hasn't been claimed |
| `SESSION_NOT_YOURS` | Session is claimed by a different buyer |
| `QUOTA_EXHAUSTED` | No req/res credits remaining on the package |
| `NO_SESSION_CREDITS` | No session claims remaining on the package |
| `NO_SESSIONS` | Session pool is empty — no hosts available |
| `PACKAGE_EXPIRED` | Package has passed its 30-day expiry |
| `AUTHZ_TIMEOUT` | ext-authz could not reach session-manager in time |

---

## Full Example Workflow

```bash
#!/bin/bash
BASE="http://localhost:3000"

# 1. Register
curl -s -X POST $BASE/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"test@test.com","password":"password123","role":"buyer"}' | jq

# 2. Login and store token
TOKEN=$(curl -s -X POST $BASE/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"test@test.com","password":"password123","role":"buyer"}' \
  | jq -r '.token')

# 3. Purchase a Scout package
PKG_ID=$(curl -s -X POST $BASE/api/packages/purchase \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"tier":"scout"}' | jq -r '.id')

echo "Package: $PKG_ID"

# 4. Claim a session
SESSION=$(curl -s -X POST $BASE/api/sessions/claim \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"packageId\":\"$PKG_ID\"}" | jq -r '.sessionId')

echo "Session: $SESSION"

# 5. Make a proxied request
curl -x http://localhost:10000 \
  -H "X-Roxy-Token: $TOKEN" \
  -H "X-Roxy-Session: $SESSION" \
  https://api.ipify.org?format=json

# 6. Release session when done
curl -s -X POST $BASE/api/sessions/release \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"sessionId\":\"$SESSION\"}" | jq
```

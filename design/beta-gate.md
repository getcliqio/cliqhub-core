# Beta Gate — Invite Code Access Control

## Overview

A site-wide gate using a shared secret that restricts access to invited beta testers. Browser users enter the code once and receive a persistent cookie. CLI users send it as a header. When ready to launch publicly, flip one env var and the gate disappears.

## Goals

- Hide the entire site from the public until launch-ready
- Allow a select group of beta testers to use full functionality (browse, build, publish, CLI install)
- Minimize implementation complexity — no schema changes, no per-user invite management
- Easy to remove when transitioning to public launch

## Configuration

Two environment variables:

| Variable | Description | Example |
|---|---|---|
| `BETA_KEY` | The shared access code | `cliqhub-early-2026` |
| `BETA_ENABLED` | Toggle the gate on/off | `true` \| `false` |

Added to `lib/config.ts` alongside existing config values.

## Components

### 1. Next.js Middleware (`middleware.ts`)

Root-level middleware that intercepts every request.

**Logic:**

1. If `BETA_ENABLED` is `false` — pass through immediately (launch mode)
2. Skip requests that must remain accessible:
   - `/_next/` (static assets, chunks)
   - `/favicon.ico`
   - `/beta` (the gate page itself)
   - `/api/beta/verify` (the verification endpoint)
3. For **page requests** — check for `beta_authorized` cookie
   - Present and valid → pass through
   - Missing → redirect to `/beta`
4. For **API requests** (`/api/...`) — check for any of:
   - `x-beta-key` header matching `BETA_KEY` (CLI access)
   - `beta_authorized` cookie (browser access)
   - Valid `Authorization: Bearer ...` token (already-authenticated users)
   - If none match → return `403 { ok: false, error: { code: 'beta_required', message: 'Beta access required' } }`

### 2. Beta Gate Page (`app/beta/page.tsx`)

Client component. Full-screen, minimal design with cliqhub branding.

- Single input field: "Enter access code"
- Submit button
- On submit: `POST /api/beta/verify` with `{ code: <input> }`
- On success (cookie set by response): redirect to `/`
- On failure: display "Invalid access code" error

### 3. Verify Endpoint (`app/api/beta/verify/route.ts`)

- Method: `POST`
- Body: `{ code: string }`
- Compares `code` against `BETA_KEY` env var using constant-time string comparison
- If valid:
  - Sets `beta_authorized` cookie: `httpOnly`, `secure`, `sameSite=lax`, 30-day expiry
  - Returns `{ ok: true }`
- If invalid:
  - Returns `{ ok: false, error: 'Invalid access code' }`

### 4. CLI Integration

Beta testers configure the key via environment variable or cliq config:

```bash
# Option A: env var
export CLIQHUB_BETA_KEY=cliqhub-early-2026

# Option B: cliq config
cliq config set hub_beta_key cliqhub-early-2026
```

The cliq CLI hub client sends `x-beta-key: <key>` header on all hub API requests (install, search, publish).

**Change required in `cliq`:** The hub HTTP client reads the beta key from config/env and attaches the header. When no beta key is configured, the header is omitted (no-op for post-launch).

## Flows

### Browser

```
Visit cliqhub.io
  → middleware checks beta_authorized cookie
  → no cookie
  → redirect to /beta

Enter code on /beta
  → POST /api/beta/verify { code: "cliqhub-early-2026" }
  → server validates, sets beta_authorized cookie (30 days)
  → redirect to /

Subsequent visits
  → middleware checks cookie
  → cookie present and valid
  → pass through to normal site
```

### CLI

```
cliq hub install @cliq/tdd
  → CLI reads CLIQHUB_BETA_KEY from env/config
  → sends x-beta-key header
  → middleware validates header
  → pass through to normal API response
```

### Authenticated User (already logged in)

```
Any request with Authorization: Bearer <token>
  → middleware sees valid auth header
  → pass through (no beta cookie needed)
```

## Files Changed

| File | Type | Description |
|---|---|---|
| `.env` | Modified | Add `BETA_KEY`, `BETA_ENABLED` |
| `lib/config.ts` | Modified | Expose `beta_key` and `beta_enabled` |
| `middleware.ts` | New | Gate logic — cookie/header/token checks |
| `app/beta/page.tsx` | New | Code entry form |
| `app/api/beta/verify/route.ts` | New | Validate code + set cookie |
| `cliq` hub client | Modified | Send `x-beta-key` header if configured |

**No database changes. No changes to existing auth, pages, or API handlers.**

## Security Notes

- The beta key is a shared secret for access gating, not protecting sensitive data. Appropriate for a trusted beta group.
- `httpOnly` cookie prevents client-side JS from reading the token.
- Constant-time comparison prevents timing attacks on the key (precautionary).
- If the code leaks, rotate `BETA_KEY` in the environment. Existing cookies continue to work until expiry; new visitors need the new code.

## Removal on Launch

1. Set `BETA_ENABLED=false` in the environment
2. The middleware becomes a pass-through — zero impact on requests
3. Optionally delete `middleware.ts`, `app/beta/`, and `app/api/beta/` at your convenience
4. Remove `CLIQHUB_BETA_KEY` guidance from beta tester instructions

# Railway Migration: Next.js Monolith → Vite + BFF + Backend

**Status:** Ready to execute
**Branch:** `railway`
**Strategy:** In-place migration of the existing Railway project (no parallel environment)
**Database:** Existing Postgres reused; schema migrated additively, **no reseed**

---

## 1. Context

### What's running today (`production` Railway environment)

| Service        | What it is                                                                | Notes |
|----------------|---------------------------------------------------------------------------|-------|
| `cliqhub-app`  | Old Next.js full-stack app (SSR + API routes in one process, port 3000)   | Source-of-truth for both UI and API. |
| `cliqhub-bff`  | Thin pass-through bff (port 3001) from a previous interim refactor        | Mostly proxies to `cliqhub-app`. |
| `cliqhub-nginx`| Edge router (`$PORT`)                                                     | Env vars: `BFF_UPSTREAM`, `NEXTJS_UPSTREAM`. |
| Postgres       | Railway plugin                                                            | Live data — must be preserved. |

### What the codebase looks like now (post-colleague's refactor)

The Next.js app is gone. The repo is split into:

- **Frontend:** Vite + React SPA at the repo root (`src/`, built via `vite build` → root `dist/`).
- **BFF:** Express on `:3001` at `services/bff/` — sessions, CSRF, **serves the SPA static files** when `STATIC_DIR` is set (`services/bff/src/app.ts:130-137`), proxies `/api/*` to backend.
- **Backend:** Express + Sequelize on `:4000` at `services/backend/` — Postgres, R2/S3, builder LLM (Gemini ADK).
- **Nginx:** Public edge lives in **[getcliqio/cliqhub-nginx](https://github.com/getcliqio/cliqhub-nginx)** (split out of `services/nginx/`). Routes `api.cliqhub.io` / `cliqhub.io` → BFF (and `/v1/sync` → sync).

The frontend never runs as its own server in production — it's baked into the bff image as static files.

### Target topology

```
                          ┌──────────────────────┐
Browser ──────────────►   │  cliqhub-nginx       │  (public, $PORT)
CLI (X-Client: cli) ──►   │  edge router         │
                          └─────────┬────────────┘
                                    │
                ┌───────────────────┴────────────────────┐
                │                                        │
                ▼ (web)                                  ▼ (CLI only)
        ┌──────────────────┐                   ┌────────────────────┐
        │  cliqhub-bff     │                   │                    │
        │  port 3001       │ ─── /api/* ──►   │  cliqhub-backend   │
        │  serves SPA at / │                   │  port 4000         │
        │  + cookie auth   │                   │  Sequelize → PG    │
        └──────────────────┘                   └─────────┬──────────┘
                                                         │
                                                         ▼
                                                ┌─────────────────┐
                                                │  Postgres       │
                                                │  (Railway)      │
                                                └─────────────────┘
```

### Net Railway changes

- **Delete** `cliqhub-app` (no equivalent in the new code).
- **Add** `cliqhub-backend` (new service; didn't exist).
- **Reconfigure** `cliqhub-bff` (new Dockerfile bakes in the SPA, new env vars).
- **Reconfigure** `cliqhub-nginx` (rename `NEXTJS_UPSTREAM` → `BACKEND_UPSTREAM`).
- **Keep** Postgres unchanged.

---

## 2. Code changes (Phase 0)

All changes happen on the `railway` branch. No git operations performed by the assistant.

### 2.1. `services/bff/Dockerfile` — bake the Vite SPA into the image

**Why:** `services/bff/src/app.ts:130-137` already serves `STATIC_DIR` as the SPA — but the current Dockerfile only copies `services/bff/src/`. To embed the frontend, the build context must be the **repo root** so the Dockerfile can see the Vite project.

**Replace** the entire file with a three-stage build:

```dockerfile
# ─── Stage 1: build the Vite SPA from the repo root ─────────────────
FROM node:20-alpine AS frontend-build

WORKDIR /repo
COPY package.json package-lock.json* ./
RUN npm install
COPY tsconfig.json vite.config.ts tailwind.config.ts index.html ./
COPY src ./src
RUN npm run build
# Output: /repo/dist  (the Vite SPA)

# ─── Stage 2: build the bff TypeScript ─────────────────────────────
FROM node:20-alpine AS bff-build

WORKDIR /app
COPY services/bff/package.json services/bff/package-lock.json* ./
RUN npm install
COPY services/bff/tsconfig.json ./
COPY services/bff/src ./src
RUN npm run build
# Output: /app/dist  (the bff JS)

# ─── Stage 3: runtime image ────────────────────────────────────────
FROM node:20-alpine

WORKDIR /app
COPY --from=bff-build /app/dist ./dist
COPY --from=bff-build /app/node_modules ./node_modules
COPY --from=bff-build /app/package.json ./
COPY --from=frontend-build /repo/dist ./spa

CMD ["node", "dist/server.js"]
```

**Notes:**
- Final SPA path is `/app/spa` — this is what `STATIC_DIR` will point at.
- Entrypoint is `dist/server.js` (matches `services/bff/package.json:8` and `services/bff/src/server.ts`). The current `Dockerfile` says `dist/index.js`, which is a typo — gets fixed by this rewrite.

### 2.2. `services/bff/railway.toml` — point at the repo-root build context

```toml
[build]
builder = "dockerfile"
dockerfilePath = "services/bff/Dockerfile"

[deploy]
restartPolicyType = "on_failure"
restartPolicyMaxRetries = 3
startCommand = "node dist/server.js"

[deploy.healthcheck]
path = "/bff-health"
interval = 30
timeout = 5
```

The change vs. the existing file is **only** `dockerfilePath`: was implicit `Dockerfile` (relative to `services/bff/`), now explicit `services/bff/Dockerfile` (relative to repo root).

### 2.3. `services/backend/Dockerfile` — normalize to repo-root build context

For consistency with the bff (so all Railway services share the same Root Directory `/`), update the backend Dockerfile to copy from `services/backend/` paths:

```dockerfile
FROM node:20-alpine AS build

WORKDIR /app
COPY services/backend/package.json services/backend/package-lock.json* ./
RUN npm install
COPY services/backend/tsconfig.json ./
COPY services/backend/src ./src
RUN npm run build

FROM node:20-alpine

WORKDIR /app
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./

RUN mkdir -p /app/data/packages

EXPOSE 4000
CMD ["node", "dist/server.js"]
```

### 2.4. `services/backend/railway.toml` — already added in prior session

Should already exist with:

```toml
[build]
builder = "dockerfile"
dockerfilePath = "services/backend/Dockerfile"

[deploy]
restartPolicyType = "on_failure"
restartPolicyMaxRetries = 3
startCommand = "node dist/server.js"

[deploy.healthcheck]
path = "/health"
interval = 30
timeout = 5
```

If `dockerfilePath` is currently set to just `Dockerfile`, update it to `services/backend/Dockerfile` to match the new build-context convention.

### 2.5. Already-completed prior work (recap, no further action)

These were done in the prior session and are already on the `railway` branch:

- Deleted root `railway.toml` (referenced non-existent `lib/db/migrate.ts`).
- Added `services/backend/railway.toml`.
- `services/backend/src/db/sequelize.ts` — added conditional SSL.
- `services/backend/src/auth/jwt.ts` — fixed jsonwebtoken v9 typing.
- `services/backend/src/repositories/{user,draft}_repository.ts` — Sequelize `Date` → ISO string at the boundary.
- `services/backend/src/controllers/base_controller.ts` — `parse_body` uses `z.infer<S>` so Zod `.default()` resolves correctly.
- `services/backend/src/controllers/teams_controller.ts` — `tag_map` discriminated-union narrowing.

`tsc --noEmit` and `npm run build` both pass clean in `services/backend/`.

### 2.8. BFF type-check fixes (uncovered by local Docker build)

The Phase-0 local Docker build of the bff exposed three pre-existing TypeScript errors. Fixed:

- `services/bff/src/controllers/base_controller.ts` — `parse_body` updated to `<S extends ZodTypeAny>(...): z.infer<S>` (same fix as backend; resolves `builder_controller` errors where Zod `.default()` outputs were being inferred as `undefined`).
- `services/bff/package.json` — added missing `log4js` dependency (used by `src/logging.ts`, which is consumed by `src/beta_page.ts`).

Both bff and backend now build successfully end-to-end:

```bash
docker build -f services/bff/Dockerfile -t cliqhub-bff:local-test .
docker build -f services/backend/Dockerfile -t cliqhub-backend:local-test .
```

The bff image's runtime layout is verified:

```
/app
├── dist/             ← compiled bff
├── node_modules/
├── package.json
└── spa/              ← Vite SPA bundle (STATIC_DIR target)
    ├── index.html
    └── assets/
```

### 2.9. Express 5 wildcard fix (uncovered at runtime, not build-time)

The first deploy of the new bff crashed at startup with:

```
[BFF] Failed to start: PathError [TypeError]: Missing parameter name at index 1: *;
  visit https://git.new/pathToRegexpError for info
  ...
  originalPath: '*'
```

Cause: the bff is on Express 5 (`services/bff/package.json:21`), which upgraded `path-to-regexp` to a major version that removed the legacy bare `'*'` wildcard. The SPA catch-all in `services/bff/src/app.ts` was registered as `app.get('*', …)`, which Express 4 accepted but Express 5 rejects.

Fix in `services/bff/src/app.ts`:

```diff
- app.get('*', (_req, res) => {
+ app.get(/.*/, (_req, res) => {
      res.sendFile(path.join(static_dir, 'index.html'));
  });
```

Equivalent alternatives if you'd rather not use a regex:
- `app.get('/*splat', …)` — Express 5 named-splat syntax.
- `app.use((req, res) => res.sendFile(…))` — drop the method/path entirely.

### 2.10. Lesson: Docker build success ≠ container-start success

The Phase-0 verification used `docker build` only. `tsc` and the Docker layer steps never invoke Express's route compilation, so the path-to-regexp incompatibility wasn't visible until Railway actually started the container.

For future migrations, a "container starts" smoke test belongs in the Phase-0 checklist alongside "container builds":

```bash
# Smoke-test that the bff at least starts (it'll crash later on missing
# DATABASE_URL etc., but route registration runs before any DB connect)
docker run --rm \
    -e PORT=3001 \
    -e BACKEND_URL=http://stub \
    -e SESSION_SECRET=dev \
    -e DATABASE_URL=postgresql://stub \
    -e STATIC_DIR=/app/spa \
    cliqhub-bff:local-test 2>&1 | head -30
```

Look for `[BFF] Listening on :3001` (success) before any DB-related error. If you see a `path-to-regexp`, `helmet`, or other route/middleware error, fix it before pushing.

### 2.6. `internal-docs/architecture.md` — refresh

Existing doc still says "Next.js backend" in the deployment table and references `NEXTJS_UPSTREAM`. Update:

- Replace the Mermaid diagram's "Backend (Next.js)" node with "Backend (Express + Sequelize)".
- Replace `NEXTJS_UPSTREAM` with `BACKEND_UPSTREAM` in the env-vars list.
- Replace the deployment table's port for "Next.js" (3000) with "Backend (Express)" (4000), and add the bff entry's note that it serves the SPA.
- Replace `Next.js: ...` env-var line with `Backend: DATABASE_URL, JWT_SECRET, ALLOWED_ORIGINS, STORAGE_BACKEND, S3_*`.

This is doc-only; no behaviour impact.

### 2.7. `design/railway.md` — mark as historical

The existing `design/railway.md` documents the old Next.js deploy and contradicts this migration plan. Add a one-line banner at the top:

```markdown
> **Historical.** This document describes the legacy Next.js deploy. For the current
> Vite + BFF + Backend architecture, see [`railway-vite-bff-migration.md`](./railway-vite-bff-migration.md).
```

Don't delete — useful reference until cutover is complete.

---

## 3. Railway in-place migration (Phase 1+)

> **Downtime warning.** The downtime window is between **step 5.4** (nginx redeploy with new env) and **step 5.5** (verification passes). Realistically 1–3 minutes if everything is correct, longer if rollback is needed. Plan accordingly.

> **Pre-cutover safety.** All steps before 5.4 are non-disruptive — they add new things and prepare the bff. The current Next.js stack keeps serving traffic until nginx is told to use the new upstreams.

### Step 1 — Confirm the local repo is ready

```bash
cd /Users/elan/src/cliqhub
git status            # confirm you're on the 'railway' branch
git branch --show-current
```

You should be on `railway` with the Phase-0 changes committed (or about to be).

### Step 2 — Link the Railway CLI to the existing project

```bash
railway login         # if not already
railway link          # select existing 'cliqhub-beta' (or whatever) project
railway environment   # confirm 'production' is selected
railway status
```

Expected: linked to the project; environment is `production`.

### Step 3 — Add the new `cliqhub-backend` service

This is purely additive — no public traffic hits it yet.

#### 3.1. Create the service

In the Railway dashboard:

1. Project → **+ New** → **Empty Service**.
2. Name: `cliqhub-backend`.

#### 3.2. Configure the source

Settings → **Source**:

- Repo: same as the other services.
- Branch: `railway`.
- **Root Directory:** `/` (repo root).
- **Config Path:** `services/backend/railway.toml`.

#### 3.3. Set variables

Variables tab:

| Variable                  | Value                                              |
|---------------------------|----------------------------------------------------|
| `DATABASE_URL`            | `${{Postgres.DATABASE_URL}}` (variable reference)  |
| `JWT_SECRET`              | **Reuse** the existing one from `cliqhub-app` (sessions/JWTs minted by old stack must validate on new). Get it via: `railway variables --service cliqhub-app` then copy `JWT_SECRET`. |
| `NODE_ENV`                | `production`                                       |
| `STORAGE_BACKEND`         | `r2`                                               |
| `S3_ENDPOINT`             | `https://<account-id>.r2.cloudflarestorage.com`    |
| `S3_BUCKET`               | `cliqhub-packages` (or whatever you used)          |
| `S3_ACCESS_KEY_ID`        | (your R2 access key)                               |
| `S3_SECRET_ACCESS_KEY`    | (your R2 secret key)                               |
| `ALLOWED_ORIGINS`         | `https://<your-public-domain>` (current prod URL)  |
| `HUG_SERVER_URL`          | `http://${{cliqhub-hug.RAILWAY_PRIVATE_DOMAIN}}:<port>` if HUG is in this Railway project, else its public HTTPS URL. Used **server-to-server** by the backend to mint/revoke HUG tokens. |
| `HUG_ADMIN_KEY`           | The admin key HUG validates on `/admin/*` endpoints. Must byte-match — beware copy/paste whitespace. |
| `HUG_SERVER_PUBLIC_URL`   | The HTTPS URL the **browser/CLI** connects to. Returned in the login response (`auth_service.ts:100`). HUG's CORS config must allow `https://<your-public-domain>` as an origin. |
| `GEMINI_API_KEY`          | Google AI / Gemini API key from `https://aistudio.google.com/apikey`. Required by the builder (`services/backend/src/services/llm/hosted_adapter.ts:36`). Read directly via `process.env`, not through `EnvConfig`. |
| `BUILDER_MODEL`           | Optional. Defaults to `gemini-2.0-flash` (`hosted_adapter.ts:34`). Override only if you need a different Gemini model. |

> **HUG is required for full functionality.** Without `HUG_SERVER_URL` + `HUG_ADMIN_KEY`, the backend boots fine but `/api/hug/*` returns `not_configured` and login responses contain `hug_token: null`. `HUG_SERVER_PUBLIC_URL` never affects the backend itself — only what the browser receives.

> **Builder LLM provider changed.** The old Next.js app used `BUILDER_API_KEY` (and/or `OPENAI_API_KEY`). The new backend uses Google's Gemini via `@google/adk` and reads **`GEMINI_API_KEY`** instead. Copy the Gemini key, not the old OpenAI/Builder key. The backend boots without it, but every `/api/builder/*` request fails with `GEMINI_API_KEY environment variable is not set.` and a startup-time warning is logged.

> **Important on `JWT_SECRET`:** copy the value from `cliqhub-app`. If you generate a fresh one, every existing logged-in user is signed out the moment nginx flips upstreams.

#### 3.4. Deploy

Deploy from the dashboard (or `railway up --service cliqhub-backend`). Wait for the build to finish and the healthcheck on `/health` to pass.

#### 3.5. Sanity-check the backend

From your laptop:

```bash
railway run --service cliqhub-backend curl http://localhost:4000/health
```

Or use the service's internal `RAILWAY_PRIVATE_DOMAIN` from another service in the project. You should get `{"status":"ok"}` (or whatever `HealthController` returns).

### Step 4 — Migrate the schema (no reseed)

Run the schema and migrations against the existing live Postgres. **Do not run `db:bootstrap` or `db:seed`** — the admin user and seeded teams already exist.

```bash
cd /Users/elan/src/cliqhub
railway link              # ensure linked to the project
railway service           # select cliqhub-backend (gives access to its DATABASE_URL)
railway run npm run db:schema
railway run npm run db:migrate
```

What these do:
- `db:schema` runs `lib/schema.sql` which uses `CREATE TABLE IF NOT EXISTS` everywhere — no-op on existing tables, creates anything new.
- `db:migrate` applies every file in `lib/migrations/*.sql` in lexical order — should be idempotent if the colleague's migrations follow that convention.

> **If a migration is non-idempotent and fails because it was already applied:** stop, inspect the failing SQL in `lib/migrations/`, and decide whether to (a) skip it manually or (b) make it idempotent (`ALTER TABLE … IF NOT EXISTS`, etc.) and re-run.

> **Do NOT run** `npm run db:bootstrap` (creates `admin` user — already exists) or `npm run db:seed` (re-uploads `@cliq` team packages — already in R2). The user explicitly opted out of reseeding.

#### 4.1. Verify the schema

```bash
railway run psql $DATABASE_URL -c "\dt"
```

Confirm no missing tables. Compare to `lib/schema.sql` if uncertain.

### Step 5 — Reconfigure & redeploy `cliqhub-bff`

This step makes the bff the new SPA host. The bff is currently passing through to `cliqhub-app`; after this it will serve the SPA itself and proxy API to the new backend.

#### 5.1. Update the source config in the dashboard

Settings → **Source** for `cliqhub-bff`:

- Branch: `railway` (was probably `main`).
- **Root Directory:** `/` (was `services/bff/`).
- **Config Path:** `services/bff/railway.toml` (was implicit).

This is the build-context change that lets the new Dockerfile see the Vite frontend.

#### 5.2. Update variables

Variables tab for `cliqhub-bff`:

| Variable                | Value                                                         | Action |
|-------------------------|---------------------------------------------------------------|--------|
| `DATABASE_URL`          | `${{Postgres.DATABASE_URL}}`                                  | confirm exists |
| `BACKEND_URL`           | `http://${{cliqhub-backend.RAILWAY_PRIVATE_DOMAIN}}:4000`     | **add** |
| `SESSION_SECRET`        | (keep existing)                                               | confirm exists |
| `STATIC_DIR`            | `/app/spa`                                                    | **add** |
| `SESSION_COOKIE_NAME`   | `cliqhub_sid` (or current value)                              | confirm exists |
| `CORS_ORIGINS`          | `https://<your-public-domain>`                                | confirm exists |
| `NODE_ENV`              | `production`                                                  | confirm exists |

> **Don't change** `SESSION_SECRET`. Existing sessions stored in Postgres remain valid.

#### 5.3. Deploy `cliqhub-bff`

From the dashboard: redeploy. Or:

```bash
railway up --service cliqhub-bff
```

Wait for build (longer than before — now also builds the Vite SPA) and healthcheck on `/bff-health`.

#### 5.4. Verify bff serves the SPA

The bff is on the private network only at this point. Use a tunnel / `railway run` to fetch:

```bash
railway run --service cliqhub-bff curl -s http://localhost:3001/ | head -20
```

Should return HTML containing `<div id="root"></div>` from `index.html`. If you get a JSON 404 or a blank, `STATIC_DIR` is misconfigured or the SPA didn't get built.

### Step 6 — Switch the nginx upstreams

**This is the cutover point. Public traffic moves from the old Next.js app to the new stack.**

#### 6.1. Update variables on `cliqhub-nginx`

Variables tab for `cliqhub-nginx`:

| Variable             | Value                                                          | Action |
|----------------------|----------------------------------------------------------------|--------|
| `BFF_UPSTREAM`       | `${{cliqhub-bff.RAILWAY_PRIVATE_DOMAIN}}:3001`                 | confirm/update |
| `BACKEND_UPSTREAM`   | `${{cliqhub-backend.RAILWAY_PRIVATE_DOMAIN}}:4000`             | **add** |
| `NEXTJS_UPSTREAM`    | —                                                              | **delete** (no longer referenced by the new `nginx.conf.template`; harmless if left, cleaner if removed) |
| `PORT`               | (auto-injected by Railway)                                     | leave |

> The new `services/nginx/nginx.conf.template` references `${BACKEND_UPSTREAM}` (line 47) and `${BFF_UPSTREAM}` (line 42). The old `${NEXTJS_UPSTREAM}` is no longer used.
> `services/nginx/entrypoint.sh:14-17` will exit with a fatal error if `BACKEND_UPSTREAM` is missing.

#### 6.2. Confirm source config

Settings → **Source** for `cliqhub-nginx`:

- **Repo:** `getcliqio/cliqhub-nginx` (no longer `cliqhub` + `services/nginx/`)
- **Branch:** `main`
- **Root Directory:** `/` (empty)
- **Config Path:** `railway.toml`

#### 6.3. Redeploy nginx

```bash
railway up --service cliqhub-nginx
```

Adding `BACKEND_UPSTREAM` already triggers a redeploy automatically; this is a manual confirmation.

**Downtime starts here**, ends when the new nginx pod is healthy on `/nginx-health` and routing succeeds.

#### 6.4. Smoke-test the public URL

From your laptop:

```bash
curl -sI https://<your-public-domain>/
curl -sI https://<your-public-domain>/nginx-health
curl -s  https://<your-public-domain>/bff-health
curl -sI https://<your-public-domain>/api/teams/get -X POST -d '{}' -H 'Content-Type: application/json'
curl -s  https://<your-public-domain>/ | grep '<div id="root">'
```

Expected:
- `/` → `200`, returns SPA HTML.
- `/nginx-health` → `200 {"status":"ok"}`.
- `/bff-health` → `200`.
- `/api/teams/get` → `200` JSON list (empty array OK if no public teams).
- HTML contains `<div id="root">`.

Open the site in a browser. Try logging in with an existing account — the same `JWT_SECRET` and `SESSION_SECRET` mean existing sessions/tokens still work.

### Step 7 — Decommission `cliqhub-app`

Once Step 6 verification passes:

#### 7.1. Stop the service (don't delete yet)

Dashboard → `cliqhub-app` → Settings → **Pause Deployments**. This keeps the service available for rollback (Step 8) without serving traffic.

Wait 24 hours of healthy production. If everything's stable:

#### 7.2. Delete the service

Dashboard → `cliqhub-app` → Settings → **Delete Service**.

### Step 8 — Rollback plan (if Step 6 verification fails)

The fastest rollback is to flip nginx back to the old upstream:

1. Reinstate `NEXTJS_UPSTREAM = ${{cliqhub-app.RAILWAY_PRIVATE_DOMAIN}}:3000` on `cliqhub-nginx`.
2. **Revert the nginx repo source** to a commit before Phase-0 changes (the previous nginx config used `NEXTJS_UPSTREAM`). On Railway, switch the nginx service's branch to a tag/commit on `main` that has the old config.
3. Redeploy nginx.

The old `cliqhub-app` is still running (paused or active depending on timing) and will resume serving once nginx points at it again. The `cliqhub-bff` and `cliqhub-backend` services can be left running — they're inert without nginx routing to them.

> **Why the branch/commit revert is needed:** the nginx config template on the `railway` branch no longer references `NEXTJS_UPSTREAM`. Setting the env var alone won't help — you also need a config that uses it. Either keep an "old-nginx" branch parked, or be ready to copy-paste the old `nginx.conf.template` back temporarily.

---

## 4. Env var inventory (post-migration)

### `cliqhub-backend`

**Required:** `DATABASE_URL`, `JWT_SECRET`
**HUG (required for full functionality):** `HUG_SERVER_URL` (server-to-server), `HUG_ADMIN_KEY`, `HUG_SERVER_PUBLIC_URL` (browser-facing — must be HTTPS and CORS-allowed by HUG)
**Builder LLM (required for `/api/builder/*`):** `GEMINI_API_KEY` (Google AI / Gemini key — **not** `BUILDER_API_KEY` or `OPENAI_API_KEY` from the old Next.js app)
**Production:** `NODE_ENV=production`, `ALLOWED_ORIGINS`, `STORAGE_BACKEND=r2`, `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`
**Optional:** `JWT_EXPIRES_IN` (default `30d`), `BUILDER_MODEL` (default `gemini-2.0-flash`), `SEQUELIZE_LOG=1` (verbose SQL), `RATE_LIMIT_PUBLIC_RPM`, `RATE_LIMIT_AUTH_RPM`, `RATE_LIMIT_WINDOW_MS`

### `cliqhub-bff`

**Required:** `DATABASE_URL`, `BACKEND_URL`, `SESSION_SECRET`
**SPA serving:** `STATIC_DIR=/app/spa`
**Production:** `NODE_ENV=production`, `CORS_ORIGINS`, `SESSION_COOKIE_NAME`
**Optional:** `SESSION_TTL_SECONDS` (default `2592000`, 30d), `SESSION_IDLE_SECONDS` (default `7200`, 2h), `RATE_LIMIT_BUILDER_ANON`, `RATE_LIMIT_BUILDER_AUTH`, `RATE_LIMIT_WINDOW_MS`

### `cliqhub-nginx`

**Required:** `BFF_UPSTREAM`, `BACKEND_UPSTREAM`
**Auto:** `PORT`
**Removed:** `NEXTJS_UPSTREAM`

### Postgres

Managed by Railway. `DATABASE_URL` is consumed via `${{Postgres.DATABASE_URL}}` references in the other services.

---

## 5. Verification checklist

Run through after Step 6.4:

- [ ] `curl https://<domain>/nginx-health` returns `200`
- [ ] `curl https://<domain>/bff-health` returns `200`
- [ ] `curl https://<domain>/` returns SPA HTML (contains `<div id="root">`)
- [ ] Browser loads the site, JS executes, no console errors related to assets
- [ ] Existing user can log in (cookie session still valid)
- [ ] `POST /api/teams/get` returns the same teams as before
- [ ] `POST /api/teams/get_by_id` for a known team returns the same data
- [ ] CLI install works: `cliq hub install @cliq/<team> --registry https://<domain>`
- [ ] `GEMINI_API_KEY` is set with no surrounding whitespace: `railway run --service cliqhub-backend sh -c 'echo "GEMINI len: ${#GEMINI_API_KEY}"'` — should print a positive length (typically ~39 chars)
- [ ] Builder page loads and a generate request returns successfully (validates `GEMINI_API_KEY` + Gemini ADK + R2 + Postgres path end-to-end)
- [ ] Admin UI loads and shows users/teams (validates admin role check + DB read)
- [ ] HUG: backend can reach HUG server: `railway run --service cliqhub-backend curl -sI $HUG_SERVER_URL` returns a non-zero HTTP response (any status from HUG itself)
- [ ] HUG: login response includes non-null `hug_token` and `hug_server_url` (run a real login via `POST /api/auth/login` and inspect the JSON)
- [ ] HUG: in the browser, opening a workflow that uses HUG actually establishes a session (validates `HUG_SERVER_PUBLIC_URL` reachability + HUG-side CORS)
- [ ] No errors in `railway logs --service cliqhub-backend`
- [ ] No errors in `railway logs --service cliqhub-bff`
- [ ] No errors in `railway logs --service cliqhub-nginx`

---

## 6. Open risks & mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Migration in `lib/migrations/` is non-idempotent and fails on the live DB | Medium | Run `db:migrate` and watch for failures; have a manual SQL fallback; don't proceed to Step 5 until DB is clean. |
| `JWT_SECRET` accidentally regenerated, signing all users out | Medium | Explicit instruction to copy from `cliqhub-app`. Verify with `railway variables` before Step 3.4. |
| New bff Dockerfile fails to build (Vite + bff multi-stage is new code path) | Medium | Test locally first: `cd /Users/elan/src/cliqhub && docker build -f services/bff/Dockerfile .` before Step 5.3. |
| nginx redeploy without `BACKEND_UPSTREAM` set crashes the entrypoint | Low | Set `BACKEND_UPSTREAM` BEFORE redeploying nginx (Step 6.1 before 6.3). |
| R2 reads work but writes fail because creds were rotated | Low | Confirm R2 credentials are the same ones currently used by `cliqhub-app`. |
| SPA loads but `/api/*` requests fail because `BACKEND_URL` points to wrong host | Low | Verify `BACKEND_URL` in bff variables uses Railway's variable reference, not a literal hostname. |
| Existing sessions break because bff session-table schema changed | Low | If colleague's bff changed the session schema, sessions may need wiping. Acceptable trade-off; users re-login. |
| HUG works server-to-server but browser can't connect | Medium | Manifests only in the browser, never in backend logs. Verify `HUG_SERVER_PUBLIC_URL` is HTTPS and reachable from end users; verify HUG's CORS config allows `https://<your-public-domain>`. Test via a real browser session, not curl. |
| `HUG_ADMIN_KEY` has trailing whitespace from copy/paste | Medium | All `/api/hug/*` calls return 500 with `HUG server error: 401 ...`. Check via `railway run --service cliqhub-backend sh -c 'echo "[$HUG_ADMIN_KEY]"'` — no whitespace inside brackets. |
| Old `BUILDER_API_KEY` / `OPENAI_API_KEY` copied instead of `GEMINI_API_KEY` | High (very easy mistake during migration) | Backend boots and most endpoints work, but `/api/builder/*` returns `generation_failed: GEMINI_API_KEY environment variable is not set.` Watch for the `[builder] GEMINI_API_KEY is not set — builder requests will fail` line in `railway logs --service cliqhub-backend` at startup. |

---

## 7. Post-migration cleanup (after Step 7)

- Update `internal-docs/architecture.md` to remove the "Next.js" deployment table row (already in Phase 0 changes).
- Mark `design/railway.md` as historical (already in Phase 0 changes).
- Consider removing the `cliqhub-app`-specific code paths from any shared scripts (e.g. `scripts/db.ts` — already correct, but worth a final scan).
- ~~Decide whether `services/nginx-hug/` and `services/bff-hug/` are still needed~~ — **removed**; HUG is Hub `/v1/reviews/*` (see `design/hug-deployment.md`).

---

## 8. Quick reference — commands you'll actually run

```bash
# One-time link
cd /Users/elan/src/cliqhub
railway login
railway link
railway environment    # confirm 'production'

# After Phase-0 code is on the 'railway' branch and pushed:

# Step 3.4 — deploy backend
railway up --service cliqhub-backend

# Step 4 — migrate schema (no reseed)
railway service        # select cliqhub-backend
railway run npm run db:schema
railway run npm run db:migrate

# Step 5.3 — redeploy bff with new Dockerfile
railway up --service cliqhub-bff

# Step 6.3 — cutover nginx
railway up --service cliqhub-nginx

# Logs
railway logs --service cliqhub-backend
railway logs --service cliqhub-bff
railway logs --service cliqhub-nginx
```

# Deploying CliqHub to Railway (Beta)

> **Historical.** This document describes the legacy single-process Next.js deploy. It no longer matches the codebase. For the current Vite SPA + BFF + Express backend topology, see [`railway-vite-bff-migration.md`](./railway-vite-bff-migration.md).

This guide covers deploying the CliqHub registry to Railway with PostgreSQL for data and Cloudflare R2 for team package storage.

## Architecture

| Service | Provider | Purpose |
|---------|----------|---------|
| App | Railway | Next.js application — API routes + web frontend |
| PostgreSQL | Railway | Users, teams, versions, tokens, orgs, audit log |
| R2 | Cloudflare | Team package zip storage (persistent across deploys) |
| DNS | Cloudflare | `beta.cliqhub.io` CNAME pointing to Railway |

Railway's filesystem is ephemeral — every redeploy wipes it. Using Cloudflare R2 for package storage ensures uploaded team zips persist across deploys.

## Prerequisites

- A [Railway](https://railway.com) account
- A [Cloudflare](https://dash.cloudflare.com) account with R2 enabled
- The Railway CLI installed locally
- Node.js 18+
- Access to the `cliqhub` git repository

---

## 1. Install the Railway CLI

### macOS

```bash
brew install railway
```

### Other platforms

```bash
npm install -g @railway/cli
```

### Login

```bash
railway login
```

This opens a browser for OAuth. Once authenticated, the CLI stores your session locally.

Verify:

```bash
railway whoami
```

---

## 2. Create the Cloudflare R2 Bucket

### 2a. Create the bucket

1. Go to the [Cloudflare Dashboard](https://dash.cloudflare.com)
2. Navigate to **R2 Object Storage** in the left sidebar
3. Click **Create bucket**
4. Name: `cliqhub-packages`
5. Location hint: **Automatic** (or pick a region close to your Railway deployment)
6. Click **Create bucket**

### 2b. Create R2 API credentials

1. In R2, click **Manage R2 API Tokens** (top right)
2. Click **Create API token**
3. Token name: `cliqhub-railway`
4. Permissions: **Object Read & Write**
5. Specify bucket: select **cliqhub-packages** only (least-privilege)
6. TTL: leave blank for no expiration, or set a reasonable duration
7. Click **Create API Token**
8. **Copy these values immediately** — they are shown only once:
   - **Access Key ID** (looks like `a1b2c3d4e5f6...`)
   - **Secret Access Key** (longer string)

### 2c. Note your R2 endpoint

Your R2 S3-compatible endpoint is:

```
https://<account-id>.r2.cloudflarestorage.com
```

Find your account ID in the Cloudflare dashboard URL: `https://dash.cloudflare.com/<account-id>/...`

You can also find it on the R2 overview page under **Account ID**.

---

## 3. Create the Railway Project

```bash
cd /Users/elan/src/cliqhub
railway init
```

When prompted:
- Select **Create new project**
- Name: `cliqhub-beta` (or your preference)

This links the local directory to the Railway project. The project starts empty — you will add services to it in the next steps.

---

## 4. Add PostgreSQL and Create the App Service

Railway projects contain one or more **services**. You need two: a PostgreSQL database and the CliqHub app service. CLI commands like `railway variables set` and `railway up` operate on a **linked service**, so you must create and link the app service before configuring variables or deploying.

### 4a. Add PostgreSQL

From the Railway dashboard:

1. Open the `cliqhub-beta` project at [railway.com](https://railway.com)
2. Click **+ New** → **Database** → **PostgreSQL**
3. Railway provisions the database and automatically injects `DATABASE_URL` as a reference variable available to other services in the project

Alternatively, from the CLI:

```bash
railway add --database postgres
```

**You do not need to set `DATABASE_URL` manually.** Railway injects it automatically.

### 4b. Create and link the app service

From the Railway dashboard:

1. In the same project, click **+ New** → **Empty Service**
2. Name it `cliqhub-app` (or your preference)

Then link the local directory to the app service so CLI commands target it:

```bash
railway service
```

When prompted, select the `cliqhub-app` service.

Alternatively, create and link in one step from the CLI:

```bash
railway add --service cliqhub-app
```

### 4c. Verify the link and database variable

```bash
railway status
```

You should see the linked project and service. Then verify the database variable is available:

```bash
railway variables list
```

You should see `DATABASE_URL=postgres://...` in the output.

---

## 5. Set Environment Variables

Set all required variables on the linked app service:

```bash
# Authentication — generate a strong random secret
railway variables set JWT_SECRET="$(openssl rand -base64 32)"

# Environment
railway variables set NODE_ENV="production"

# Package storage — Cloudflare R2
railway variables set STORAGE_BACKEND="r2"
railway variables set S3_ENDPOINT="https://<account-id>.r2.cloudflarestorage.com"
railway variables set S3_BUCKET="cliqhub-packages"
railway variables set S3_ACCESS_KEY_ID="<your-r2-access-key-from-step-2b>"
railway variables set S3_SECRET_ACCESS_KEY="<your-r2-secret-key-from-step-2b>"
```

### Optional variables

```bash
# Beta access gate — users must enter this code to sign up
railway variables set BETA_KEY="<your-invite-code>"

# CORS — restrict API access to your domain
railway variables set ALLOWED_ORIGINS="https://beta.cliqhub.io"

# Builder LLM — powers the web-based team builder
railway variables set BUILDER_API_KEY="<your-llm-api-key>"
railway variables set BUILDER_MODEL="<model-name>"
```

### Full variable reference

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DATABASE_URL` | yes | — | PostgreSQL connection string (auto-injected by Railway) |
| `JWT_SECRET` | yes | — | Secret for signing JWT tokens. Must be set in production. |
| `NODE_ENV` | yes | — | Set to `production` |
| `STORAGE_BACKEND` | yes | `local` | Set to `r2` for Cloudflare R2 |
| `S3_ENDPOINT` | yes (r2) | — | Cloudflare R2 S3-compatible endpoint |
| `S3_BUCKET` | yes (r2) | — | R2 bucket name |
| `S3_ACCESS_KEY_ID` | yes (r2) | — | R2 API token access key |
| `S3_SECRET_ACCESS_KEY` | yes (r2) | — | R2 API token secret key |
| `BETA_KEY` | no | — | Invite code required for signup |
| `ALLOWED_ORIGINS` | no | — | Comma-separated list of allowed CORS origins |
| `PACKAGES_PATH` | no | `./data/packages` | Local storage path (only when `STORAGE_BACKEND=local`, ignored for R2) |
| `BUILDER_API_KEY` | no | — | API key for the LLM provider powering the web builder |
| `BUILDER_MODEL` | no | — | Model name for the web builder |
| `OPENAI_API_KEY` | no | — | Alternative to `BUILDER_API_KEY` for OpenAI models |

---

## 6. Deploy

```bash
railway up
```

Railway performs the following steps automatically (configured in `railway.toml`):

1. **Build** — Nixpacks detects the Next.js project, runs `npm install` and `npm run build`
2. **Release** — Runs `npx tsx lib/db/migrate.ts`, which creates or migrates all database tables
3. **Start** — Runs `npm start` (→ `next start`) on port 3000
4. **Health check** — Polls `GET /api/health` every 30 seconds

### What `railway.toml` configures

```toml
[build]
builder = "nixpacks"

[deploy]
startCommand = "npm start"
restartPolicyType = "on_failure"
restartPolicyMaxRetries = 3

[deploy.healthcheck]
path = "/api/health"
interval = 30
timeout = 5

[release]
command = "npx tsx lib/db/migrate.ts"
```

### Monitor the deployment

Watch the build logs in the Railway dashboard, or:

```bash
railway logs
```

---

## 7. Set Up Custom Domain

### 7a. Get the Railway domain

```bash
railway domain
```

This assigns a `*.up.railway.app` URL (e.g., `cliqhub-beta-production.up.railway.app`). Visit it to verify the app is running.

### 7b. Add a custom domain

1. In the Railway dashboard, open the service
2. Go to **Settings → Networking → Custom Domain**
3. Add `beta.cliqhub.io`
4. Railway shows the CNAME target (e.g., `cliqhub-beta-production.up.railway.app`)

### 7c. Configure Cloudflare DNS

1. Go to the [Cloudflare Dashboard](https://dash.cloudflare.com)
2. Select the `cliqhub.io` domain
3. Go to **DNS → Records**
4. Add a record:
   - **Type**: `CNAME`
   - **Name**: `beta`
   - **Target**: the Railway domain from step 7b
   - **Proxy status**: DNS only (gray cloud) — Railway handles TLS, so Cloudflare proxying is not needed. If you want Cloudflare's CDN in front, set to Proxied (orange cloud) and configure SSL mode to **Full (strict)**.
5. Click **Save**

### 7d. Wait for TLS

Railway provisions a TLS certificate automatically via Let's Encrypt. This can take 1–5 minutes after DNS propagation. Check status in the Railway dashboard under the custom domain settings.

### 7e. Update CORS

If you set `ALLOWED_ORIGINS`, make sure it includes the custom domain:

```bash
railway variables set ALLOWED_ORIGINS="https://beta.cliqhub.io"
```

---

## 8. Seed the Built-in Teams

Populate the database with the `@cliq` teams (tdd, tdd-git, full-product, etc.):

```bash
railway run npm run db:seed
```

This runs the seed script against the Railway PostgreSQL database. It creates the `@cliq` scope, inserts team metadata, and uploads the team package zips to R2.

Verify:

```bash
curl https://beta.cliqhub.io/api/teams/list
```

You should see the seeded teams in the response.

---

## 9. Create the Admin User

After seeding, create your admin account. You can do this through the signup flow if `BETA_KEY` is set:

1. Go to `https://beta.cliqhub.io/signup`
2. Enter the beta key, pick a username and password
3. Your account is created as a regular user

Then promote yourself to admin via the database:

```bash
railway run npx tsx -e "
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await pool.query(\"UPDATE users SET role = 'admin' WHERE username = '<your-username>'\");
  console.log('Done');
  await pool.end();
"
```

Or connect directly to the Railway PostgreSQL instance (credentials available in the Railway dashboard under the PostgreSQL service → **Connect**).

---

## 10. Verify the Full Stack

### Health check

```bash
curl https://beta.cliqhub.io/api/health/check
```

### Team listing

```bash
curl https://beta.cliqhub.io/api/teams/list
```

### Team download (via cliq CLI)

```bash
cliq hub install @cliq/tdd --registry https://beta.cliqhub.io
```

### Login via cliq CLI

```bash
cliq hub login --registry https://beta.cliqhub.io
```

---

## Ongoing Operations

### Redeploying

Push changes and redeploy:

```bash
cd /Users/elan/src/cliqhub
railway up
```

Or connect a GitHub repo in the Railway dashboard for automatic deploys on push.

### Viewing logs

```bash
railway logs          # live tail
railway logs -n 100   # last 100 lines
```

### Running migrations

Migrations run automatically on every deploy via the `[release]` command in `railway.toml`. To run manually:

```bash
railway run npx tsx lib/db/migrate.ts
```

### Connecting to the database

Get the connection string from the Railway dashboard (PostgreSQL service → **Connect** tab), or:

```bash
railway run psql $DATABASE_URL
```

### Updating environment variables

```bash
railway variables set KEY="value"
```

Changes trigger an automatic redeploy.

### Scaling

Railway auto-scales within your plan limits. For the beta, the default single instance is sufficient. If you need more:

1. Railway dashboard → Service → **Settings → Scaling**
2. Adjust replicas, memory, and CPU limits

Note: with multiple replicas, ensure `JWT_SECRET` is the same across all instances (it is — Railway injects the same env vars to all replicas of a service).

---

## Cost Estimate (Beta)

| Resource | Railway plan | Estimated cost |
|----------|-------------|----------------|
| App (Next.js) | Hobby / Pro | ~$5/month (low traffic) |
| PostgreSQL | Included | ~$5/month (small DB) |
| R2 storage | Cloudflare free tier | Free up to 10 GB storage + 10M reads/month |
| Custom domain | Included | Free (TLS via Let's Encrypt) |

For a beta with a handful of users, you're looking at roughly **$10/month** on Railway with R2 storage effectively free.

---

## Troubleshooting

| Issue | Fix |
|-------|-----|
| `No service linked` when running CLI commands | Run `railway service` to link a service. Most CLI commands (`variables`, `up`, `logs`, `domain`) require a linked service. See step 4b. |
| `Unauthorized` after `railway login` | Clear stale config with `rm -rf ~/.config/railway ~/.railway`, then `railway login` again. If `railway add` still fails with Unauthorized, use the dashboard instead (known CLI bug). |
| Build fails with missing dependencies | Nixpacks may skip devDependencies when `NODE_ENV=production` is set. If `tsx` (used by the migration release command) is not found, either move it to `dependencies` or set `NIXPACKS_NODE_ENV=development` as a build-time variable in Railway so devDependencies are installed during build. |
| `FATAL: JWT_SECRET environment variable is required` | Set it: `railway variables set JWT_SECRET="$(openssl rand -base64 32)"` |
| Migration fails | Check `railway logs` for the error. Common cause: `DATABASE_URL` not injected — verify the PostgreSQL database service is attached to the project. |
| R2 PUT/GET fails with 403 | Verify `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, and `S3_ENDPOINT`. Ensure the API token has Object Read & Write on the correct bucket. |
| Health check failing | The app may still be starting. Check `railway logs`. The health endpoint is `GET /api/health/check`. |
| Custom domain shows Railway 404 | DNS hasn't propagated yet. Wait a few minutes. Verify the CNAME is correct with `dig beta.cliqhub.io`. |
| TLS certificate not provisioning | Ensure the CNAME is pointing to the Railway domain (not an IP). Railway needs the DNS record to exist before it can issue the cert. |
| `cliq hub install` fails against beta | Make sure you're passing `--registry https://beta.cliqhub.io`. The CLI defaults to the production registry URL. |

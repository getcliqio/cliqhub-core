# CliqHub — page-by-page HTML copy of the live UI

Base screens are a **fidelity pass** of the live Hub (copied from `src/`).

**Proposed layer** explores a **Teams-first realm**: opening a realm lands on
**Teams**. Tabs are **Teams · Security · Advanced** (daemons). Install + Run
happen on Teams; capacity is claimed automatically. Enqueue API uses **flat
fields** (`team_id`, `inputs`, `workspace_path`) — not a nested `payload` bag.

No build step, no backend. The only network dependency is the Tailwind CDN.

## Open it

```bash
open design/hub-site-mock/index.html
```

Tailwind loads from `https://cdn.tailwindcss.com`, so the first open needs network access
or the page renders unstyled.

## What was copied from where

| Mock screen | Source file |
| --- | --- |
| Shell grid (`.app-shell` / `.app-top` / `.app-side` / `.app-main` / `.app-main-inner`) | `src/index.css` (verbatim), `src/layouts/product_shell.tsx` |
| Top bar | `src/components/app_top_bar.tsx` |
| Sidebar | `src/components/app_sidebar.tsx` |
| Home | `src/pages/home_dashboard_page.tsx` |
| Getting started | `src/components/getting_started_panel.tsx` |
| Teams (my teams) | `src/pages/account/teams_page.tsx` |
| Realms list | `src/pages/account/realms_page.tsx` |
| Realm header + tabs | `src/layouts/realm_layout.tsx` |
| Realm overview / security / members / tokens / bindings | `src/pages/account/realm_detail_page.tsx` |
| Daemons list | `src/pages/account/daemons_page.tsx` |
| Daemon detail | `src/pages/account/daemon_detail_page.tsx` |
| Runs list | `src/pages/runs/runs_page.tsx` |
| Run detail | `src/pages/runs/run_detail_page.tsx` |
| Human Reviews (HUG) | `src/pages/reviews_page.tsx` |
| Review detail | `src/pages/review_detail_page.tsx` |
| Organizations | `src/pages/account/orgs_page.tsx` |
| Settings + tabs | `src/pages/account/account_page.tsx`, `src/pages/account/settings_page.tsx`, `src/pages/account/notification_settings_page.tsx` |
| Admin dashboard / users / orgs / teams / audit | `src/pages/admin/*.tsx` |
| Shared chrome | `src/components/ui/page_header.tsx`, `src/components/ui/breadcrumbs.tsx`, `src/components/ui/help_tip.tsx` |

Sidebar icons are hand-inlined SVGs approximating the lucide glyphs used in
`PRIMARY_ITEMS` and `ADMIN_ITEMS` (Home, UsersRound, Map, GitPullRequest, Building2,
Settings, LayoutDashboard, Users, Package, Shield, Rocket, FileText), in the same order
and the same slots.

As in the live product with an onboarded account, **Getting started is not in the primary
nav** — it lives in the sidebar footer next to Documentation. The route is still reachable
from there.

## Routes

Hash routes mirror the real paths in `src/router.tsx`. One `.screen` section is visible at
a time; unknown routes fall back to `#/home`.

**Current experience**

- `#/home`
- `#/getting-started`
- `#/teams`
- `#/realms`
- `#/realms/acme-prod`
- `#/realms/acme-prod/daemons`
- `#/realms/acme-prod/daemons/mac-lab`
- `#/realms/acme-prod/runs`
- `#/realms/acme-prod/runs/run_a91c`
- `#/realms/acme-prod/logs`
- `#/realms/acme-prod/notifications`
- `#/realms/acme-prod/security`
- `#/realms/acme-prod/security/members`
- `#/realms/acme-prod/security/tokens`
- `#/realms/personal`
- `#/realms/staging`
- `#/hug`
- `#/reviews/rev_12`
- `#/notifications`
- `#/organizations`
- `#/settings`
- `#/docs` (stub so the sidebar footer link does not dead-end)

**Admin — only when Role = Site admin**

- `#/admin`
- `#/admin/accounts`
- `#/admin/orgs`
- `#/admin/teams`
- `#/admin/audit`

**Proposed — only when Layer = + Proposed fleet install / realm-first**

- `#/realms/acme-prod` → redirects to `#/realms/acme-prod/teams`
- `#/realms/acme-prod/teams` — Teams work surface; **team name → Runs?team=**; **View team** → detail
- `#/realms/acme-prod/teams/claims-intake` · `#/…/teams/smoke` — team install / manage
- `#/realms/acme-prod/runs` — canonical run list with filters
- `#/realms/acme-prod/runs?team=acme/claims-intake` — same list, auto-filtered from Teams
- `#/realms/acme-prod/runs/run_a91c` — run detail; **logs on the run**
- `#/realms/acme-prod/runs/run_a91c/logs` — same run, scrolls to Logs
- `#/realms/acme-prod/logs` — retired tab → points at run logs
- `#/realms/acme-prod/fleet-install` (+ progress / result)

Hierarchy in proposed: **Teams** (schedule) · **Runs** (one filtered list) · run detail (**logs**). No duplicate team-owned run tables.

## Current vs Proposed

The **Layer** toggle in the dark mock strip above the top bar controls what the mock shows.
The choice persists in `localStorage` under `hub_mock_layer`. Default is **Current**, so the
first impression is the product as it exists today.

- **Current** — only the live experience. Team installs happen one daemon at a time from a
  daemon detail page. Every `data-proposed` block is hidden and the proposed
  routes redirect to the realm overview.
- **+ Proposed** — Teams-first realm: landing is Teams; Security + Advanced remain.
  Fleet install + schedule-run panel (inputs before enqueue). Amber badges mark proposed UI.

What the proposed layer adds:

- Realm default route → **Teams**
- Slim realm tabs: **Teams · Runs · Security · Advanced**
- Teams: install / schedule; **Runs →** shortcuts into filtered Runs
- **Runs**: canonical list with team / status / search filters
- Run detail with **Logs on the run**
- Fleet-install flow (picker → progress → result)
- Flat enqueue API sketch (no nested `payload`)

Two invariants hold in both layers:

- Per-daemon install on the daemon detail page is unchanged. Fleet install does not
  replace it.
- Offline / stale daemons are never queued. The proposed flow lists them as skipped and
  says to install from the daemon page once they reconnect.

The **Role** toggle switches Member ↔ Site admin. Site admin reveals the amber `Site admin`
pill in the top bar, the amber `Site Admin` line and Admin nav section in the sidebar, and
the `Admin` entry in the account menu. Switching back to Member while on an admin route
bounces to Home.

## Sample data

Two-plus realms so Home renders the multi-realm table (not the single-realm card):

| Realm | State | Status light |
| --- | --- | --- |
| `acme-prod` (Acme Production) | 3 of 4 daemons online (`mac-lab`, `gpu-01`, `edge-west` online; `build-box` stale), 2 live runs with 1 awaiting input, 2 pending reviews | amber — needs attention |
| `personal` | 1 daemon online, idle, all clear | emerald with ping |
| `staging` | 0 online, stale 6 days — inactive, hidden until **Show inactive** | slate |

Teams are `@acme/claims-intake` v2.4.0, `@acme/nightly-recon` v1.7.2, and
`@sapan/scratch-pad` v0.3.1, plus one draft. The blocked run is `run_a91c`, blocked by
review `rev_12`.

## What is interactive

Everything else is inert on purpose — the point is layout fidelity, not a working app.

- Layer and Role toggles
- Home realm row expansion and the **Show inactive** switch
- Top bar account menu
- Daemon detail: Install Team, Init Workspace, and Supply Inputs dialogs
- Run detail: Unblock (supply inputs) and Cancel confirm
- Settings tabs (Profile / Security / Notifications)
- Proposed fleet install progress simulation
- Realm Teams: Run panel + mock “Schedule run” toast

## Notes for reviewers

- The Home hero is `bg-slate-950` and contains only the greeting and the fleet tagline.
  There is deliberately no KPI grid there — KPI tiles live in the realm overview hero,
  which is where the live product puts them.
- The sidebar is white, matching `app_sidebar.tsx`. Any dark-sidebar mock you remember is
  older and wrong.
- Realm-scoped screens repeat the `RealmLayout` header and tab bar and *then* their own
  breadcrumbs, because that is what the nested route actually renders.
- Coverage in the proposed table counts online daemons only, which is why
  `@acme/claims-intake` reads 2 of 3 rather than 2 of 4.
- Every listed route renders real mock UI. There are no placeholder or lorem screens.

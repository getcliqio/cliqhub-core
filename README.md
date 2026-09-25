# cliqhub-core

CliqHub **Core API** (`@getcliqio/backend`) — Express + Sequelize + `@getcliqio/cliq-store`.

Also contains **`sync/`** (Railway `cliqhub-sync`) until it gets its own repo.

Hub **design / SLICE docs** live under [`design/`](./design/) (moved here from the retired `cliqhub` monorepo).

## Develop

```bash
npm ci   # needs GITHUB_TOKEN for @getcliqio/cliq-store
npm test
npm run build
```

## Railway

- **cliqhub-backend**: this repo root, `railway.toml` / `Dockerfile`
- **cliqhub-sync**: root directory `sync`, config `sync/railway.toml`

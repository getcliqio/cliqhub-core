# Library + Hub repo split

## Libraries (from former platform workspaces)

| Repo | Package |
|------|---------|
| [getcliqio/cliq-sdk](https://github.com/getcliqio/cliq-sdk) | `@getcliqio/cliq-sdk` |
| [getcliqio/cliq-store](https://github.com/getcliqio/cliq-store) | `@getcliqio/cliq-store` |
| [getcliqio/cliq-docker](https://github.com/getcliqio/cliq-docker) | `@getcliqio/cliq-docker` |

Platform (`getcliqio/cliq`) retains **cli** + **daemon** only. Release order:

1. Tag/publish `cliq-sdk`, `cliq-store`, `cliq-docker` at `vX.Y.Z`
2. `npm run release -- X.Y.Z` in platform (pins + tags; Actions publish `@getcliqio/cliq` + SEA)

## Hub

| Repo | Role |
|------|------|
| [cliqhub-core](https://github.com/getcliqio/cliqhub-core) | Core API (+ sync) |
| [cliqhub-bff](https://github.com/getcliqio/cliqhub-bff) | BFF; embeds SPA |
| [cliqhub-frontend](https://github.com/getcliqio/cliqhub-frontend) | Vite SPA |
| [cliqhub-nginx](https://github.com/getcliqio/cliqhub-nginx) | Public edge |

Legacy `getcliqio/cliqhub` is a pointer / archive after cutover.

## Hub cutover checklist

1. Railway `cliqhub-backend` → `getcliqio/cliqhub-core` (root)
2. Railway `cliqhub-sync` → `getcliqio/cliqhub-core` (root dir `sync`)
3. Railway `cliqhub-bff` → `getcliqio/cliqhub-bff` (+ `GH_TOKEN` build secret)
4. Railway `cliqhub-nginx` → `getcliqio/cliqhub-nginx` (already)
5. Confirm `cliqhub-frontend` builds via BFF image

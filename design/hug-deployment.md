# HUG deployment (archived)

**Status: removed from cliqhub.** The standalone `services/nginx-hug/` and
`services/bff-hug/` stacks were deleted. Human Gate (HUG) reviews run on the
main Hub plane:

- Hub Core / BFF: `POST|GET /v1/reviews/*`
- Hub SPA: Events → HUG tab / review detail

Do not recreate an isolated nginx→bff→hug edge in this repo. If a separate
HUG product deploy still exists, it lives outside cliqhub (e.g. `cliqhug/`),
not under `cliqhub/services/`.

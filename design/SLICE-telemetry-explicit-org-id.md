# SLICE: Telemetry explicit `org_id` + drop header tenancy (TEL-ORG)

**Status:** implemented on branch `slice/telemetry-explicit-org-id` — **not** merged to `main`  
**Rule:** hard-cut — `POST /v1/runs/get_telemetry` `kind: summary` requires body `org_id`  
**Out:** `kind: usage | spans` (run_id keyed); `get_logs` (realm_id keyed, no invent)

## Checklist

- [x] Core schema + assert + unit
- [x] SPA home Telemetry_block
- [x] OpenAPI + suites + push

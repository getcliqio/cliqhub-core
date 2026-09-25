# DAE-ENV — Daemons `{ ok, data }` envelope

**Status:** Planned  
**Umbrella:** [`SLICE-invent-controllers-envelope.md`](./SLICE-invent-controllers-envelope.md)  
**Depends on:** DAE-S0 + DAE-ORG — done  
**Hard-cut:** `{ ok, data }` — enroll/register/heartbeat are **CLI/daemon contract** paths

## Architecture

1. **Needed?** Envelope parity on existing `/v1/daemons/*`.  
2. **Merged?** Do not collapse register/heartbeat/get into one path.  
3. **Model?** Public `/v1`; daemon Bearer PAT; BFF passthrough for SPA.  
4. **Hard-cut?** Yes — **endpoint-cli-contract-tests** required (enroll, register, heartbeat, get).

## Endpoints (map every method)

| Concern | Today (typical) | After |
|---------|-----------------|-------|
| List | `{ daemons }` / flat | `DaemonData[]` (or `PagedData` only if pagination already exists — do not invent) |
| One | `{ daemon }` | `DaemonData` |
| Ack / heartbeat / deregister | `{ ok: true }` | `BooleanData` |
| Register result | `{ daemon }` / token fields | One `DaemonData` or dedicated register DTO in `data` — **no** parallel top-level keys |

## GitNexus / callers

| Check | Baseline |
|-------|----------|
| `impact` DaemonController | Graph LOW — **treat as HIGH wire risk** |
| Path callers | `cliq-platform` enroll/register/heartbeat; SPA daemons pages; BFF e2e `realms_daemons.spec`; Core tests; docs |

## Deliverables

1. `schemas/daemons/data.ts`; finish `.describe` on inputs; JSDoc **all** handlers (close S0 debt)  
2. `this.ok` + `ApiRequest`/`ApiOkResponse`  
3. Platform daemon client + tests updated in **same** PR/branch set  
4. OpenAPI + docs push  
5. Verify Core + BFF unit/e2e + SPA + `cliq-platform` `test:all` + enroll/register smoke proof

## Done when

Daemon boot/enroll path green against new envelope; no flat `{ daemon }` success in Core.

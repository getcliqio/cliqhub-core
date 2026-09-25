# Design: Builder Phase Attribute Schema

## Purpose

Define the exact set of attributes shown in the CliqHub builder's right-hand panel when a user selects a phase, based on the phase's `type` and `agent` combination. Each attribute is tagged as **required** or **optional**.

This schema is derived from the cliq orchestrator (`src/commands/orchestrator.ts`), workflow parser (`src/core/workflow_parser.ts`), workflow reader (`src/workflow/workflow_reader.ts`), and individual agent implementations.

---

## How the Orchestrator Dispatches Phases

The orchestrator builds a `PhaseDispatch` for every phase with these fields from the YAML:

- `role` — expanded from `roles/<phase-name>.md` (always attempted for all phase types)
- `sources` — from phase YAML
- `target_entries` — from phase YAML
- `action` — from phase YAML
- `commands` — from phase YAML
- `model` — from phase YAML

For `type: team`, it additionally sends `team_ref` and `team_inputs`.

For `type: gate`, a separate `GateDispatch` is built with `check_results`, `route_targets`, and optionally `review`.

**Connector hooks**: For CLI agents (cursor, claude-code, gemini, codex), if a phase has `sources` or `target_entries`, the orchestrator spawns a connector agent as a pre/post hook. The CLI agent itself never sees sources/targets — they're consumed by the hook.

---

## Schema Per Type + Agent

### `type: standard` + LLM agent (cursor, claude-code, gemini, codex, claude-api, gemini-api, openai-api)

The primary work phase. An LLM agent executes based on a role briefing.

| Attribute | Required/Optional | Notes |
|-----------|------------------|-------|
| `role` | **required** | The briefing/instructions for the LLM agent. Read from `roles/<phase-name>.md`. |
| `model` | optional | LLM model override (e.g. `gpt-4o`, `claude-sonnet`). |
| `sources` | optional | Data sources fetched via connector pre-hook before the agent runs. |
| `target_entries` | optional | Data targets written via connector post-hook after the agent completes. |
| `commands` | optional | Pre/post shell commands (not executed by the agent itself). |
| `max_iterations` | optional | Only meaningful when `commands` is present — retry loop cap. |

**NOT shown**: `review`, `team`, `action`, `inputs`

---

### `type: standard` + `agent: exec`

Shell command execution only. No LLM, no role.

| Attribute | Required/Optional | Notes |
|-----------|------------------|-------|
| `commands` | **required** | Shell commands to execute sequentially. |
| `max_iterations` | optional | Retry loop cap (re-run commands on failure). |

**NOT shown**: `role`, `model`, `sources`, `target_entries`, `review`, `team`, `action`, `inputs`

---

### `type: standard` + connector agent (jira, confluence, zendesk, datadog, hubspot, gdrive, s3, mesh)

Structured data connector. Fetches/pushes data via API. No LLM involvement.

| Attribute | Required/Optional | Notes |
|-----------|------------------|-------|
| `action` | **required** | The connector operation (e.g. `get_issue`, `query_metrics`, `create_page`). |
| `sources` | **required** | Data source entries with `name`, `ref`/`url`. |
| `target_entries` | optional | Data target entries for write operations. |

**NOT shown**: `role`, `model`, `commands`, `max_iterations`, `review`, `team`, `inputs`

---

### `type: standard` + `agent: curl`

HTTP fetch connector. No `action` field (implied by URL).

| Attribute | Required/Optional | Notes |
|-----------|------------------|-------|
| `sources` | **required** | URLs to fetch from. |
| `target_entries` | optional | Where to write responses. |

**NOT shown**: `role`, `model`, `commands`, `max_iterations`, `review`, `team`, `action`, `inputs`

---

### `type: gate` + LLM agent (default — cursor, claude-code, gemini, codex, etc.)

Automated quality gate. Runs commands, LLM agent evaluates results and issues a verdict.

| Attribute | Required/Optional | Notes |
|-----------|------------------|-------|
| `commands` | **required** | Evidence checks (e.g. `npm test`, `npm run lint`). Results shown to the gate agent. |
| `max_iterations` | optional | Verdict loop cap (default 3, max 5). |
| `role` | optional | Evaluation criteria for the gate agent. Orchestrator auto-injects verdict protocol. |
| `model` | optional | LLM model override for the gate agent. |

**NOT shown**: `review`, `sources`, `target_entries`, `team`, `action`, `inputs`

---

### `type: gate` + `agent: hug`

Human-in-the-loop review gate. A human reviewer (not an LLM) approves/rejects.

| Attribute | Required/Optional | Notes |
|-----------|------------------|-------|
| `review` | **required** | Nested block containing `reviewer` (required), `artifacts`, `timeout`, `remind_every`. |
| `commands` | optional | Evidence checks shown to the human reviewer alongside artifacts. |
| `max_iterations` | optional | Review loop cap (reviewer can route to revision and re-review). |
| `role` | optional | Evaluation guidance shown to the human reviewer. |

**NOT shown**: `model`, `sources`, `target_entries`, `team`, `action`, `inputs`

---

### `type: team` + `agent: team` (or no agent — defaults to `team`)

Delegates to a sub-team. The role file becomes the "spec" passed to the sub-team.

| Attribute | Required/Optional | Notes |
|-----------|------------------|-------|
| `team` | **required** | Team reference (e.g. `@acme/security-scan`, `feature-dev-js`). |
| `inputs` | optional | Key-value pairs passed to the sub-team. Supports `$(inputs.*)` templates. |
| `role` | optional | Used as the sub-team's "spec" document. The team agent reads `ctx.role` to build the spec. |

**NOT shown**: `model`, `commands`, `max_iterations`, `sources`, `target_entries`, `review`, `action`

---

## Validation Rules (from `workflow_parser.ts`)

These constraints are enforced at parse time by cliq:

1. **`type: team` requires `team` field** — error if missing.
2. **`team` field is ONLY valid on `type: team`** — error if present on standard/gate.
3. **`type: gate` + `agent: hug` requires `review.reviewer`** — error if missing or empty.
4. **`review` block is ONLY valid on `gate` + `agent: hug`** — error if present on any other combination.
5. **Gate commands must NOT set `escalate_on_fail`** — gate command outcomes are evaluated by the agent, not the orchestrator.
6. **Support phases must NOT have `depends_on`** — they're activated by gate routing.

---

## Attribute Exclusivity Rules

These are hard constraints — an attribute in the "NOT shown" list for a schema must NEVER appear:

| Attribute | Only valid when |
|-----------|----------------|
| `review` | `type: gate` + `agent: hug` |
| `team` | `type: team` |
| `action` | connector agent (jira, confluence, zendesk, datadog, hubspot, gdrive, s3, mesh) |
| `inputs` (phase-level) | `type: team` |

---

## Schema Must Inform ALL Validation — Not Just the UI

The schema is not only a UI concern. It must also drive validation in:

1. **CliqHub backend `builder_service.ts`** — validate generated/edited phases against the schema (e.g. don't require `role` for exec/connector agents).
2. **Cliq `src/builder/validator.ts`** — the existing "No role file for phase" warning is partially schema-aware (it already skips `agent: exec` and gates with commands) but it does NOT skip connector agents (jira, confluence, zendesk, datadog, hubspot, gdrive, s3, mesh, curl) which also have no role. This produces a spurious warning like:

   ```
   Valid with 1 warning
   No role file for phase "setup"
   ```

   ...even when "setup" is an exec or connector phase that by definition has no role.

### Fix Required in `cliq/src/builder/validator.ts`

The role-check loop (line ~151) currently only exempts:
- `phase.agent === 'exec'`
- `type: gate` with commands

It must ALSO exempt any agent for which `role` is in the "NOT shown" list per this schema:
- All connector agents: jira, confluence, zendesk, datadog, hubspot, gdrive, s3, mesh, curl

The cleanest approach: maintain a `ROLE_EXEMPT_AGENTS` set (or derive it from the schema) and skip the warning when `phase.agent` is in that set.

### Gaps in `cliq/src/builder/` (the generation engine)

The cliq builder has partial schema awareness but several gaps:

**1. Validator (`validator.ts`) — incomplete role exemptions**

The role-check loop exempts:
- `phase.agent === 'exec'` (line 157)
- `type: gate` with commands (lines 154-156)

It does NOT exempt connector agents. This produces spurious "No role file for phase" warnings for phases like:
```yaml
- name: fetch-data
  agent: gdrive
  sources: [...]
```

**Fix**: Add a `ROLE_EXEMPT_AGENTS` set containing all connector agents (`jira`, `confluence`, `zendesk`, `datadog`, `hubspot`, `gdrive`, `s3`, `mesh`, `curl`) and skip the role warning when `phase.agent` is in that set.

**2. Types (`types.ts`) — missing connector fields**

`GeneratedPhase` does NOT declare `sources`, `target_entries`, or `action`. The parser extracts these from LLM output (parser.ts lines 160-175), but without type declarations TypeScript provides no compile-time safety:

```typescript
// Current GeneratedPhase — missing fields
export interface GeneratedPhase {
    name: string;
    type: 'standard' | 'gate' | 'team';
    depends_on: string[];
    agent?: string;
    commands?: { ... }[];
    max_iterations?: number;
    is_support?: boolean;
    review?: GeneratedReviewBlock;
    team?: string;
    inputs?: Record<string, string>;
    // MISSING: sources, target_entries, action
}
```

**Fix**: Add to `GeneratedPhase`:
```typescript
sources?: { url: string; name: string; format?: string }[];
target_entries?: { file: string; to: string; mode?: string; name?: string }[];
action?: string;
```

**3. Serializer (`serializer.ts`) — doesn't emit connector fields**

`serialize_phase()` emits `commands`, `review`, `team`, `inputs` — but NOT `sources`, `target_entries`, or `action`. This means if the LLM generates a connector phase, those fields are silently dropped from the YAML output.

**Fix**: Add serialization for `sources`, `target_entries`, and `action` in `serialize_phase()`:
```typescript
if (p.sources?.length) { phase.sources = p.sources; }
if (p.target_entries?.length) { phase.target_entries = p.target_entries; }
if (p.action) { phase.action = p.action; }
```

**4. Validator (`validator.ts`) — no connector-specific validation**

The validator checks exec (must have commands), hug (must have reviewer), and team (must have team ref). But there is no validation for connector phases:
- Connector phases SHOULD have `sources` or `target_entries` (at least one).
- Connector phases with a direct `agent:` set SHOULD have `action`.
- Connector phases SHOULD NOT have `role` entries.

**Fix**: Add connector-specific validation rules.

---

### Shared Schema Source of Truth

To avoid drift between cliq and cliqhub, the schema rules should be expressed as a single reference (this document). Both codebases derive their validation logic from these rules:

| Codebase | File | What it does |
|----------|------|-------------|
| cliq | `src/builder/validator.ts` | Warns on missing required attrs, suppresses warnings for irrelevant attrs |
| cliqhub backend | `services/backend/src/services/builder_service.ts` | Validates generated phases against schema |
| cliqhub frontend | `src/lib/agent_schema.ts` | Drives UI rendering and required/optional badges |

---

## UI Ordering Rules

**Required attributes render first, optional attributes below.** Within each tier, attributes are ordered by semantic closeness — related fields stay grouped together, not sorted alphabetically.

### Ordering per schema:

**`standard` + LLM agent:**
```
── Required ──
  role

── Optional ──
  model
  commands / max_iterations   ← grouped (max_iterations only shown when commands exist)
  sources
  target_entries
```

**`standard` + `exec`:**
```
── Required ──
  commands

── Optional ──
  max_iterations
```

**`standard` + connector (jira, gdrive, etc.):**
```
── Required ──
  action
  sources

── Optional ──
  target_entries
```

**`standard` + `curl`:**
```
── Required ──
  sources

── Optional ──
  target_entries
```

**`gate` + LLM agent:**
```
── Required ──
  commands

── Optional ──
  max_iterations
  role
  model
```

**`gate` + `hug`:**
```
── Required ──
  review

── Optional ──
  commands / max_iterations   ← grouped
  role
```

**`team` + `team`:**
```
── Required ──
  team

── Optional ──
  inputs
  role
```

### Grouping rule

When two attributes are semantically coupled (e.g. `commands` and `max_iterations`, or `action` and `sources`), they must appear adjacent regardless of their required/optional status. The group's position is determined by the highest-priority member (required > optional, then declaration order within tier).

---

## Field Tooltips

Every attribute section header includes an info icon (ⓘ) that reveals a tooltip on hover describing what the field does and how it's used at runtime. This provides inline documentation without cluttering the UI.

### Tooltip descriptions per attribute (context-sensitive)

Some fields have different meanings depending on the phase type/agent. The tooltip should reflect the current context.

#### `role`

| Context | Description |
|---------|-------------|
| `standard` + LLM agent | The briefing and instructions for the AI agent. Defines identity, objectives, deliverables, and constraints. Stored in `roles/<phase-name>.md`. |
| `gate` + LLM agent | Evaluation criteria for the gate agent. Should include verdict instructions (PASS / ROUTE / ESCALATE). The orchestrator auto-injects the verdict protocol. |
| `gate` + `hug` | Evaluation guidance shown to the human reviewer alongside artifacts. Should describe what "good" looks like and when to approve, request changes, or escalate. |
| `team` + `team` | The requirement specification passed to the sub-team. NOT agent instructions — write as an actionable spec describing what the sub-team should accomplish. |

#### `commands`

| Context | Description |
|---------|-------------|
| `standard` + LLM agent | Shell commands run as pre/post hooks around the agent. Results are logged but don't block the agent. |
| `standard` + `exec` | The phase's primary work. Commands run sequentially — this is all the phase does. No agent involvement. |
| `gate` + LLM agent | Evidence checks (e.g. `npm test`, `npm run lint`). Results are passed to the gate agent for verdict evaluation. |
| `gate` + `hug` | Evidence checks run before the human reviewer sees the phase. Results are shown alongside artifacts to provide context. |

#### `max_iterations`

| Context | Description |
|---------|-------------|
| `standard` + `exec` | Number of times to retry commands on failure before escalating. |
| `gate` (any agent) | Maximum verdict loop iterations. Each iteration re-runs commands and re-evaluates. Default 3, max 5. |

#### `sources`

| Context | Description |
|---------|-------------|
| `standard` + LLM agent | External data fetched via a connector pre-hook before the agent runs. Content lands in `.cliq/pull/<name>/`. |
| `standard` + connector | Data source entries to fetch. Each has a URL (HTTP, gdrive://, jira://) and a name for local storage. |
| `standard` + `curl` | URLs to fetch. Content is downloaded and stored locally for downstream phases. |

#### `target_entries`

| Context | Description |
|---------|-------------|
| `standard` + LLM agent | External destinations where results are pushed via a connector post-hook after the agent completes. |
| `standard` + connector | Write destinations. Each entry maps a local file to a remote URI (gdrive://, gdoc://, sharepoint://). Modes: create, append, replace. |
| `standard` + `curl` | Destinations to POST/PUT results to after fetch completes. |

#### `action`

| Context | Description |
|---------|-------------|
| `standard` + connector | The connector operation to perform. Examples: `get_issue` (jira), `create_page` (confluence), `query_metrics` (datadog), `upload` (s3). |

#### `review`

| Context | Description |
|---------|-------------|
| `gate` + `hug` | Human review configuration block. Contains: `reviewer` (who reviews — maps to hug settings), `artifacts` (files/dirs shown to reviewer), `timeout` (max wait time), `remind_every` (reminder interval). |

#### `review.reviewer`

| Context | Description |
|---------|-------------|
| `gate` + `hug` | The reviewer identity — a name defined in your hug settings (e.g. "architects", "product-leads"). Maps to a Slack channel or user group. |

#### `review.artifacts`

| Context | Description |
|---------|-------------|
| `gate` + `hug` | File paths or directories shown to the human reviewer. These are the primary materials for review (e.g. `src/`, `.cliq/channels/dev--review/handoff.md`). |

#### `review.timeout`

| Context | Description |
|---------|-------------|
| `gate` + `hug` | Maximum time to wait for a human verdict before auto-escalating. Format: duration string (e.g. "2h", "30m", "1d"). |

#### `review.remind_every`

| Context | Description |
|---------|-------------|
| `gate` + `hug` | How often to send reminder notifications if no verdict has been received. Format: duration string (e.g. "30m", "1h"). |

#### `model`

| Context | Description |
|---------|-------------|
| `standard` + LLM agent | Override the LLM model for this phase (e.g. `gpt-4o`, `claude-sonnet-4`, `gemini-2.5-pro`). If unset, the agent uses its default model. |
| `gate` + LLM agent | Override the LLM model for the gate evaluation agent. Useful for using a stronger model for quality judgments. |

#### `team`

| Context | Description |
|---------|-------------|
| `team` + `team` | Scoped reference to the sub-team to launch (e.g. `@acme/security-audit`, `@local/feature-dev`). Must be an installed team. |

#### `inputs`

| Context | Description |
|---------|-------------|
| `team` + `team` | Key-value pairs passed to the sub-team at launch time. Values support templates: `$(inputs.*)` (parent inputs), `$(dirs.*)` (directory paths). |

### Design

- Icon: small `ⓘ` (info circle) rendered inline after the section label, before the required/optional badge.
- Interaction: hover reveals a tooltip with the description text. On touch devices, tap to toggle.
- Style: muted color (gray) so it doesn't compete with the label or badge for attention.

---

## Implementation Plan

### Phase 1: Schema Definition (cliqhub)

**File**: `src/lib/agent_schema.ts`

Replace the current (incorrect) schema with the corrected one from this design doc.

**Data structure:**

```typescript
interface AttributeDef {
    name: AttributeName;
    required: boolean;
    tooltip: string;         // context-sensitive description
    group?: string;          // semantic grouping key (e.g. "commands_group")
}

interface AgentSchema {
    attributes: AttributeDef[];   // ordered: required first, then optional, respecting groups
}

type SchemaKey = string;  // "${type}:${agent}" or "${type}:default"

const SCHEMAS: Record<SchemaKey, AgentSchema> = { ... };
```

**Schema entries to define** (7 total):
1. `standard:default` — LLM agents (cursor, claude-code, gemini, codex, claude-api, gemini-api, openai-api)
2. `standard:exec`
3. `standard:connector` — shared by jira, confluence, zendesk, datadog, hubspot, gdrive, s3, mesh
4. `standard:curl`
5. `gate:default` — LLM gate agents
6. `gate:hug`
7. `team:default` — team agent (or no agent specified)

**Lookup logic:**
1. Try `${type}:${agent}` exact match
2. If agent is in `CONNECTOR_AGENTS` set → use `standard:connector`
3. Fall back to `${type}:default`

**Connector agent set** (shared constant):
```typescript
const CONNECTOR_AGENTS = new Set([
    'jira', 'confluence', 'zendesk', 'datadog',
    'hubspot', 'gdrive', 's3', 'mesh',
]);
```

**Exports:**
- `get_agent_schema(type, agent)` → `AgentSchema`
- `get_tooltip(type, agent, attribute)` → `string`
- `CONNECTOR_AGENTS` set (reused by validator)

---

### Phase 2: UI Components (cliqhub frontend)

**File**: `src/components/builder/phase_editor.tsx`

#### 2a. Section header component

Replace current `SectionLabel` with an enhanced version:

```
[Label] ⓘ [required badge | optional badge]
```

- `ⓘ` icon triggers tooltip on hover (use existing tooltip primitive or add a lightweight one)
- Badge: small pill — green "required" or gray "optional"
- Tooltip text sourced from `get_tooltip(phase.type, phase.agent, attribute)`

#### 2b. Attribute rendering driven by schema

```typescript
const schema = get_agent_schema(phase.type, phase.agent);

// Render attributes in schema.attributes order (already sorted: required first, grouped)
for (const attr of schema.attributes) {
    render_section(attr);
}
```

Remove all existing hardcoded conditional logic (`show('commands') &&`, `show('review') &&`, etc.) and replace with a single loop over `schema.attributes`.

#### 2c. New UI sections needed

These sections don't exist yet in `phase_editor.tsx`:

| Section | UI element | Notes |
|---------|-----------|-------|
| `action` | Text input | Free-form connector action string |
| `sources` | List editor | Each entry: `url` (text), `name` (text), `format` (dropdown: auto/raw) |
| `target_entries` | List editor | Each entry: `file` (text), `to` (text), `mode` (dropdown: create/append/replace), `name` (text) |
| `team` | Text input | Scoped team reference (e.g. `@acme/team-name`) |
| `inputs` | Key-value editor | Dynamic key-value pairs, values support template syntax |
| `model` | Text input or dropdown | Model identifier string |

#### 2d. Data preservation on agent switch

When user changes agent dropdown:
- New schema is computed
- Sections not in new schema are HIDDEN (CSS display:none or conditional render)
- Underlying data is NOT cleared from state
- If user switches back, previous values reappear

---

### Phase 3: Backend Validation (cliqhub backend)

**File**: `services/backend/src/services/builder_service.ts`

Update validation to use the same schema rules:

1. Import or duplicate the `CONNECTOR_AGENTS` set
2. Don't require `role` for exec or connector phases
3. Require `action` for connector phases (when agent is directly set)
4. Require `sources` for connector and curl phases
5. Require `review.reviewer` for `gate` + `hug`
6. Require `team` for `type: team`
7. Require `commands` for `exec`

---

### Phase 4: Fix cliq builder (cliq repo)

**File**: `src/builder/validator.ts`

1. Add `CONNECTOR_AGENTS` set (or `ROLE_EXEMPT_AGENTS`)
2. In the role-check loop (~line 151), add exemption:
   ```typescript
   if (ROLE_EXEMPT_AGENTS.has(phase.agent ?? '')) continue;
   ```
3. Add connector-specific validation:
   - Connector phase without `sources` and without `target_entries` → warning
   - Connector phase with a `role` entry → warning ("connector phases don't use roles")

**File**: `src/builder/types.ts`

Add missing fields to `GeneratedPhase`:
```typescript
sources?: { url: string; name: string; format?: string }[];
target_entries?: { file: string; to: string; mode?: string; name?: string }[];
action?: string;
```

**File**: `src/builder/serializer.ts`

Add serialization in `serialize_phase()`:
```typescript
if (p.sources?.length) { phase.sources = p.sources; }
if (p.target_entries?.length) { phase.target_entries = p.target_entries; }
if (p.action) { phase.action = p.action; }
```

---

### Phase 5: Tests

#### cliqhub frontend (`tests/agent-schema.test.ts`)

Rewrite to match the corrected schema:
- Verify each schema key returns correct attributes in correct order
- Verify required/optional status for each attribute
- Verify tooltip text is non-empty for every attribute in every schema
- Verify connector agent lookup resolves to `standard:connector`
- Verify fallback chain works (`type:agent` → `type:default`)

#### cliqhub frontend (`src/components/builder/__tests__/phase_editor.test.tsx`)

- Switching agent to `exec` hides role, shows commands as required
- Switching agent to `jira` hides role/commands, shows action/sources as required
- Switching agent to `hug` on gate shows review as required
- Switching to `team` type shows team field as required
- Tooltip renders on hover of ⓘ icon
- Previous field data preserved when switching agents and back

#### cliq (`tests/builder/validator.test.ts`)

- Connector phase without role → no warning
- Connector phase without sources → warning
- Exec phase without role → no warning (already passes)
- New `sources`/`target_entries`/`action` fields round-trip through parser → serializer

---

### Execution Order

| Step | Repo | Scope | Depends on |
|------|------|-------|-----------|
| 1 | cliqhub | Rewrite `agent_schema.ts` | — |
| 2 | cliqhub | Rewrite `phase_editor.tsx` rendering | Step 1 |
| 3 | cliqhub | Add tooltip component + wiring | Step 2 |
| 4 | cliqhub | Add new section UIs (action, sources, targets, team, inputs, model) | Step 2 |
| 5 | cliqhub | Update backend validation | Step 1 |
| 6 | cliqhub | Write/update tests | Steps 1-5 |
| 7 | cliq | Fix `validator.ts` (role exemptions + connector checks) | — |
| 8 | cliq | Fix `types.ts` + `serializer.ts` (missing fields) | — |
| 9 | cliq | Write/update builder tests | Steps 7-8 |

Steps 1-6 (cliqhub) and steps 7-9 (cliq) can proceed in parallel.

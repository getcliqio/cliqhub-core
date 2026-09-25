# CliqHub — Taxonomy Unification Sync

## Context

The `cliq` CLI has completed a breaking taxonomy change (see `cliq/design/DESIGN-taxonomy-unification.md`). Phase types have been consolidated from six (`standard`, `gate`, `hug`, `exec`, `pull`, `push`) down to three (`standard`, `gate`, `team`). The old type-specific behaviors are now expressed via the `agent` field:

| Old syntax | New syntax |
|---|---|
| `type: hug` + nested `review:` block | `type: gate` + `agent: hug` + flat `reviewer`, `artifacts`, `timeout`, `remind_every` |
| `type: exec` | `type: standard` + `agent: exec` |
| `type: pull` | `type: standard` + connector agent (`gdrive`, `s3`, `confluence`, `curl`) |
| `type: push` | `type: standard` + connector agent + `target_entries` |
| `source_entries` | `sources` (rename) |
| nested `review:` block | flat fields on the phase |

CliqHub must be updated to understand, display, validate, and emit the new format — while transparently handling teams already published in the old format.

---

## Backward Compatibility Strategy

**Normalize on read.** A shared `normalize_phase()` function (same transforms as `cliq migrate`) runs whenever cliqhub loads a team — from the database, from a package upload, from a draft, or from LLM output. The UI and backend exclusively work with the new format internally.

- **Old teams**: normalized at read time → UI sees new format
- **New teams**: pass through unchanged (normalization is idempotent)
- **On publish/save**: written in the new format
- **Removal timeline**: once all stored teams have been republished (or a one-time batch migration is run), the normalization layer is removed. It is temporary scaffolding, not permanent complexity.

The normalization function:

```typescript
function normalize_phase(raw: Record<string, unknown>): Record<string, unknown> {
    const phase = { ...raw };

    // source_entries → sources
    if ('source_entries' in phase) {
        phase.sources = phase.source_entries;
        delete phase.source_entries;
    }

    // type: hug → type: gate + agent: hug + flatten review
    if (phase.type === 'hug') {
        phase.type = 'gate';
        phase.agent = 'hug';
        const review = phase.review as Record<string, unknown> | undefined;
        if (review) {
            if (review.reviewer) phase.reviewer = review.reviewer;
            if (review.artifacts) phase.artifacts = review.artifacts;
            if (review.timeout) phase.timeout = review.timeout;
            if (review.remind_every) phase.remind_every = review.remind_every;
            delete phase.review;
        }
        return phase;
    }

    // type: exec → type: standard + agent: exec
    if (phase.type === 'exec') {
        phase.type = 'standard';
        phase.agent = 'exec';
        return phase;
    }

    // type: pull → type: standard + inferred connector agent
    if (phase.type === 'pull') {
        phase.type = 'standard';
        phase.agent = infer_agent_from_sources(phase.sources);
        return phase;
    }

    // type: push → type: standard + inferred connector agent
    if (phase.type === 'push') {
        phase.type = 'standard';
        phase.agent = infer_agent_from_targets(phase.targets ?? phase.target_entries);
        return phase;
    }

    // Flatten review: block on any remaining phase
    if (phase.review && typeof phase.review === 'object') {
        const review = phase.review as Record<string, unknown>;
        if (review.reviewer) phase.reviewer = review.reviewer;
        if (review.artifacts) phase.artifacts = review.artifacts;
        if (review.timeout) phase.timeout = review.timeout;
        if (review.remind_every) phase.remind_every = review.remind_every;
        delete phase.review;
    }

    return phase;
}
```

---

## File-by-File Changes

### 1. Frontend Types — `src/lib/types.ts`

- Remove `PullEntry`, `PushEntry`, `ReviewBlock` interfaces.
- Update `WorkflowPhase.type`: `'standard' | 'gate' | 'team'`.
- Remove `review?: ReviewBlock` from `WorkflowPhase`.
- Add flat HUG fields: `reviewer?: string | string[]`, `artifacts?: string[]`, `timeout?: string`, `remind_every?: string`.
- Rename `targets?` to `target_entries?` for alignment with the SDK.

### 2. Builder Store — `src/lib/builder/store.tsx`

- Remove `PullEntry`, `PushEntry`, `GeneratedReviewBlock` interfaces.
- Update `GeneratedPhase.type`: `'standard' | 'gate' | 'team'`.
- Remove `review?: GeneratedReviewBlock` from `GeneratedPhase`.
- Add flat HUG fields: `reviewer?: string`, `artifacts?: string[]`, `timeout?: string`, `remind_every?: string`.
- Add unified `SourceEntry` and `TargetEntry` interfaces if needed.

### 3. Team Export — `src/lib/team_export.ts`

- Remove `PullEntry`, `PushEntry`, `ExportReviewBlock` interfaces.
- Update `ExportPhase` type, remove `review?`, add flat fields.
- Rewrite `serialize_phase()`:
  - Emit `sources:` based on field presence (not `type === 'pull'`).
  - Emit `target_entries:` based on field presence (not `type === 'push'`).
  - Emit flat HUG fields at phase level instead of nested `review:` block.

### 4. Builder Phase Editor — `src/components/builder/phase_editor.tsx`

- Remove `TYPE_BADGE_STYLES` entries for `hug`, `exec`, `pull`, `push`. Add `team`.
- Rewrite `validate_phase()`:
  - `agent === 'hug'` requires `reviewer`.
  - `agent === 'exec'` requires `commands`.
  - Connector agents require `sources` or `target_entries`.
- Agent dropdown: show for `standard` and `gate`, hide for `team`.
- Review section: show when `phase.agent === 'hug'`, read/write flat fields.
- Pull/Push sections: show based on `sources`/`target_entries` presence, not type.
- `ReviewSection` component: read/write flat fields directly on phase.

### 5. Builder Phase Node — `src/components/builder/phase_node.tsx`

- Remove STYLES entries for `hug`, `exec`, `pull`, `push`. Add `team`.
- Optionally derive accent color from `agent` field for visual differentiation (e.g., `agent === 'hug'` → violet, `agent === 'exec'` → emerald).

### 6. Builder Canvas View — `src/components/builder/canvas_view.tsx`

- Update MiniMap `nodeColor`: remove `exec`, `pull`, `push` cases.
- Optionally color by agent field instead.

### 7. Builder YAML View — `src/components/builder/yaml_view.tsx`

- Serialization: emit sources/targets based on field presence, not type. Emit flat HUG fields instead of nested `review:`.
- Parsing: accept only `standard`, `gate`, `team`. Read flat HUG fields. Run `normalize_phase()` on parsed phases for backward compat with pasted old YAML.

### 8. Team Actions — `src/components/team_actions.tsx`

- Update inline phase interface type union → `'standard' | 'gate' | 'team'`.
- Remove `review?` from inline interface, add flat HUG fields.
- Update mapping logic to pass flat fields.

### 9. Workflow Graph — `src/components/workflow_graph.tsx`

- Remove `PHASE_STYLES` entries for `hug`, `exec`, `pull`, `push`. Add `team`.
- Expanded detail panel: read flat fields (`phase.reviewer`, `phase.artifacts`, etc.) instead of `phase.review.*`.
- Show review details when `phase.agent === 'hug'`.

### 10. Backend Builder Service — `services/backend/src/services/builder_service.ts`

- Update `GeneratedPhase.type` → `'standard' | 'gate' | 'team'`.
- Remove `GeneratedReviewBlock` interface and `parse_review()` helper.
- Add flat HUG fields to `GeneratedPhase`.
- Update `valid_types` → `['standard', 'gate', 'team']`.
- Rewrite validation:
  - `agent === 'exec'` requires commands.
  - `agent === 'hug'` warns if no reviewer.
  - Connector agents require sources/targets.
  - `phases_needing_roles`: skip `agent === 'exec'` and connector agents.
- Update `parse_phases()`: accept only new types, read flat HUG fields, call `normalize_phase()` for safety.
- Update LLM prompt templates to align with the new cliq builder prompts.

### 11. Normalization Utility — `src/lib/normalize_phase.ts` (new, shared)

- Shared `normalize_phase()` function used by both frontend and backend.
- Also export `normalize_phases(phases: unknown[]): Phase[]` convenience wrapper.
- Idempotent — new format passes through unchanged.

### 12. Backend Tests

| File | Changes |
|------|---------|
| `services/backend/tests/unit/services/builder_service.test.ts` | Rewrite fixtures: `type: 'pull'` → `type: 'standard', agent: 'curl'`; `type: 'push'` → `type: 'standard', agent: 'gdrive'`; `type: 'hug'` → `type: 'gate', agent: 'hug'` + flat fields; `type: 'exec'` → `type: 'standard', agent: 'exec'`; remove nested `review:` |
| `services/backend/tests/integration/builder.test.ts` | Update `valid_chat_response` fixture: `type: 'exec'` → `type: 'standard', agent: 'exec'` |

### 13. BFF Layer (no changes expected)

The BFF HUG service/controller manages HUG tokens and status — no phase taxonomy logic. Confirm no phase type enums exist in `services/bff/src/types/`.

---

## Implementation Plan

### Phase 1: Shared Normalization Layer

**Goal:** A single, well-tested function that converts old-format phases to new-format, usable from both frontend and backend.

#### 1.1 Create `src/lib/normalize_phase.ts`

```typescript
export interface SourceEntry {
    url: string;
    name: string;
    format?: 'auto' | 'raw';
    headers?: Record<string, string>;
}

export interface TargetEntry {
    file: string;
    to: string;
    mode?: 'create' | 'append' | 'replace';
    name?: string;
    on?: 'pass';
}

/**
 * Infer connector agent from source/target URL patterns.
 * Falls back to 'curl' for unrecognizable patterns.
 */
function infer_agent(entries: { url?: string; to?: string; ref?: string }[]): string;

/**
 * Transform a single phase from old taxonomy to new.
 * Idempotent — new-format phases pass through unchanged.
 */
export function normalize_phase(raw: Record<string, unknown>): Record<string, unknown>;

/**
 * Convenience wrapper: normalize an array of phase objects.
 */
export function normalize_phases(phases: unknown[]): Record<string, unknown>[];
```

Transforms applied:
- `source_entries` → `sources`
- `type: hug` → `type: gate` + `agent: hug` + flatten `review:`
- `type: exec` → `type: standard` + `agent: exec`
- `type: pull` → `type: standard` + inferred agent from `sources`
- `type: push` → `type: standard` + inferred agent from `targets`/`target_entries`
- Stray `review:` block on any phase → flatten to top-level fields

#### 1.2 Create `services/backend/src/utils/normalize_phase.ts`

Same logic, ESM/Node format. Can be a direct copy or a shared package — for now, a copy is simplest since cliqhub doesn't consume cliq as a dependency.

#### 1.3 Unit tests

- `src/__tests__/normalize_phase.test.ts` (frontend)
- `services/backend/tests/unit/utils/normalize_phase.test.ts`

Test cases:
- Each old type converts correctly
- `source_entries` renames to `sources`
- Nested `review:` flattens
- Already-migrated phases pass through unchanged
- Phases with no changes return identical objects
- Agent inference from various URL patterns (gdrive, s3, confluence, curl fallback)

---

### Phase 2: Frontend Types & Store

**Goal:** Update the type system so the entire frontend operates on the new schema.

#### 2.1 Update `src/lib/types.ts`

- Remove `PullEntry`, `PushEntry`, `ReviewBlock` interfaces.
- Import/inline `SourceEntry` and `TargetEntry` from normalize_phase (or redefine).
- Change `WorkflowPhase`:

```typescript
export interface WorkflowPhase {
    name: string;
    type: 'standard' | 'gate' | 'team';
    depends_on?: string[];
    commands?: { name: string; run: string; scope?: string; if?: string; escalate_on_fail?: boolean }[];
    max_iterations?: number;
    agent?: string;
    sources?: SourceEntry[];
    target_entries?: TargetEntry[];
    // Flat HUG fields
    reviewer?: string | string[];
    artifacts?: string[];
    timeout?: string;
    remind_every?: string;
    // Team fields
    team?: string;
    inputs?: Record<string, string>;
    is_support?: boolean;
}
```

#### 2.2 Update `src/lib/builder/store.tsx`

- Remove `PullEntry`, `PushEntry`, `GeneratedReviewBlock`.
- Change `GeneratedPhase`:

```typescript
export interface GeneratedPhase {
    name: string;
    type: 'standard' | 'gate' | 'team';
    depends_on: string[];
    commands?: { name: string; run: string; scope?: string; escalate_on_fail?: boolean }[];
    max_iterations?: number;
    agent?: string;
    sources?: SourceEntry[];
    target_entries?: TargetEntry[];
    // Flat HUG fields
    reviewer?: string;
    artifacts?: string[];
    timeout?: string;
    remind_every?: string;
    // Team fields
    team?: string;
    inputs?: Record<string, string>;
    is_support?: boolean;
    pending?: boolean;
}
```

#### 2.3 Fix compilation

Address all TypeScript errors surfaced by the type changes. This will cascade into the component files updated in Phase 4.

---

### Phase 3: Serialization & Export

**Goal:** The YAML emitted by cliqhub always conforms to the new schema.

#### 3.1 Rewrite `src/lib/team_export.ts`

- Remove `PullEntry`, `PushEntry`, `ExportReviewBlock`.
- Update `ExportPhase` to match new schema.
- Rewrite `serialize_phase()`:
  - Always emit `type:` and `agent:` (if present).
  - Emit `sources:` when `phase.sources` exists (not gated by type).
  - Emit `target_entries:` when `phase.target_entries` exists (not gated by type).
  - Emit flat HUG fields (`reviewer:`, `artifacts:`, `timeout:`, `remind_every:`) at phase indentation level.
  - Never emit nested `review:` block.

#### 3.2 Rewrite `src/components/builder/yaml_view.tsx`

**Serialization (state → YAML string):**
- Same rules as 3.1.

**Parsing (YAML string → state):**
- Accept `type:` values: `standard`, `gate`, `team`.
- Read `agent:`, `reviewer:`, `artifacts:`, `timeout:`, `remind_every:` as top-level phase fields.
- After parsing, run `normalize_phases()` on the result to handle cases where a user pastes old-format YAML.

---

### Phase 4: UI Components

**Goal:** The builder UI adapts its form fields based on the `type` + `agent` combination, making invalid configurations impossible to construct.

#### 4.1 Phase Editor — `src/components/builder/phase_editor.tsx`

**Agent-driven form rendering:**

The editor conditionally renders sections based on the selected agent. This replaces the current approach of showing everything and relying on post-hoc validation.

| type + agent | Sections rendered |
|---|---|
| `standard` + no agent / `cursor` / `claude-code` / `gemini` / `codex` | Agent dropdown, Role editor, Commands (optional), Retry toggle, Dependencies |
| `standard` + `exec` | Commands (required), Retry toggle, Dependencies |
| `standard` + connector (`curl`, `gdrive`, `s3`, `confluence`, `jira`) | Sources editor, Target entries editor, Dependencies |
| `gate` + no agent (LLM gate) | Agent dropdown, Commands (required), Role editor, Dependencies |
| `gate` + `hug` | Reviewer (required), Artifacts, Timeout, Remind Every, Dependencies |
| `gate` + `exec` | Commands (required), Dependencies |
| `team` | Team reference (required), Inputs mapping, Dependencies |

**Implementation approach:**

```typescript
function get_editor_sections(phase: GeneratedPhase): EditorSection[] {
    if (phase.type === 'team') {
        return ['team_ref', 'inputs', 'dependencies'];
    }

    if (phase.agent === 'hug') {
        return ['reviewer', 'artifacts', 'timeout', 'remind_every', 'dependencies'];
    }

    if (phase.agent === 'exec') {
        return ['commands_required', 'retry', 'dependencies'];
    }

    const connectors = new Set(['curl', 'gdrive', 's3', 'confluence', 'jira', 'zendesk', 'datadog', 'hubspot']);
    if (phase.agent && connectors.has(phase.agent)) {
        return ['sources', 'target_entries', 'dependencies'];
    }

    // LLM agent (standard or gate)
    return ['agent_dropdown', 'role', 'commands_optional', 'retry', 'dependencies'];
}
```

Each section is a self-contained component. The editor renders only the sections returned by `get_editor_sections()`.

**Validation (on "Add to Team" click):**

```typescript
function validate_phase(phase: GeneratedPhase): string[] {
    const errors: string[] = [];

    if (phase.type === 'team') {
        if (!phase.team) errors.push('Team phases require a team reference');
        return errors;
    }

    if (phase.agent === 'hug') {
        if (!phase.reviewer) errors.push('HUG gates require a reviewer');
        return errors;
    }

    if (phase.agent === 'exec') {
        if (!phase.commands?.length) errors.push('Exec phases require at least one command');
        return errors;
    }

    const connectors = new Set(['curl', 'gdrive', 's3', 'confluence', 'jira', 'zendesk', 'datadog', 'hubspot']);
    if (phase.agent && connectors.has(phase.agent)) {
        if ((!phase.sources || phase.sources.length === 0) && (!phase.target_entries || phase.target_entries.length === 0)) {
            errors.push('Connector phases require at least one source or target');
        }
        return errors;
    }

    // LLM phases: gate requires commands or role, standard requires role
    if (phase.type === 'gate' && !phase.commands?.length) {
        errors.push('Gate phases require at least one command (or use agent: hug for human review)');
    }

    return errors;
}
```

**Type badge styling:**

```typescript
const TYPE_BADGE_STYLES: Record<string, string> = {
    standard: 'bg-slate-100 text-slate-600',
    gate:     'bg-amber-100 text-amber-700',
    team:     'bg-indigo-100 text-indigo-700',
};

// Agent-specific accent (optional override for visual continuity)
const AGENT_BADGE_STYLES: Record<string, string> = {
    hug:        'bg-violet-100 text-violet-700',
    exec:       'bg-emerald-100 text-emerald-700',
    curl:       'bg-sky-100 text-sky-700',
    gdrive:     'bg-sky-100 text-sky-700',
    s3:         'bg-sky-100 text-sky-700',
    confluence: 'bg-sky-100 text-sky-700',
    jira:       'bg-orange-100 text-orange-700',
};
```

The badge shows the type, with an additional smaller agent pill when an agent is set.

**Phase type selector (for adding new phases):**

The "Add Phase" dropdown becomes:

- Standard Phase (LLM agent does the work)
- Gate Phase (verification checkpoint)
- Team Phase (delegates to a sub-team)

After selecting a type, if it's `standard` or `gate`, the user picks an agent from the dropdown (or leaves it as default). The form sections update immediately.

#### 4.2 Phase Node — `src/components/builder/phase_node.tsx`

- Styles keyed by type: `standard`, `gate`, `team`.
- Secondary accent derived from `agent` field (border color or small dot indicator).
- Badge text shows type; agent shown as a subtitle or secondary pill.

```typescript
const STYLES: Record<string, { bg: string; border: string; badge: string; selected_border: string }> = {
    standard: { bg: 'bg-white',       border: 'border-slate-300', badge: 'bg-slate-100 text-slate-600', selected_border: 'border-indigo-500' },
    gate:     { bg: 'bg-amber-50',    border: 'border-amber-300', badge: 'bg-amber-100 text-amber-700', selected_border: 'border-amber-500' },
    team:     { bg: 'bg-indigo-50',   border: 'border-indigo-300', badge: 'bg-indigo-100 text-indigo-700', selected_border: 'border-indigo-500' },
};
```

The node component renders:
- Phase name (bold)
- Type badge (primary)
- Agent name (small, muted text below badge — only when agent differs from default)
- Command count indicator (if commands exist)

#### 4.3 Canvas View — `src/components/builder/canvas_view.tsx`

Update MiniMap `nodeColor`:

```typescript
nodeColor={(n) => {
    const type = (n.data as Record<string, unknown>)?.phase_type;
    if (type === 'gate') return '#f59e0b';
    if (type === 'team') return '#6366f1';
    return '#94a3b8';
}}
```

#### 4.4 Workflow Graph — `src/components/workflow_graph.tsx`

- Update `PHASE_STYLES`: remove `hug`, `exec`, `pull`, `push`; add `team`.
- Expanded detail panel:
  - Show HUG review info when `phase.agent === 'hug'` (read `phase.reviewer`, `phase.artifacts`, etc.).
  - Show sources section when `phase.sources` exists.
  - Show target_entries section when `phase.target_entries` exists.
  - Show commands section when `phase.commands` exists (already works).
- Agent badge: show `phase.agent` if present.

#### 4.5 Team Actions — `src/components/team_actions.tsx`

- Update inline `WorkflowPhase` interface: type union → `'standard' | 'gate' | 'team'`, remove `review?`, add flat fields.
- Update mapping in `open_in_builder()` and `export_team()`: pass flat fields, not nested `review`.

---

### Phase 5: Backend Builder Service

**Goal:** The backend validates, generates, and parses teams in the new format.

#### 5.1 Update types in `services/backend/src/services/builder_service.ts`

```typescript
interface GeneratedPhase {
    name: string;
    type: 'standard' | 'gate' | 'team';
    depends_on: string[];
    commands?: { name: string; run: string; scope?: string; escalate_on_fail?: boolean }[];
    max_iterations?: number;
    agent?: string;
    sources?: SourceEntry[];
    target_entries?: TargetEntry[];
    reviewer?: string;
    artifacts?: string[];
    timeout?: string;
    remind_every?: string;
    team?: string;
    inputs?: Record<string, string>;
    is_support?: boolean;
}
```

Remove `GeneratedReviewBlock` interface and `parse_review()` helper.

#### 5.2 Update `validate_team()`

```typescript
const valid_types = new Set(['standard', 'gate', 'team']);
const connector_agents = new Set(['curl', 'gdrive', 's3', 'confluence', 'jira', 'zendesk', 'datadog', 'hubspot']);

for (const p of team.phases) {
    if (!valid_types.has(p.type)) {
        errors.push(`Phase "${p.name}" has invalid type "${p.type}"`);
    }

    // Agent-specific validation
    if (p.agent === 'exec' && (!p.commands || p.commands.length === 0)) {
        errors.push(`Exec phase "${p.name}" must have at least one command`);
    }

    if (p.agent === 'hug' && !p.reviewer) {
        warnings.push(`HUG phase "${p.name}" has no reviewer`);
    }

    if (p.agent && connector_agents.has(p.agent)) {
        if ((!p.sources || p.sources.length === 0) && (!p.target_entries || p.target_entries.length === 0)) {
            errors.push(`Connector phase "${p.name}" requires sources or target_entries`);
        }
    }

    if (p.type === 'team' && !p.team) {
        errors.push(`Team phase "${p.name}" must reference a sub-team`);
    }

    // Gate commands must not set escalate_on_fail
    if (p.type === 'gate' && p.commands) {
        for (const cmd of p.commands) {
            if (cmd.escalate_on_fail !== undefined) {
                errors.push(`Command "${cmd.name}" in gate phase "${p.name}" must not set escalate_on_fail`);
            }
        }
    }
}

// Role requirement check
const role_names = new Set(team.roles.map(r => r.name));
for (const p of team.phases) {
    if (p.type === 'team') continue;
    if (p.agent === 'exec') continue;
    if (p.agent && connector_agents.has(p.agent)) continue;
    if (p.type === 'gate' && p.agent === 'hug') continue;
    if (p.type === 'gate' && p.commands?.length) continue; // pure command gate, no role needed
    if (!role_names.has(p.name)) {
        warnings.push(`No role file for phase "${p.name}"`);
    }
}
```

#### 5.3 Update `parse_phases()`

```typescript
function parse_phases(raw: unknown, is_support = false): GeneratedPhase[] {
    if (!Array.isArray(raw)) return [];
    const valid_types = new Set(['standard', 'gate', 'team']);

    return raw.map((p: Record<string, unknown>) => {
        // Normalize old format on the way in
        const normalized = normalize_phase(p);

        const type = valid_types.has(String(normalized.type))
            ? String(normalized.type)
            : 'standard';

        return {
            name: normalise_name(String(normalized.name || '')),
            type,
            depends_on: parse_depends(normalized.depends_on),
            commands: parse_commands(normalized.commands),
            max_iterations: parse_int(normalized.max_iterations),
            agent: normalized.agent ? String(normalized.agent) : undefined,
            sources: parse_sources(normalized.sources),
            target_entries: parse_targets(normalized.target_entries),
            reviewer: normalized.reviewer ? String(normalized.reviewer) : undefined,
            artifacts: Array.isArray(normalized.artifacts) ? normalized.artifacts.map(String) : undefined,
            timeout: normalized.timeout ? String(normalized.timeout) : undefined,
            remind_every: normalized.remind_every ? String(normalized.remind_every) : undefined,
            team: normalized.team ? String(normalized.team) : undefined,
            is_support,
        } as GeneratedPhase;
    });
}
```

#### 5.4 Update LLM prompt templates

Align the system prompt used by the builder chat/generation with the new schema. Key changes:
- Valid types are `standard`, `gate`, `team`.
- `hug`, `exec`, `pull`, `push` are agents, not types.
- HUG configuration uses flat fields, not nested `review:`.
- Connector agents use `sources`/`target_entries` at phase level.

#### 5.5 Update backend tests

- `tests/unit/services/builder_service.test.ts`: rewrite all fixtures to new format.
- `tests/integration/builder.test.ts`: update `valid_chat_response` and any other fixtures.
- Add tests for normalization being applied during `parse_phases()`.

---

### Phase 6: Integration Verification

1. `npx tsc --noEmit` — full frontend + backend compilation.
2. `npm test` — frontend unit tests (normalize_phase, builder store, components if tested).
3. `npm run test:backend` — backend unit + integration tests.
4. Manual smoke tests:
   - Load a team published in old format → verify it renders correctly with new type badges and flat fields.
   - Create a new team in the builder → verify emitted YAML uses new format.
   - Edit an old-format team → verify it saves in new format.
   - Paste old-format YAML in YAML view → verify it normalizes on parse.
   - Export/download a team → verify the zip contains new-format `team.yml`.
5. Visual review: phase nodes, workflow graph, minimap colors render correctly for all agent types.

---

### Phase 7: Cleanup (future, after all stored teams migrated)

**Trigger:** when analytics/queries confirm no teams in the DB use old `type` values.

1. Run a one-time batch migration on the DB:
   - Parse each `team_json` column, run `normalize_phases()`, write back.
   - Repack stored `.tar.gz` packages with updated `team.yml`.
2. Remove `normalize_phase()` calls from all read paths.
3. Delete `src/lib/normalize_phase.ts` and `services/backend/src/utils/normalize_phase.ts`.
4. Remove unit tests for normalization.
5. Simplify `parse_phases()` — remove the normalize step.

---

## Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| Old teams break on load | Normalization is comprehensive and idempotent; unit-tested against all old patterns |
| LLM generates old format | `normalize_phase()` in `parse_phases()` catches it; updated prompts guide toward new format |
| Users paste old YAML in YAML view | Parser runs normalization before hydrating state |
| Batch migration corrupts data | Deferred until confidence is high; normalization handles it at runtime until then |
| Visual regression (badge colors) | Agent-based coloring preserves visual distinction without old type entries |

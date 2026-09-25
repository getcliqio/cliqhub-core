# CLI Generalization — Multi-Agent Runtime Support

## Overview

Cliq currently has a hard dependency on the Cursor CLI (`agent`) as its agent runtime. This design generalizes the invocation layer so Cliq can orchestrate pipelines using any compatible CLI agent — Cursor, Claude Code, Gemini CLI, or OpenAI Codex CLI — while preserving Cliq's core guarantees of predictability, auditability, and control through tool execution.

## Design Principles

### Tools, not APIs

Cliq agents work through **explicit tool execution**: file reads, file writes, shell commands. Every action is a traceable shell invocation with observable output. This is the product's core value proposition. The generalization must preserve this — no opaque API calls, no hidden communication channels, no MCP protocol delegation.

### Files as the communication bus

Inter-phase communication happens through **files on disk** — channel files in `.cliq/channels/`. They are readable, auditable, diffable, and version-controllable. This does not change. Any supported CLI must be able to read and write files through its native tool execution.

### Teams are CLI-agnostic

A published team (workflow, roles, channels, gates) makes no assumptions about which CLI runs it. The team author defines *what* work happens; the user running the team chooses *how* it executes. Teams are portable across all supported CLIs.

### Deterministic quality gates

Gate checks are shell commands with exit codes. `npm test`, `tsc --noEmit`, `wc -w < output.md`. Every supported CLI can execute shell commands. Gate evaluation remains deterministic and auditable.

## Current Architecture

All agent phases are launched via a hardcoded Cursor CLI invocation:

```
agent --force --print --output-format stream-json "$(cat prompt.md)"
```

This is embedded in three places:

- `PipelineRunner.build_single_pane_command()` — constructs the tmux pane command
- `PipelineRunner.check_agent()` / `trust_workspace()` — verifies and pre-trusts the `agent` binary
- `Orchestrator` — gate evaluation invocation

Everything else — prompts, roles, channels, signals, task board, orchestration logic — is already CLI-agnostic.

## Supported CLIs

| CLI | Binary | Provider | Reads Files | Edits Files | Runs Commands |
|-----|--------|----------|-------------|-------------|---------------|
| Cursor | `agent` | Anthropic/OpenAI (configurable) | Yes | Yes | Yes |
| Claude Code | `claude` | Anthropic | Yes | Yes | Yes |
| Gemini CLI | `gemini` | Google | Yes | Yes | Yes |
| Codex CLI | `codex` | OpenAI | Yes | Yes | Yes |

All four operate on the filesystem through tool execution, accept text prompts, and are actively maintained. Together they cover all three frontier model families.

## CLI Profile Abstraction

A thin interface representing how to invoke a CLI agent:

```typescript
interface CliProfile {
  name: string;                                   // 'cursor', 'claude-code', 'gemini', 'codex'
  binary: string;                                  // 'agent', 'claude', 'gemini', 'codex'
  build_command(prompt_file: string): string;       // shell command for tmux pane
  trust_command?(project_dir: string): string;      // pre-trust workspace (cursor-specific)
  needs_kill_on_done: boolean;                     // handle hung-process bugs
  output_format: 'stream-json' | 'text';           // for output parsing
}
```

Five fields and one method. This is the entire abstraction layer.

## Configuration

### User selection

Global settings (`~/.cliq/settings.json`):

```json
{
  "agent": {
    "cli": "cursor"
  }
}
```

Project override (`.cliq/settings.json`):

```json
{
  "agent": {
    "cli": "claude-code"
  }
}
```

CLI flag override:

```
cliq run --cli claude-code
```

### Resolution order

1. `--cli` flag (highest priority)
2. Project settings (`.cliq/settings.json` → `agent.cli`)
3. Global settings (`~/.cliq/settings.json` → `agent.cli`)
4. Default: `cursor`

### Team runtime hints (optional metadata)

A team can optionally declare what it was tested with. This is purely informational — it never blocks execution.

```yaml
runtime:
  tested_with:
    - cursor
    - claude-code
  min_context: 128000
```

Displayed on the CliqHub team detail page. The CLI can show a soft warning if the user's configured CLI doesn't match.

## What Changes

| File | Change |
|------|--------|
| New `src/drivers/cli_profile.ts` | Interface definition |
| New `src/drivers/cursor.ts` | Extract current `agent` invocation logic |
| New `src/drivers/claude_code.ts` | Claude Code invocation profile |
| New `src/drivers/gemini.ts` | Gemini CLI invocation profile |
| New `src/drivers/codex.ts` | Codex CLI invocation profile |
| New `src/drivers/index.ts` | Factory: `resolve_profile(settings)` |
| `src/core/pipeline_runner.ts` | Accept a `CliProfile` instead of hardcoding `agent` |
| `src/commands/orchestrator.ts` | Use profile for gate evaluation commands |
| `src/commands/run_command.ts` | Resolve profile from settings, pass to pipeline |
| `src/core/doctor_checker.ts` | Check the active profile's binary, not just `agent` |
| `src/types/index.ts` | Add `agent` section to `CliqSettings` |
| `src/core/settings_manager.ts` | Add `agent` section to settings template |

## What Does NOT Change

- **Prompts** — markdown files, consumed identically by all CLIs
- **Roles** — markdown role definitions, CLI-agnostic
- **Channels** — files in `.cliq/channels/`, read/written through standard file operations
- **Signals** — `touch .cliq/signals/{phase}_done`, works everywhere
- **Gates** — shell commands with exit codes
- **Task board** — markdown file, updated by agents through file writes
- **Orchestrator logic** — DAG management, phase activation, gate evaluation sequencing
- **Tmux session model** — panes, orchestrator pane 0, agent panes 1+
- **CliqHub** — registry, publishing, team format, builder UI
- **team.yml schema** — no `backend`, `driver`, or `cli` fields on phases

## Why Not Raw LLM APIs

A raw API call (OpenAI chat completions, Anthropic messages API) returns text. It cannot:

- Read a channel file to see what a previous phase produced
- Write output to a channel file for the next phase
- Run a gate check shell command
- Touch a signal file to indicate completion
- Observe or modify the project filesystem

Supporting raw APIs would require building a wrapper that mediates all file and shell operations — effectively rebuilding what CLI agents already provide. It would also break auditability: Cliq can't trace what happened inside a custom mediation layer the way it can trace shell commands executed by a CLI agent.

If a user doesn't have access to any of the four supported CLIs, the answer is to install one — not to degrade the execution model.

## Why Not MCP

MCP (Model Context Protocol) connectors are runtime protocols between the agent and external services. They are:

- **Not auditable** — Cliq can't see what the agent sent or received
- **Not testable** — can't run an MCP call independently outside of an agent session
- **Not deterministic** — behavior depends on agent-side protocol negotiation
- **Not versionable** — no pinnable dependency, no reproducible execution

If a team needs to interact with an external service (e.g., Zendesk, Jira, Slack), the Cliq approach is a **tool** — a standalone script or binary on PATH that the agent invokes as a shell command. `cliq-zendesk create --subject "..." --body "..."` is auditable, testable, and versionable. The agent calls it through its native tool execution, and Cliq sees it in the output log.

## Extensibility: Custom CLI Wrappers

If a future CLI agent emerges that isn't one of the four supported profiles, a user can create a wrapper script that conforms to the expected contract:

1. Accept a prompt (as a file path argument or on stdin)
2. Operate on the current working directory through file and shell tools
3. Exit when done

Point the `agent.cli` setting at the wrapper binary. The profile abstraction supports arbitrary binaries — the four built-in profiles are conveniences, not a closed set.

## Non-Coding Use Cases

Cliq's workflow model (phases, roles, channels, gates) is domain-agnostic. An essay-writing team, a marketing research pipeline, or a legal document review workflow all map onto the same DAG structure.

These use cases work without any generalization because CLI agents are not limited to code. A Claude Code agent following a role prompt that says "Read `channels/research-notes.md` and write a 1500-word executive summary to `channels/summary.md`" operates through the same file tools it uses for code. The agent doesn't know or care that it's not editing source files.

The filesystem-and-tools model is not a coding-specific constraint — it's a general execution model that happens to work well for coding and equally well for any structured workflow.

## Tradeoffs vs. Traditional Agentic Frameworks

### What Cliq gives up

**No real-time agent-to-agent communication.** In frameworks like CrewAI or AutoGen, agents can converse mid-execution — asking questions, getting clarifications, adjusting on the fly. In Cliq, phases communicate through files written after completion. An agent can't interrupt another phase to ask for clarification. It must finish, fail the gate if quality is insufficient, and loop back through a support phase. This is more predictable but slower for exploratory, conversational workflows.

**No dynamic graph modification.** Traditional frameworks let agents spawn new agents, add steps, or restructure the workflow at runtime. Cliq's DAG is fixed at assemble time. If a phase discovers the problem is bigger than expected, it can't split itself into sub-phases. It works within the structure it was given. This is the control tradeoff: you know exactly what will run, but you can't adapt the plan on the fly.

**Higher latency for iterative refinement.** Each phase is a full agent session: startup, context loading, execution, completion, signal detection, next phase activation. In a traditional framework, a "revise this paragraph" loop might be a sub-second function call. In Cliq, it's a gate failure → support phase activation → full agent startup → file read → revision → file write → signal → re-gate. The overhead per iteration is significant because every step goes through the full tool execution and filesystem pipeline.

**Coarser granularity.** Traditional frameworks can have dozens of lightweight "agents" that are really just function calls with different system prompts. In Cliq, every phase is a full tmux pane with a full CLI agent session. The natural unit of work is larger, which means teams tend to have 3-8 phases, not 30. You wouldn't create a phase just to reformat a JSON file.

**Context window pressure.** Traditional frameworks can precisely control which tokens reach each agent. In Cliq, the CLI agent reads the full project directory and role file. You control what's in the channels, but the agent also sees everything else on disk. For large projects, phases may hit context limits or waste tokens on irrelevant files.

### What Cliq gains in return

| Tradeoff | What you lose | What you gain |
|----------|--------------|---------------|
| No real-time chat | Conversational flexibility | No runaway agent conversations burning tokens |
| No dynamic graphs | Runtime adaptability | No agent deciding to "just add one more step" twelve times |
| Higher iteration latency | Speed on tight loops | Every loop produces a committed, auditable artifact |
| Coarser granularity | Lightweight micro-agents | Every unit of work is meaningful and debuggable |
| Context pressure | Surgical token control | Agents have full project context, producing more coherent results |

### Where traditional frameworks win

Genuinely exploratory tasks where the workflow cannot be defined upfront — open-ended research, creative brainstorming, adversarial red-teaming. These benefit from agents that can improvise, branch, and converse.

### Where Cliq wins

Production workflows where you need to know exactly what happened and why — shipping code, writing structured documents, running repeatable processes. Predictability and accountability matter more than dynamic improvisation. Most real-world use cases fall here.

## Implementation Phases

1. **Phase 1**: Extract `CursorDriver` from `PipelineRunner` and `Orchestrator`. Introduce the `CliProfile` interface. Wire it through the pipeline. Zero behavior change — purely a refactor to create the seam.

2. **Phase 2**: Add `ClaudeCodeDriver`. Ship support for a second CLI agent. Validate that teams run identically on both CLIs.

3. **Phase 3**: Add `GeminiDriver` and `CodexDriver`. Full coverage of the four target CLIs.

4. **Phase 4**: Add `agent` settings section and `--cli` flag. Let users choose their runtime.

5. **Phase 5**: Add optional `runtime` metadata to `team.yml` schema. Update CliqHub team detail page to display runtime hints.

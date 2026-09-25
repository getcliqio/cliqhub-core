# Workflow Model Analysis — Expressiveness vs. Predictability

## Overview

Cliq's workflow model is a fixed DAG with four phase types: standard, gate, support, and exec. This document evaluates whether the model is too restrictive for important use cases, identifies the specific patterns it cannot express, and recommends targeted extensions that preserve Cliq's core guarantees of shareability, observability, and auditability.

## Design Philosophy

A Cliq team is a **blueprint, not a starting point for improvisation**. When someone reads a team.yml, they can fully understand what will happen before running it. This predictability is what makes teams shareable — you can publish a team on CliqHub, and the recipient gets the same behavior you designed. The workflow model's constraints are not limitations to overcome; they are the product's value proposition.

The test for any model extension: **can someone read the team.yml and fully understand what will happen before running it?** If yes, the extension belongs. If it introduces runtime unpredictability that isn't visible in the YAML, it doesn't.

## Current Phase Types

| Type | Purpose | Contract |
|------|---------|----------|
| `standard` | Do work, produce output | Runs to completion, writes to channel files |
| `gate` | Quality checkpoint | Runs deterministic commands (shell), produces PASS / ROUTE / ESCALATE verdict |
| `support` | Remediation on gate failure | Activated by gate ROUTE verdict, writes fixes, re-triggers gate evaluation |
| `exec` | Command execution | Runs shell commands at a synchronization point; per-command `escalate_on_fail` (default true) controls whether failures halt the pipeline |

The orchestrator manages the DAG deterministically. Phases activate when dependencies are met. Gates evaluate commands and route accordingly. Support phases loop back with a bounded `max_iterations`. Every action is a file write or shell command — observable, auditable, traceable.

### `exec` phase: per-command `escalate_on_fail`

Each command in an `exec` phase has an `escalate_on_fail` flag (boolean, default `true`). When a command with `escalate_on_fail: false` fails, the failure is logged as a warning and the pipeline continues. Commands with `escalate_on_fail: true` (the default) halt the pipeline on failure, as before.

```yaml
phases:
  - name: post-deploy-checks
    type: exec
    depends_on: [deploy]
    commands:
      - name: smoke-test
        run: "curl -sf https://example.com/health"
      - name: notify-slack
        run: "./scripts/slack-notify.sh"
        escalate_on_fail: false
```

In the example above, a `smoke-test` failure halts the pipeline (default behavior). A `notify-slack` failure is logged as a warning but does not block subsequent phases.

`escalate_on_fail` is only available on `exec` phases. It is **not** allowed on `gate` or `hug` phases — gate commands always determine the verdict, and hug commands always contribute to the review payload.

## What the Model Handles Well

### Linear pipelines

Research → draft → review → polish. Most document and code workflows are fundamentally sequential with quality checks. The standard + gate pattern covers this naturally.

### Parallel independent work

Phases with no dependency run concurrently. A team with `frontend` and `backend` phases that converge at an `integration-test` gate works natively.

### Rework loops

Gate fails → support phase fixes → re-gate. This is the most common iteration pattern in structured work. Built in with `max_iterations` as a safety bound to prevent runaway loops.

### Staged quality

Multiple gates at different pipeline stages — unit test gate, integration gate, review gate — each with its own deterministic commands. Quality is enforced incrementally rather than all-or-nothing.

### Domain-agnostic workflows

The model is not coding-specific. Essay writing, marketing research, data analysis, legal document review — any structured workflow with defined stages maps onto the DAG. CLI agents operate on files, not just source code. A role prompt that says "read `channels/research-notes.md` and write a summary to `channels/summary.md`" works identically to a coding task.

## Patterns the Model Cannot Express

### 1. Conditional paths

**The pattern**: "If the analysis finds a security vulnerability, route to the security-remediation path. If it finds only style issues, route to the lighter cleanup path."

**Current limitation**: Gates can route to a single support phase and then re-evaluate. They cannot skip downstream phases or select between alternative paths. Every phase in the DAG either runs or the pipeline stops. There is no concept of "this phase is optional based on a runtime condition."

**Current workaround**: The support phase handles all cases internally (broader scope per phase), or the gate is lenient enough that minor issues pass through. Works but forces phases to be broader than ideal.

**Severity**: Moderate. Most teams are 3-8 phases and the author knows the structure at design time. Two different remediation strategies can be modeled as two support phases with the gate routing to the appropriate one — close to what gates already do with PASS/ROUTE/ESCALATE.

### 2. Human checkpoints

**The pattern**: "Pause here. A human reviews the output and either approves or sends it back with notes."

**Current limitation**: No phase type for "wait for external input." A gate check could poll for a file (`while [ ! -f approved.txt ]; do sleep 5; done`), but this is fragile and the UX is poor.

**Current workaround**: Human review happens outside the pipeline — someone looks at the PR, the document, the output after the pipeline completes. This works for fully automated workflows but breaks down for processes that require mid-pipeline stakeholder sign-off.

**Severity**: Low for the core use case (most Cliq workflows are fully automated), but a real gap for enterprise workflows involving non-technical stakeholders — legal review, executive approval, editorial sign-off.

### 3. Dynamic fan-out

**The pattern**: "The research phase found 8 competitors. Analyze each one in parallel."

**Current limitation**: The DAG is fixed at assemble time. You cannot create N parallel phases based on what a previous phase discovered. The number of phases and their dependencies are declared in team.yml and do not change at runtime.

**Current workaround**: One phase handles the entire batch. The agent iterates internally over all items. Works for small N but loses parallelism and concentrates all work in one accountability boundary.

**Severity**: Moderate for data-heavy workflows. Low for the common case where the work scope is known upfront.

## Assessment: Are These Dealbreakers?

No. The gaps are real but narrow, and the workarounds are functional for the vast majority of use cases.

**Conditional paths** — rare in practice for 3-8 phase teams. The gate ROUTE mechanism already provides single-target conditional execution.

**Human checkpoints** — genuinely useful but the core use case is fully automated pipelines. When human review is needed, it typically happens after the pipeline completes, not mid-pipeline.

**Dynamic fan-out** — the most legitimate gap, but also the most dangerous to solve. Allowing agents to spawn phases at runtime destroys the guarantee that team.yml predicts behavior. This is the exact trap that makes CrewAI and LangGraph workflows unpredictable and unshareable.

## Recommended Extensions

Two targeted additions that pass the predictability test — the team.yml still fully describes what will happen.

### Extension 1: `review` phase type

A human-in-the-loop pause point. The orchestrator activates the phase, writes context to a known file, and blocks. The phase completes when a human provides a response through one of:

- The Cliq dashboard (approve/reject with notes)
- A CLI command (`cliq review approve` / `cliq review reject --notes "..."`)
- A webhook callback (for integration with external review systems)

Bounded by a configurable timeout. If the timeout expires, the orchestrator treats it as an escalation.

```yaml
phases:
  - name: legal-review
    type: review
    depends_on: [contract-draft]
    timeout: 24h
```

**Why it passes the test**: The team.yml explicitly declares where human review happens, what it depends on, and how long to wait. Anyone reading the YAML knows the pipeline will pause at this point for human input. No runtime unpredictability.

**Useful for**: Editorial approval, legal sign-off, stakeholder review, compliance checkpoints, any workflow involving non-technical decision-makers.

### Extension 2: `conditional` gate verdict — SKIP

Extend the gate verdict from `PASS | ROUTE | ESCALATE` to also support `SKIP`. When a gate evaluates to SKIP, the orchestrator marks specific downstream phases as skipped and proceeds past them.

The skippable phases must be explicitly declared in the team.yml:

```yaml
phases:
  - name: severity-check
    type: gate
    depends_on: [analysis]
    commands:
      - name: has-critical
        run: "grep -q CRITICAL channels/analysis-report.md"
    skippable: [deep-remediation]

  - name: deep-remediation
    type: standard
    depends_on: [severity-check]

  - name: light-cleanup
    type: standard
    depends_on: [severity-check]
```

If the gate determines `deep-remediation` isn't needed, it skips it. `light-cleanup` still runs. The author pre-declares which phases can be skipped — the gate cannot skip arbitrary phases.

**Why it passes the test**: The team.yml declares exactly which phases are skippable and under what conditions. The skip set is static, defined by the author. The gate's runtime decision is constrained to a pre-declared set of options. Anyone reading the YAML can enumerate all possible execution paths.

**Useful for**: Lightweight vs. heavyweight remediation, optional polish steps, severity-based routing, skipping expensive phases when they're not needed.

## What Should NOT Be Added

### Dynamic phase spawning

Allowing agents or the orchestrator to create new phases at runtime. This fundamentally breaks shareability — the team.yml becomes a partial description, not a complete specification. The recipient of a shared team cannot predict how many phases will run or what they will do.

### Agent-to-agent messaging

Real-time communication between running phases. This creates hidden communication channels that aren't represented in the filesystem. Cliq's auditability guarantee depends on all inter-phase communication being file-based — readable, diffable, and inspectable after the fact.

### Arbitrary runtime graph edges

Allowing phases to declare new dependencies or route to arbitrary other phases at runtime. The DAG stops being a DAG and becomes a state machine where transitions are determined by agent behavior. This is LangGraph's model, and it makes workflows impossible to reason about statically.

### Unbounded loops

Allowing phases to loop back to arbitrary earlier phases without a bound. Support phases already handle bounded rework loops through the gate → support → re-gate pattern with `max_iterations`. General-purpose loops create the risk of unbounded execution and make it impossible to estimate pipeline duration or cost.

## Comparison: Cliq vs. Traditional Agentic Frameworks

### What Cliq gives up

**No real-time agent-to-agent communication.** Phases communicate through files written after completion. An agent cannot interrupt another phase to ask for clarification. It must finish, fail the gate if quality is insufficient, and loop back through a support phase. More predictable but slower for exploratory, conversational workflows.

**No dynamic graph modification.** The DAG is fixed at assemble time. If a phase discovers the problem is bigger than expected, it cannot split itself into sub-phases. It works within the structure it was given. You know exactly what will run, but you cannot adapt the plan on the fly.

**Higher latency for iterative refinement.** Each phase is a full agent session: startup, context loading, execution, completion, signal detection, next phase activation. In a traditional framework, a tight revision loop might be a sub-second function call. In Cliq, it traverses the full tool execution and filesystem pipeline. The overhead per iteration is significant.

**Coarser granularity.** Every phase is a full tmux pane with a full CLI agent session. The natural unit of work is larger — teams have 3-8 phases, not 30. You would not create a phase just to reformat a file.

**Context window pressure.** The CLI agent reads the full project directory and role file. You control what is in the channels, but the agent also sees everything else on disk. For large projects, phases may hit context limits or spend tokens on irrelevant files. Traditional frameworks can surgically scope each agent's context.

### What Cliq gains in return

| Tradeoff | What you lose | What you gain |
|----------|--------------|---------------|
| No real-time chat | Conversational flexibility | No runaway agent conversations burning tokens and going nowhere |
| No dynamic graphs | Runtime adaptability | No agent deciding to "just add one more step" indefinitely |
| Higher iteration latency | Speed on tight loops | Every loop produces a committed, auditable artifact on disk |
| Coarser granularity | Lightweight micro-agents | Every unit of work is meaningful, debuggable, and independently verifiable |
| Context pressure | Surgical token control | Agents have full project context, producing more coherent and consistent results |

### Where traditional frameworks win

Genuinely exploratory tasks where the workflow cannot be defined upfront — open-ended research, creative brainstorming, adversarial red-teaming. These benefit from agents that can improvise, branch, and converse dynamically.

### Where Cliq wins

Production workflows where you need to know exactly what happened and why — shipping code, writing structured documents, running repeatable processes, any workflow that will be shared and reused. Predictability and accountability matter more than dynamic improvisation. Most real-world use cases fall here.

## Summary

The current workflow model is sufficient for the vast majority of structured workflows across coding and non-coding domains. The three patterns it cannot express (conditional paths, human checkpoints, dynamic fan-out) are real but narrow gaps.

Two targeted extensions — a `review` phase type and a `SKIP` gate verdict — address the most practical gaps (human-in-the-loop and conditional routing) without compromising predictability. Both pass the core test: the team.yml remains a complete, readable specification of what will happen.

Dynamic fan-out is intentionally left unsupported. Solving it requires runtime graph modification, which fundamentally breaks the guarantee that a shared team behaves predictably. The workaround (single phase handles the batch internally) trades parallelism for predictability — the right trade for a platform built on shareability and control.

import type { LlmAdapter, LlmMessage } from './llm/hosted_adapter.js';
import type { AuthContext } from '../types/vo.js';
import { ApiError } from '../errors/api_error.js';
import {
	create_builder_job,
	get_builder_job,
	update_builder_job,
} from './builder_job_store.js';

// Keep in sync with cliq agents.json
const BUILTIN_AGENT_NAMES = new Set([
	'claude-api', 'claude-code', 'codex', 'confluence',
	'curl', 'cursor', 'datadog', 'exec',
	'gdrive', 'gemini', 'gemini-api', 'hubspot',
	'hug', 'jira', 'mesh', 'openai-api',
	's3', 'team', 'zendesk',
]);

/** Connector agents that operate on sources/targets via action — no LLM role needed. */
const CONNECTOR_AGENTS = new Set([
	'jira', 'confluence', 'zendesk', 'datadog',
	'hubspot', 'gdrive', 's3', 'mesh',
]);

/** Agents that don't use role files. */
const ROLE_EXEMPT_AGENTS = new Set([
	'exec', 'curl', ...CONNECTOR_AGENTS,
]);

// ---- Internal types (mirrored from cliq generation engine) ----

interface SourceEntry {
	name: string;
	ref?: string;
	url?: string;
	headers?: Record<string, string>;
	method?: string;
	body?: string;
	[key: string]: unknown;
}

interface TargetEntry {
	name: string;
	file: string;
	ref?: string;
	url?: string;
	headers?: Record<string, string>;
	method?: string;
	mode?: 'create' | 'append' | 'replace';
	[key: string]: unknown;
}

interface GeneratedReviewBlock {
	reviewer?: string;
	artifacts?: string[];
	timeout?: string;
	remind_every?: string;
}

interface GeneratedPhase {
	name: string;
	type: 'standard' | 'gate' | 'team';
	depends_on: string[];
	commands?: { name: string; run: string; scope?: string; escalate_on_fail?: boolean }[];
	max_iterations?: number;
	agent?: string;
	sources?: SourceEntry[];
	target_entries?: TargetEntry[];
	action?: string;
	model?: string;
	review?: GeneratedReviewBlock;
	team?: string;
	inputs?: Record<string, string>;
	is_support?: boolean;
}

interface GeneratedRole {
	name: string;
	content: string;
}

interface GeneratedAgent {
	name: string;
	entry?: string;
	env?: string[];
}

interface GeneratedTeam {
	name: string;
	description: string;
	tags?: string[];
	inputs?: { name: string; description?: string }[];
	use_when?: string[];
	not_for?: string[];
	phases: GeneratedPhase[];
	roles: GeneratedRole[];
	agents?: GeneratedAgent[];
}

interface ValidationResult {
	valid: boolean;
	errors: string[];
	warnings: string[];
}

interface ChatMessage {
	role: 'user' | 'assistant';
	content: string;
}

// ---- JSON extraction ----

function extract_json(text: string): unknown {
	let cleaned = text.trim();
	const fenced = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
	if (fenced) cleaned = fenced[1].trim();

	const first_brace = cleaned.indexOf('{');
	const first_bracket = cleaned.indexOf('[');
	if (first_brace === -1 && first_bracket === -1) throw new Error('No JSON found in response');

	let start = first_brace;
	let end_char = '}';
	if (first_bracket !== -1 && (first_brace === -1 || first_bracket < first_brace)) {
		start = first_bracket;
		end_char = ']';
	}

	let depth = 0;
	let in_string = false;
	let escape_next = false;

	for (let i = start; i < cleaned.length; i++) {
		const ch = cleaned[i];
		if (escape_next) { escape_next = false; continue; }
		if (ch === '\\' && in_string) { escape_next = true; continue; }
		if (ch === '"') { in_string = !in_string; continue; }
		if (in_string) continue;
		if (ch === '{' || ch === '[') depth++;
		if (ch === '}' || ch === ']') {
			depth--;
			if (depth === 0 && ch === end_char) {
				return JSON.parse(cleaned.slice(start, i + 1));
			}
		}
	}

	throw new Error('Unterminated JSON in response');
}

function normalise_name(name: string): string {
	return name
		.toLowerCase()
		.replace(/[_\s]+/g, '-')
		.replace(/[^a-z0-9-]/g, '')
		.replace(/-+/g, '-')
		.replace(/^-|-$/g, '');
}

// ---- Validation ----

const INVENTED_TOOL_PATTERNS: RegExp[] = [
	/\b\w+\.(find_file|download|upload|fetch|send|get|post|put|delete|list|search|create|read|write)[\w_]*\b/i,
	/\bapi\.\w+/i,
	/\btools?\.\w+/i,
	/\bsdk\.\w+/i,
	/\bclient\.\w+/i,
	/\bservice\.\w+/i,
];

const TOOL_ALLOWLIST = new Set([
	'npm.test', 'npm.run', 'git.status', 'git.commit', 'git.push', 'git.pull',
	'pr-exists', 'create-pr',
]);

function scan_for_invented_tools(content: string): string[] {
	const found: string[] = [];
	for (const pattern of INVENTED_TOOL_PATTERNS) {
		const global_re = new RegExp(pattern.source, 'gi');
		let match;
		while ((match = global_re.exec(content)) !== null) {
			const tool = match[0];
			if (!TOOL_ALLOWLIST.has(tool.toLowerCase()) && !found.includes(tool)) {
				found.push(tool);
			}
		}
	}
	return found;
}

function detect_cycle(nodes: { name: string; deps: string[] }[]): string | null {
	const visited = new Set<string>();
	const visiting = new Set<string>();
	const dep_map = new Map(nodes.map(n => [n.name, n.deps]));

	function dfs(name: string): string | null {
		if (visiting.has(name)) return name;
		if (visited.has(name)) return null;

		visiting.add(name);
		for (const dep of dep_map.get(name) ?? []) {
			const result = dfs(dep);
			if (result) return result;
		}
		visiting.delete(name);
		visited.add(name);
		return null;
	}

	for (const node of nodes) {
		const result = dfs(node.name);
		if (result) return result;
	}
	return null;
}

function validate_team(team: GeneratedTeam): ValidationResult {
	const errors: string[] = [];
	const warnings: string[] = [];

	if (!team.name?.trim()) errors.push('Team name is required');
	if (!team.description?.trim()) warnings.push('Team description is empty');
	if (team.phases.length === 0) errors.push('Team must have at least one phase');

	const valid_types = new Set(['standard', 'gate', 'team']);
	const phase_names = new Set<string>();

	for (const p of team.phases) {
		if (!p.name) { errors.push('Phase with empty name found'); continue; }
		if (phase_names.has(p.name)) errors.push(`Duplicate phase name: "${p.name}"`);
		phase_names.add(p.name);

		if (!valid_types.has(p.type)) {
			errors.push(`Phase "${p.name}" has invalid type "${p.type}"`);
		}

		for (const dep of p.depends_on) {
			if (!team.phases.some(ph => ph.name === dep)) {
				errors.push(`Phase "${p.name}" depends on unknown phase "${dep}"`);
			}
		}

		if (p.agent === 'exec' && (!p.commands || p.commands.length === 0)) {
			errors.push(`Exec phase "${p.name}" must have at least one command`);
		}

		if (p.type === 'gate' && p.commands) {
			for (const cmd of p.commands) {
				if (cmd.escalate_on_fail !== undefined) {
					errors.push(`Command "${cmd.name}" in gate phase "${p.name}" must not set escalate_on_fail — gate command outcomes are evaluated by the agent, not the orchestrator`);
				}
			}
		}

		if (p.agent === 'hug') {
			if (!p.commands || p.commands.length === 0) {
				warnings.push(`Hug phase "${p.name}" has no commands — the reviewer will have no automated results to evaluate`);
			}
			if (!p.review?.reviewer) {
				errors.push(`Hug phase "${p.name}" requires review.reviewer`);
			}
		}

		if (p.type === 'gate' && (!p.commands || p.commands.length === 0) && p.agent !== 'hug') {
			errors.push(`Gate phase "${p.name}" must have at least one command`);
		}

		if (p.type === 'team' && !p.team) {
			errors.push(`Team phase "${p.name}" must have a team field`);
		}

		if (CONNECTOR_AGENTS.has(p.agent ?? '')) {
			if (!p.action) {
				errors.push(`Connector phase "${p.name}" (agent: ${p.agent}) must have an action field`);
			}
			if (!p.sources || p.sources.length === 0) {
				warnings.push(`Connector phase "${p.name}" has no sources — it won't fetch any data`);
			}
		}

		if (p.agent === 'curl') {
			const has_sources = p.sources && p.sources.length > 0;
			const has_targets = p.target_entries && p.target_entries.length > 0;
			if (!has_sources && !has_targets) {
				errors.push(`Curl phase "${p.name}" must have at least one source or target entry`);
			}
		}
	}

	if (team.phases.length > 0 && !team.phases.some(p => p.depends_on.length === 0)) {
		errors.push('No root phase found');
	}

	const cycle = detect_cycle(team.phases.map(p => ({ name: p.name, deps: p.depends_on })));
	if (cycle) {
		errors.push(`Dependency cycle detected involving "${cycle}"`);
	}

	const role_names = new Set(team.roles.map(r => r.name));
	for (const p of team.phases) {
		if (p.type === 'team') continue;
		if (ROLE_EXEMPT_AGENTS.has(p.agent ?? '')) continue;
		if (p.type === 'gate' && p.commands?.length) continue;
		if (!role_names.has(p.name)) {
			warnings.push(`No role file for phase "${p.name}"`);
		}
	}

	for (const role of team.roles) {
		if (!role.content || role.content.trim().length < 50) {
			warnings.push(`Role "${role.name}" content is very short — may need more detail`);
		}

		if (role.content) {
			const invented = scan_for_invented_tools(role.content);
			for (const tool of invented) {
				warnings.push(`Role "${role.name}" references "${tool}" which is not a cliq built-in — agents cannot call external APIs or tools`);
			}
		}
	}

	const agent_names = new Set<string>();
	for (const a of team.agents || []) {
		if (!a.name?.trim()) { errors.push('Agent with empty name found'); continue; }
		if (agent_names.has(a.name)) errors.push(`Duplicate agent name: "${a.name}"`);
		agent_names.add(a.name);
	}

	for (const p of team.phases) {
		if (p.agent && !BUILTIN_AGENT_NAMES.has(p.agent) && !agent_names.has(p.agent)) {
			errors.push(`Phase "${p.name}" references unknown agent "${p.agent}"`);
		}
	}

	for (const p of team.phases) {
		if (p.sources) {
			for (const entry of p.sources) {
				if (!entry.name?.trim()) errors.push(`Phase "${p.name}" has a source with empty name`);
			}
		}
		if (p.target_entries) {
			for (const entry of p.target_entries) {
				if (!entry.file?.trim()) errors.push(`Phase "${p.name}" has a target with empty file`);
				if (!entry.name?.trim()) errors.push(`Phase "${p.name}" has a target with empty name`);
				if (entry.mode && !['create', 'append', 'replace'].includes(entry.mode)) {
					errors.push(`Phase "${p.name}" target "${entry.file}" has invalid mode — must be "create", "append", or "replace"`);
				}
			}
		}
	}

	if (team.inputs?.length) {
		const referenced = new Set<string>();
		for (const p of team.phases) {
			const fields: string[] = [];
			if (p.sources) {
				for (const s of p.sources) {
					if (s.url) fields.push(s.url);
					if (s.name) fields.push(s.name);
				}
			}
			if (p.target_entries) {
				for (const t of p.target_entries) {
					if (t.file) fields.push(t.file);
					if (t.name) fields.push(t.name);
				}
			}
			if (p.commands) {
				for (const c of p.commands) {
					if (c.run) fields.push(c.run);
				}
			}
			if (p.review?.reviewer) fields.push(p.review.reviewer);
			for (const f of fields) {
				const re = /\$\(inputs\.(\w+)\)/g;
				let m;
				while ((m = re.exec(f)) !== null) {
					referenced.add(m[1]);
				}
			}
		}
		for (const role of team.roles) {
			if (role.content) {
				const re = /\$\(inputs\.(\w+)\)/g;
				let m;
				while ((m = re.exec(role.content)) !== null) {
					referenced.add(m[1]);
				}
			}
		}
		for (const inp of team.inputs) {
			if (inp.name && !referenced.has(inp.name)) {
				warnings.push(`Declared input "${inp.name}" is never referenced via $(inputs.${inp.name}) in the workflow`);
			}
		}
	}

	return { valid: errors.length === 0, errors, warnings };
}

// ---- Prompt constants (ported from cliq src/builder/prompts.ts) ----

const PLATFORM_REFERENCE = `## cliq Platform Reference

You are designing teams for the "cliq" multi-agent orchestration platform. Understanding how cliq works is essential for generating correct, functional teams.

### What agents are

Agents are AI coding assistants (Cursor, Aider, Claude Code, etc.) that run in terminal panes. They interact with the world ONLY through the local filesystem and shell commands. They can:
- Read and write files on disk
- Run shell commands (npm test, git status, etc.)
- Read from incoming channel directories and write to outgoing channel directories

Agents CANNOT:
- Make HTTP/API calls to external services (no Google Drive API, no REST calls, no webhooks)
- Access databases directly
- Call custom tools or SDKs that don't exist on the machine
- Import or use libraries in their role prompts

This means: if the team needs to fetch a document from Google Drive, the agent does NOT call the Google Drive API. Instead, cliq's declarative "pull" system fetches the document before the agent runs, and the agent reads it as a local file.

### External file access — Sources & Targets

cliq has a built-in declarative system for external file access. Sources and targets are declared as flat fields on phases in team.yml, NOT in role prompts.

**Sources** fetch external content into .cliq/pull/ before the phase's agent runs:
\`\`\`yaml
phases:
  - name: analyst
    type: standard
    sources:
      - name: data-room
        url: "gdrive://$(inputs.folder_id)"
      - name: market-report
        url: "https://example.com/report.pdf"
\`\`\`

Supported source URL patterns:
- Any HTTP(S) URL → converted to markdown (or raw binary with format: raw)
- docs.google.com/document/d/{id} → exported as markdown
- docs.google.com/spreadsheets/d/{id} → exported as CSV
- gdrive://{folder_id} → recursive folder download
- *.sharepoint.com/... → SharePoint document

The agent's role prompt references pulled content as local files:
"Read the data room contents at .cliq/pull/data-room/ and the market report at .cliq/pull/market-report.md"

**Target entries** deliver local files to external destinations after the phase completes:
\`\`\`yaml
phases:
  - name: writer
    type: standard
    depends_on: [analyst]
    target_entries:
      - name: final-report
        file: reports/report.md
        mode: create
\`\`\`

Target modes: "create" (new file), "append" (add to existing), "replace" (overwrite existing)

Template variables available in source URLs, target entries, and commands: $(inputs.key), $(team_name), $(date), $(phase), $(timestamp)

**Critical rule**: When a team needs external data, use sources/target_entries on phases. NEVER write role prompts that tell agents to call external APIs or use tools like "gdrive.download" or "api.fetch" — these do not exist.

### Channel system

Agents hand off work through filesystem directories under .cliq/channels/. The naming convention is:
  .cliq/channels/{from_phase}--{to_phase}/

When phase A depends on phase B, phase B writes handoff documents (markdown files) to the channel directory, and phase A reads them. Role prompts should reference channels like:
"Write your analysis to the outgoing channel for the next phase"
"Read the design documents from your incoming channel"

The orchestrator creates channel directories automatically based on the workflow DAG.

### Signals and verdicts

Agents signal completion by writing a _done file. The orchestrator detects this and advances the pipeline.

The orchestrator automatically injects the verdict protocol into gate and hug phases. Team authors do not need to include verdict syntax in roles — the role describes what to evaluate, and the orchestrator handles the structured verdict format (pass, route, escalate).

### Directory structure

The .cliq/ directory contains:
- channels/ — handoff directories between phases
- pull/ — external content fetched by pull declarations
- push/ — push manifest tracking uploaded files
- signals/ — completion and verdict files
- design/ — architecture and design documents
- task_board.md — task tracking
- requirements.md — resolved requirements

Agent output files (reports, code, deliverables) go in project-relative paths chosen by the team author — NOT inside .cliq/. The .cliq/ directory is reserved for orchestrator internals.

### Available tools

cliq has exactly these built-in tools: pr-exists, create-pr.
NEVER reference tools that don't exist. NEVER invent tools like "gdrive.find_file", "api.call", "tools.fetch", etc.
Gate commands must use real shell commands: npm test, npm run build, git status, python -m pytest, etc.`;


const REFERENCE_EXAMPLES = `## Reference Examples

These condensed examples show correctly structured cliq teams. Study them before generating.

### Example 1: External data team (sources + process + targets)

This team reads a document from Google Drive, analyses it, and writes the result to a target.

team.yml (sources and target_entries are flat fields on standard phases):
\`\`\`yaml
phases:
  - name: fetch-and-analyse
    type: standard
    sources:
      - name: source-docs
        url: "gdrive://$(inputs.source_folder_id)"
  - name: writer
    type: standard
    depends_on: [fetch-and-analyse]
    target_entries:
      - name: report-output
        file: reports/report.md
        mode: create
  - name: quality-gate
    type: gate
    depends_on: [writer]
    commands:
      - name: report-exists
        run: "test -f reports/report.md"
    max_iterations: 2
\`\`\`

fetch-and-analyse role (references pulled files as LOCAL paths):
\`\`\`markdown
# Role: Analyst
You are a research analyst. Read the source documents and produce structured findings.
## Context
Source documents have been pulled into .cliq/pull/source-docs/. Read all files in that directory.
## Deliverables
Write your analysis to .cliq/design/analysis.md and a handoff summary to your outgoing channel.
## Constraints
- Base analysis ONLY on content in .cliq/pull/source-docs/
- Do NOT attempt to access external URLs or APIs
\`\`\`

quality-gate role (describes evaluation criteria):
\`\`\`markdown
# Role: Quality Gate
Review the report for completeness and accuracy.
## Evaluation Criteria
- If reports/report.md exists and covers all findings: approve and proceed
- If the report is incomplete or inaccurate: escalate to human
\`\`\`

Key points: sources and target_entries are flat fields on phases. The agent reads local files. No API calls.

### Example 2: Code team with gate and support phase

team.yml phases + support section:
\`\`\`yaml
phases:
  - name: architect
    type: standard
  - name: developer
    type: standard
    depends_on: [architect]
  - name: reviewer
    type: gate
    depends_on: [developer]
    commands:
      - name: tests
        run: npm test
    max_iterations: 3
support:
  - name: fixer
    type: standard
\`\`\`

reviewer role (gate with routing to support):
\`\`\`markdown
# Role: Reviewer
Review implementation quality and run checks.
## Evaluation Criteria
- If all checks pass and code quality is good: approve and proceed
- If tests fail due to fixable code issues: route to fixer for remediation
- If design is fundamentally flawed: escalate to human
\`\`\`

Key points: gate commands use real shell commands, support phases are in a separate section, gate role describes when to route to support phases.

### Example 3: Human review gate (gate + agent: hug)

This team runs automated commands then requires human approval before merging.

team.yml (hug is a gate with agent: hug and a nested review: block):
\`\`\`yaml
phases:
  - name: developer
    type: standard
  - name: automated-qa
    type: gate
    depends_on: [developer]
    commands:
      - name: tests
        run: npm test
      - name: lint
        run: npm run lint
    max_iterations: 3
  - name: human-review
    type: gate
    agent: hug
    depends_on: [automated-qa]
    commands:
      - name: tests
        run: npm test
    review:
      reviewer: architects
      artifacts:
        - src/
        - .cliq/channels/developer--human-review/handoff.md
      timeout: 2h
      remind_every: 30m
    max_iterations: 2
support:
  - name: revision
    type: standard
\`\`\`

human-review role (describes evaluation criteria — the human reviewer sees these as guidance):
\`\`\`markdown
# Role: Human Review
A senior engineer reviews the implementation for production readiness.
## Evaluation Criteria
- If implementation is production-ready and tests pass: approve and proceed
- If minor issues can be fixed by the developer: route to revision for fixes
- If design is fundamentally flawed: escalate to human
\`\`\`

Key points: hug is type: gate with agent: hug. The \`review:\` block contains reviewer, artifacts, timeout, remind_every. The role provides evaluation guidance for the human.

### Example 4: Exec phase (standard + agent: exec)

\`\`\`yaml
phases:
  - name: setup
    type: standard
    agent: exec
    commands:
      - name: install
        run: npm install
        escalate_on_fail: true
      - name: seed
        run: npm run seed
        escalate_on_fail: false
  - name: developer
    type: standard
    depends_on: [setup]
\`\`\`

Key points: exec is now type: standard with agent: exec. escalate_on_fail is only valid on exec phases.

### Example 5: Team delegation phase

\`\`\`yaml
phases:
  - name: analyse
    type: standard
  - name: sub-workflow
    type: team
    depends_on: [analyse]
    team: data-pipeline
    inputs:
      source_id: "$(inputs.source_id)"
\`\`\`

Key points: type: team delegates to another team. Must have "team" field. No commands or role file.`;


const PHASE_TYPES = `Phase types:
- standard: Normal execution phase with a role prompt. Can optionally have an "agent" field to select a specific agent (e.g. agent: "exec" for shell-only execution, or a connector agent for pull/push). When agent is "exec", the phase runs shell commands (must include "commands" array). Each exec command has an optional "escalate_on_fail" boolean (default true). Standard phases can also carry "sources" and "target_entries" for data integration.
- gate: Quality gate with automated commands (must include "commands" array with "name" and "run" fields). Gates loop until commands pass or max_iterations is reached. The orchestrator automatically injects the verdict protocol — roles should describe evaluation criteria, not verdict syntax. When agent is "hug", the gate becomes a human-in-the-loop review: a human reviewer approves or rejects instead of the AI agent deciding. Hug gates may have "commands" (automated results shown to the reviewer), and a nested "review" object containing "reviewer" (name from hug settings), "artifacts" (file paths the reviewer should see), "timeout" (e.g. "30m", "2h"), and "remind_every" (e.g. "10m").
- team: Delegates to another team. Must have a "team" field naming the sub-team and may have "inputs" to pass parameters. No commands, no role file.

Support phases (activated only when a gate routes to them) are declared in a separate top-level "support" section, not in the main "phases" list. They have their own type (standard, gate, etc.) and must be referenced by at least one gate role's evaluation criteria.`;

const ROLE_STRUCTURE = `A role prompt should contain these sections:
1. Identity — who this agent is and their expertise
2. Objective — what they must accomplish in this phase
3. Context — what inputs they receive (incoming channels from .cliq/channels/{from}--{this_phase}/, pulled files from .cliq/pull/, task board, requirements)
4. Deliverables — specific outputs they must produce (project-relative file paths, channel handoffs)
5. Constraints — rules, quality bars, and boundaries
6. Handoff — what the next phase expects from them (write to outgoing channels)

For gate and hug roles, add:
7. Evaluation Criteria (gate/hug only) — what constitutes passing, what issues should route to support phases, what warrants escalation

CRITICAL: Role prompts must ONLY reference things agents can actually do — read/write files and run shell commands. NEVER reference external APIs, custom tools, SDKs, or services the agent cannot access directly.
CRITICAL: Agent output files (reports, code, deliverables) should use sensible project-relative paths. Do NOT place output files inside .cliq/ — that directory is reserved for orchestrator internals (signals, channels, pull cache).`;

const METADATA_FORMAT = `Top-level metadata fields (all optional):
- tags: categorical tags for filtering (e.g. code, git, tdd, planning, discovery, data, integration)
- inputs: template parameters referenced in workflow via $(inputs.key) (in source URLs, target entries, phase commands). Each has "name" and optional "description". Do NOT include a "requirement" input — the task description is separate from inputs. Every declared input MUST be referenced via $(inputs.key) somewhere in the workflow.
- use_when: list of conditions when this team is the right choice (used by A2A routing)
- not_for: list of conditions when this team should NOT be used, mention alternatives (used by A2A routing)`;

const OUTPUT_FORMAT = `Return ONLY a JSON object with this exact structure (no markdown fences, no commentary):
{
  "name": "team-name-in-kebab-case",
  "description": "One-line team description",
  "tags": ["categorical", "tags"],
  "inputs": [{ "name": "param_name", "description": "..." }],
  "use_when": ["condition when this team is the right choice"],
  "not_for": ["condition when this team should NOT be used"],
  "phases": [
    {
      "name": "phase-name",
      "type": "standard|gate|team",
      "depends_on": ["other-phase"],
      "agent": "optional-agent-name",
      "commands": [{ "name": "cmd-name", "run": "shell command", "escalate_on_fail": true }],
      "max_iterations": 3,
      "sources": [{ "name": "content-slug", "url": "https://...", "ref": "gdrive://...", "body": "optional request body" }],
      "target_entries": [{ "name": "target-slug", "file": "reports/output.md", "mode": "create|append|replace" }],
      "review": { "reviewer": "reviewer-name", "artifacts": ["path/to/file"], "timeout": "30m", "remind_every": "10m" },
      "model": "optional-model-override",
      "action": "optional-action",
      "team": "sub-team-name",
      "inputs": { "key": "value" }
    }
  ],
  "support": [
    {
      "name": "support-phase-name",
      "type": "standard",
      "depends_on": []
    }
  ],
  "roles": [
    {
      "name": "phase-name",
      "content": "Full markdown role prompt for this phase..."
    }
  ],
  "agents": [
    {
      "name": "agent-name",
      "entry": "optional-entry-path",
      "env": ["OPTIONAL_ENV_VAR"]
    }
  ]
}

Phase type rules:
- type: standard — normal agent execution. Set agent: "exec" for shell-only phases (must have commands, escalate_on_fail allowed). Sources and target_entries can be set for data integration.
- type: gate — quality gate. Must have commands and max_iterations. Set agent: "hug" for human-in-the-loop review (use a nested "review" object with reviewer, artifacts, timeout, remind_every). Gate roles describe evaluation criteria.
- type: team — delegates to a sub-team. Must have "team" field, may have "inputs" map. No commands, no role file.
- sources entries: name is a slug for local storage, url/ref point to external content. For curl agent, sources may include a "body" field (string) to send a request body — method defaults to POST when body is present, Content-Type defaults to application/json
- target_entries entries: name is a slug, file is a project-relative path, mode defaults to "create"
- URLs can use template variables: $(inputs.key), $(team_name), $(date), $(phase), $(timestamp)
- The role prompt for downstream phases references pulled content as LOCAL files (e.g. .cliq/pull/slug-name.md), NOT as external URLs
- The role prompt tells the agent where to write output files — use sensible project-relative paths, NOT .cliq/ (which is reserved for orchestrator internals)
- Support phases go in the separate "support" array, NOT in "phases". They are activated only when a gate routes to them. Omit the "support" array entirely if there are no support phases.`;

// ---- Parsing helpers ----

function parse_source_entries(raw: unknown): SourceEntry[] | undefined {
	if (!Array.isArray(raw) || raw.length === 0) return undefined;
	return raw.map((e: Record<string, unknown>) => ({
		name: String(e.name || ''),
		...(e.ref ? { ref: String(e.ref) } : {}),
		...(e.url ? { url: String(e.url) } : {}),
		...(e.headers && typeof e.headers === 'object' ? { headers: e.headers as Record<string, string> } : {}),
		...(e.method ? { method: String(e.method) } : {}),
		...(e.body ? { body: String(e.body) } : {}),
	}));
}

function parse_target_entries(raw: unknown): TargetEntry[] | undefined {
	if (!Array.isArray(raw) || raw.length === 0) return undefined;
	return raw.map((e: Record<string, unknown>) => {
		const mode = (['create', 'append', 'replace'].includes(String(e.mode))
			? String(e.mode)
			: 'create') as TargetEntry['mode'];
		return {
			name: String(e.name || ''),
			file: String(e.file || ''),
			...(e.ref ? { ref: String(e.ref) } : {}),
			...(e.url ? { url: String(e.url) } : {}),
			...(e.headers && typeof e.headers === 'object' ? { headers: e.headers as Record<string, string> } : {}),
			...(e.method ? { method: String(e.method) } : {}),
			mode,
		};
	});
}

function parse_phases(raw: unknown, is_support = false): GeneratedPhase[] {
	if (!Array.isArray(raw)) return [];
	const valid_types = new Set(['standard', 'gate', 'team']);
	return raw.map((p: Record<string, unknown>) => {
		const type = (valid_types.has(String(p.type))
			? String(p.type)
			: 'standard') as GeneratedPhase['type'];
		return {
			name: normalise_name(String(p.name || '')),
			type,
			depends_on: is_support ? [] : (Array.isArray(p.depends_on) ? p.depends_on.map(String) : []),
			...(p.agent ? { agent: String(p.agent) } : {}),
			...(Array.isArray(p.commands) ? {
				commands: p.commands.map((c: Record<string, unknown>) => ({
					name: String(c.name || ''),
					run: String(c.run || ''),
					...(c.scope ? { scope: String(c.scope) } : {}),
					...(c.escalate_on_fail !== undefined ? { escalate_on_fail: Boolean(c.escalate_on_fail) } : {}),
				})),
			} : {}),
			...(typeof p.max_iterations === 'number' ? { max_iterations: p.max_iterations } : {}),
			...(p.sources ? { sources: parse_source_entries(p.sources) } : {}),
			...(p.target_entries ? { target_entries: parse_target_entries(p.target_entries) } : {}),
			...(p.action ? { action: String(p.action) } : {}),
			...(p.model ? { model: String(p.model) } : {}),
			...(p.review && typeof p.review === 'object' ? (() => {
				const rev = p.review as Record<string, unknown>;
				return { review: {
					...(rev.reviewer ? { reviewer: String(rev.reviewer) } : {}),
					...(Array.isArray(rev.artifacts) ? { artifacts: (rev.artifacts as unknown[]).map(String) } : {}),
					...(rev.timeout ? { timeout: String(rev.timeout) } : {}),
					...(rev.remind_every ? { remind_every: String(rev.remind_every) } : {}),
				} };
			})() : {}),
			...(p.team ? { team: String(p.team) } : {}),
			...(p.inputs && typeof p.inputs === 'object' ? { inputs: p.inputs as Record<string, string> } : {}),
			...(is_support ? { is_support: true } : {}),
		};
	});
}

function parse_roles(raw: unknown): GeneratedRole[] {
	if (!Array.isArray(raw)) return [];
	return raw.map((r: Record<string, unknown>) => ({
		name: normalise_name(String(r.name || '')),
		content: String(r.content || ''),
	}));
}

function parse_metadata(raw: Record<string, unknown>): Pick<GeneratedTeam, 'tags' | 'inputs' | 'use_when' | 'not_for'> {
	return {
		tags: Array.isArray(raw.tags) ? raw.tags.map(String) : undefined,
		inputs: Array.isArray(raw.inputs)
			? raw.inputs.map((p: Record<string, unknown>) => ({
				name: String(p.name || ''),
				description: p.description ? String(p.description) : undefined,
			}))
			: undefined,
		use_when: Array.isArray(raw.use_when) ? raw.use_when.map(String) : undefined,
		not_for: Array.isArray(raw.not_for) ? raw.not_for.map(String) : undefined,
	};
}

// ---- Chat constants ----

const CHAT_ACTION_TYPES = [
	'ADD_PHASE', 'REMOVE_PHASE', 'UPDATE_PHASE',
	'ADD_ROLE', 'UPDATE_ROLE', 'REMOVE_ROLE',
	'ADD_DEPENDENCY', 'REMOVE_DEPENDENCY',
	'UPDATE_TEAM',
] as const;

const CHAT_SYSTEM_PROMPT = `You are an expert assistant helping a user refine a multi-agent team on the "cliq" platform.
You will receive the current team definition (JSON) and a conversation history.

${PHASE_TYPES}

${ROLE_STRUCTURE}

When the user asks for changes, respond with ONLY a JSON object:
{
  "reply": "Conversational summary of what you did (1-3 sentences).",
  "actions": [
    ... zero or more actions to apply ...
  ]
}

Available action types:
- { "type": "ADD_PHASE", "phase": { "name": "kebab-case", "type": "standard|gate|team", "depends_on": [...], "agent": "optional", "commands": [...], "max_iterations": N, "sources": [...], "target_entries": [...], "review": { "reviewer": "...", "artifacts": [...], "timeout": "...", "remind_every": "..." }, "team": "sub-team", "inputs": {...}, "is_support": true|false } }
- { "type": "REMOVE_PHASE", "name": "phase-name" }
- { "type": "UPDATE_PHASE", "phase": { "name": "existing-name", "type": "...", "depends_on": [...], "sources": [...], "target_entries": [...], "reviewer": "...", ... } }
- { "type": "ADD_ROLE", "role": { "name": "kebab-case", "content": "Full markdown role prompt..." } }
- { "type": "UPDATE_ROLE", "name": "role-name", "content": "Updated markdown..." }
- { "type": "REMOVE_ROLE", "name": "role-name" }
- { "type": "ADD_DEPENDENCY", "phase": "target-phase", "dependency": "source-phase" }
- { "type": "REMOVE_DEPENDENCY", "phase": "target-phase", "dependency": "source-phase" }
- { "type": "UPDATE_TEAM", "team": { "name": "...", "description": "..." } }
  (only use for name/description/metadata changes, and include ALL existing fields)

Sources and targets in actions:
- Any phase may have "sources": [{ "name": "slug", "url": "...", "body": "optional request body" }] for data ingestion. When "body" is present, method defaults to POST and Content-Type defaults to application/json
- Any phase may have "target_entries": [{ "name": "slug", "file": "local-path", "mode": "create|append|replace" }] for data output
- Only add sources/targets when explicitly requested or when the team clearly involves external data integration.

Human review (hug) in actions:
- Use type: "gate" with agent: "hug" for human-in-the-loop review
- Flat fields on the phase: "reviewer", "artifacts", "timeout", "remind_every"
- MAY have "commands" (automated results shown to the human reviewer)
- Use hug when the user asks for human review, human approval, or human-in-the-loop validation

Team delegation in actions:
- type: "team" phases must have "team" field and may have "inputs" map
- No commands, no role file needed

Support phases in actions:
- Support phases use is_support: true and their real functional type (e.g. "standard"), not "support".
- Support phases must have empty depends_on.

Rules:
- Phase and role names must be kebab-case
- Role names should match their phase name
- Gates must have commands and max_iterations
- Hug gates (agent: "hug") must have review.reviewer and may have commands
- Exec phases (agent: "exec") must have commands
- Team phases must have a team field, no role needed
- Every phase needs a root (at least one phase with empty depends_on)
- If adding a standard or gate phase, also add a corresponding role (unless agent is "exec")
- If removing a phase, also remove its role
- If adding a support phase (is_support: true), ensure at least one gate role describes when to route to it. Update the gate role if needed.
- If adding a gate phase, the role should describe evaluation criteria (when to pass, route to support phases, or escalate) — the orchestrator injects the verdict protocol automatically
- NEVER invent tools, APIs, or SDKs in role prompts — agents can only read/write files and run shell commands
- Use an empty actions array if the user is just asking a question
- Return ONLY the JSON object, no markdown fences, no extra text`;

// ---- Service class ----

export class BuilderService {

	constructor(private _llm_adapter: LlmAdapter) {}

	async generate(
		_auth: AuthContext,
		params: { intent: string },
		opts: { on_progress?: (stage: 'designing' | 'filling_roles' | 'validating') => void } = {},
	) {
		if (!params.intent?.trim()) {
			throw new ApiError('invalid_params', 'intent is required', 422);
		}

		if (params.intent.length > 5000) {
			throw new ApiError('invalid_params', 'Intent must be under 5000 characters', 422);
		}

		const messages: LlmMessage[] = [
			{
				role: 'system',
				content: `You are an expert multi-agent team architect for the "cliq" orchestration platform.

${PLATFORM_REFERENCE}

${REFERENCE_EXAMPLES}

Each team is a DAG of phases. Each phase runs an AI agent with a role prompt. Phases can depend on other phases.

${PHASE_TYPES}

${ROLE_STRUCTURE}

Rules:
- Every workflow must have at least one root phase (no dependencies)
- Phase names must be unique, kebab-case
- Role names must match their phase name exactly
- Gate roles need role files with evaluation criteria. Team phases and exec phases (agent: "exec") don't need role files.
- Support phases go in the "support" array, not "phases". They need role files and MUST be referenced by a gate's ROUTE directive.
- The team name should be descriptive and kebab-case
- Generate tags, use_when, not_for, and inputs at the top level
- Use realistic shell commands for gate commands (npm test, npm run build, etc.)
- When the team involves external data, use "sources" and "target_entries" fields on phases. Do NOT create role prompts that try to call external APIs.
- When the user asks for human review, human approval, or sign-off, use type: gate with agent: "hug" and flat reviewer/artifacts/timeout/remind_every fields.
- NEVER invent tools, APIs, or SDKs in role prompts. Agents can only read/write files and run shell commands.
- Only generate a tech stack (language, framework, libraries) if the user explicitly mentions one. Do NOT assume or infer technologies.

${METADATA_FORMAT}

${OUTPUT_FORMAT}`,
			},
			{ role: 'user', content: `Design a multi-agent team for the following intent:\n\n${params.intent}` },
		];

		try {
			opts.on_progress?.('designing');
			const response = await this._llm_adapter.complete(messages);
			const raw = extract_json(response.text) as Record<string, unknown>;

			const phases = parse_phases(raw.phases);
			const support = parse_phases(raw.support, true);
			const all_phases = [...phases, ...support];
			const roles = parse_roles(raw.roles);

			const phases_needing_roles = all_phases.filter(p => p.type !== 'team' && p.agent !== 'exec');
			const MAX_ROLE_RETRIES = 3;

			for (let attempt = 0; attempt < MAX_ROLE_RETRIES; attempt++) {
				const role_names = new Set(roles.map(r => r.name));
				const missing = phases_needing_roles.filter(p => !role_names.has(p.name));
				if (missing.length === 0) break;

				opts.on_progress?.('filling_roles');
				const phase_list = all_phases.map(p => `- ${p.name} [${p.type}]${p.is_support ? ' (support)' : ''}${p.depends_on.length ? ` (depends on: ${p.depends_on.join(', ')})` : ''}`).join('\n');
				const existing_roles = roles.map(r => `- ${r.name}: ${r.content.slice(0, 80)}...`).join('\n');
				const missing_names = missing.map(p => p.name).join(', ');

				const fill_messages: LlmMessage[] = [
					{
						role: 'system',
						content: `You are generating role prompts for a "cliq" multi-agent team.\n\n${ROLE_STRUCTURE}\n\nReturn ONLY a JSON array of role objects: [{ "name": "phase-name", "content": "Full markdown role prompt..." }]\n\nGenerate complete, detailed role prompts. Each role must have: Identity, Objective, Context, Deliverables, Constraints, Handoff sections.`,
					},
					{
						role: 'user',
						content: `Team: ${raw.name} — ${raw.description}\n\nAll phases:\n${phase_list}\n\nExisting roles (for style reference):\n${existing_roles}\n\nGenerate roles for ONLY these phases: ${missing_names}`,
					},
				];

				const fill_response = await this._llm_adapter.complete(fill_messages);
				const fill_raw = extract_json(fill_response.text);
				const new_roles = parse_roles(Array.isArray(fill_raw) ? fill_raw : (fill_raw as Record<string, unknown>).roles);
				for (const r of new_roles) {
					if (!roles.some(existing => existing.name === r.name)) {
						roles.push(r);
					}
				}
			}

			const final_role_names = new Set(roles.map(r => r.name));
			const still_missing = phases_needing_roles.filter(p => !final_role_names.has(p.name));
			if (still_missing.length > 0) {
				throw new ApiError('generation_failed', `Failed to generate roles for phases: ${still_missing.map(p => p.name).join(', ')}`, 500);
			}

			opts.on_progress?.('validating');
			const metadata = parse_metadata(raw);
			const team: GeneratedTeam = {
				name: normalise_name(String(raw.name || '')),
				description: String(raw.description || ''),
				...metadata,
				phases: all_phases,
				roles,
				agents: [],
			};

			const validation = validate_team(team);

			return { team, validation, usage: response.usage };
		} catch (err) {
			if (err instanceof ApiError) throw err;
			const message = err instanceof Error ? err.message : 'Generation failed';
			throw new ApiError('generation_failed', message, 500);
		}
	}

	/** Start generate in the background; poll via get_generate_job. */
	start_generate(auth: AuthContext, params: { intent: string }) {
		if (!params.intent?.trim()) {
			throw new ApiError('invalid_params', 'intent is required', 422);
		}
		if (params.intent.length > 5000) {
			throw new ApiError('invalid_params', 'Intent must be under 5000 characters', 422);
		}

		const job = create_builder_job();
		const intent = params.intent.trim();

		void this.generate(auth, { intent }, {
			on_progress: (stage) => {
				update_builder_job(job.id, { status: 'running', stage });
			},
		}).then((result) => {
			update_builder_job(job.id, {
				status: 'done',
				stage: 'done',
				result,
			});
		}).catch((err) => {
			const code = err instanceof ApiError ? err.code : 'generation_failed';
			const message = err instanceof Error ? err.message : 'Generation failed';
			update_builder_job(job.id, {
				status: 'error',
				stage: 'error',
				error: { code, message },
			});
		});

		return {
			job_id: job.id,
			status: job.status,
			stage: job.stage,
		};
	}

	get_generate_job(job_id: string) {
		const job = get_builder_job(job_id);
		if (!job) {
			throw new ApiError('not_found', `Generate job '${job_id}' not found or expired`, 404);
		}

		if (job.status === 'done') {
			return {
				job_id: job.id,
				status: job.status,
				stage: job.stage,
				...(job.result as object),
			};
		}

		if (job.status === 'error') {
			return {
				job_id: job.id,
				status: job.status,
				stage: job.stage,
				error: job.error,
			};
		}

		return {
			job_id: job.id,
			status: job.status,
			stage: job.stage,
		};
	}


	async improve_role(
		_auth: AuthContext,
		params: {
			role_name: string;
			role_content: string;
			team_name: string;
			team_description: string;
			phases: string[];
			instruction?: string;
		},
	) {
		if (!params.role_name || !params.role_content) {
			throw new ApiError('invalid_params', 'role_name and role_content are required', 422);
		}

		if (params.role_content.length > 50000) {
			throw new ApiError('invalid_params', 'Role content must be under 50000 characters', 422);
		}

		const focus = params.instruction ? `\n\nSpecific improvement request: ${params.instruction}` : '';
		const messages: LlmMessage[] = [
			{
				role: 'system',
				content: `You are an expert at writing AI agent role prompts for the "cliq" orchestration platform.

${PLATFORM_REFERENCE}

${ROLE_STRUCTURE}

Rules:
- Preserve the overall structure and intent of the role
- Make instructions more specific and actionable
- Add concrete examples where helpful
- Ensure deliverables are clearly defined
- Keep the tone professional and direct
- NEVER introduce references to external APIs, custom tools, or SDKs — agents can only read/write files and run shell commands
- If the role references pulled content, use local paths (.cliq/pull/<name>/)
- Gate roles should describe evaluation criteria in plain language — the orchestrator injects the verdict protocol automatically

Return ONLY a JSON object (no markdown fences, no commentary):
{
  "name": "role-name",
  "original_content": "the original content verbatim",
  "improved_content": "the improved markdown content",
  "changes_summary": "brief summary of what changed and why"
}`,
			},
			{
				role: 'user',
				content: `Team: ${params.team_name} — ${params.team_description}\nPhases: ${(params.phases || []).join(' → ')}\n\nImprove this role prompt for the "${params.role_name}" phase:\n\n---\n${params.role_content}\n---${focus}`,
			},
		];

		try {
			const response = await this._llm_adapter.complete(messages);
			const raw = extract_json(response.text) as Record<string, unknown>;

			return {
				name: String(raw.name || params.role_name),
				original_content: String(raw.original_content || params.role_content),
				improved_content: String(raw.improved_content || ''),
				changes_summary: String(raw.changes_summary || ''),
			};
		} catch (err) {
			if (err instanceof ApiError) throw err;
			const message = err instanceof Error ? err.message : 'Improvement failed';
			throw new ApiError('generation_failed', message, 500);
		}
	}


	async suggest(
		_auth: AuthContext,
		params: { team_name: string; description: string; phases: GeneratedPhase[]; roles: GeneratedRole[] },
	) {
		if (!params.team_name) {
			throw new ApiError('invalid_params', 'team_name is required', 422);
		}

		const phase_summary = (params.phases || []).map(p => {
			let line = `  - ${p.name} [${p.type}]`;
			if (p.is_support) line += ' (support)';
			if (p.agent) line += ` (agent: ${p.agent})`;
			if (p.sources?.length) line += ` (${p.sources.length} sources)`;
			if (p.target_entries?.length) line += ` (${p.target_entries.length} targets)`;
			if (p.team) line += ` (team: ${p.team})`;
			return line;
		}).join('\n');
		const role_summary = (params.roles || []).map(r => `  - ${r.name}: ${r.content.slice(0, 120)}...`).join('\n');

		const messages: LlmMessage[] = [
			{
				role: 'system',
				content: `You are an expert multi-agent team architect for the "cliq" orchestration platform. Analyze a team configuration and suggest improvements.

${PLATFORM_REFERENCE}

${PHASE_TYPES}

When suggesting improvements:
- If the team handles external data but lacks sources/target_entries, suggest adding them
- If gate roles lack clear evaluation criteria (when to pass, route, escalate), suggest adding them
- If roles reference APIs or tools that don't exist in cliq, suggest corrections
- Suggested roles must follow cliq conventions: agents read/write files and run shell commands only
- If the team would benefit from human review, suggest a gate phase with agent: hug

Return ONLY a JSON array of suggestions (no markdown fences, no commentary):
[
  {
    "type": "missing_role|missing_gate|orphaned_support|missing_criteria|workflow_improvement|metadata_enhancement|source_suggestion|target_suggestion|hug_suggestion|team_suggestion",
    "title": "Short title",
    "description": "Why this improvement matters and what it adds"
  }
]

Return an empty array [] if the team is already well-structured.`,
			},
			{
				role: 'user',
				content: `Analyze this team and suggest improvements:\n\nTeam: ${params.team_name}\nDescription: ${params.description}\n\nPhases:\n${phase_summary}\n\nRoles:\n${role_summary}`,
			},
		];

		try {
			const response = await this._llm_adapter.complete(messages);
			const suggestions = extract_json(response.text);
			return { suggestions };
		} catch (err) {
			if (err instanceof ApiError) throw err;
			const message = err instanceof Error ? err.message : 'Suggestion failed';
			throw new ApiError('generation_failed', message, 500);
		}
	}


	validate(_auth: AuthContext, params: { team: GeneratedTeam }) {
		if (!params.team) {
			throw new ApiError('invalid_params', 'team is required', 422);
		}

		return validate_team(params.team);
	}


	async chat(
		_auth: AuthContext,
		params: {
			team: GeneratedTeam;
			message: string;
			history?: ChatMessage[];
		},
	) {
		if (!params.team) {
			throw new ApiError('invalid_params', 'team is required', 422);
		}
		if (!params.message?.trim()) {
			throw new ApiError('invalid_params', 'message is required', 422);
		}

		if (params.message.length > 5000) {
			throw new ApiError('invalid_params', 'Message must be under 5000 characters', 422);
		}

		const history_size = (params.history || []).reduce((n: number, m: ChatMessage) => n + m.content.length, 0);
		if (history_size > 100000) {
			throw new ApiError('invalid_params', 'Chat history too large', 422);
		}

		const team_context = JSON.stringify(params.team, null, 2);
		const history: ChatMessage[] = params.history || [];

		const messages: LlmMessage[] = [
			{ role: 'system', content: CHAT_SYSTEM_PROMPT },
			{ role: 'user', content: `Current team definition:\n\`\`\`json\n${team_context}\n\`\`\`` },
			{ role: 'assistant', content: '{"reply": "I have the current team definition. What changes would you like to make?", "actions": []}' },
		];

		for (const msg of history) {
			messages.push({ role: msg.role, content: msg.content });
		}

		messages.push({ role: 'user', content: params.message });

		try {
			const response = await this._llm_adapter.complete(messages);
			const raw = extract_json(response.text) as Record<string, unknown>;

			const reply = String(raw.reply || 'Done.');
			const raw_actions = Array.isArray(raw.actions) ? raw.actions : [];

			const actions = raw_actions.filter((a: Record<string, unknown>) =>
				a && typeof a.type === 'string' && CHAT_ACTION_TYPES.includes(a.type as typeof CHAT_ACTION_TYPES[number]),
			);

			return { reply, actions, usage: response.usage };
		} catch (err) {
			if (err instanceof ApiError) throw err;
			const message = err instanceof Error ? err.message : 'Chat failed';
			throw new ApiError('generation_failed', message, 500);
		}
	}
}

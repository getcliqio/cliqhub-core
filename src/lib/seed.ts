/**
 * Seed built-in data (scopes, agents, teams, notification channels, settings).
 * Uses Sequelize bulkCreate with ignoreDuplicates for idempotency.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { get_logger } from './log.js';

const log = get_logger('seed');
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function seed_all(): Promise<void> {
    const t0 = Date.now();

    const step = async (label: string, fn: () => Promise<void>) => {
        const s = Date.now();
        await fn();
        log.debug('seed_step', { label, duration_ms: Date.now() - s });
    };

    await step('scopes', seed_scopes);
    await step('agent_catalog', seed_agent_catalog);
    await step('teams', seed_teams);
    await step('notifications', seed_notifications);
    await step('settings', seed_settings);

    log.info('seed_complete', { duration_ms: Date.now() - t0 });
}


async function seed_scopes(): Promise<void> {
    const { Scope } = await import('../models/index.js');
    await Scope.bulkCreate([
        { id: '00000000-0000-0000-0000-000000000000', slug: 'cliq', name: 'Cliq', is_default: 1, created_at: 0 },
        { id: '00000000-0000-0000-0000-000000000001', slug: 'measureone', name: 'MeasureOne', is_default: 0, created_at: 0 },
    ], { ignoreDuplicates: true });
}


/**
 * Seed platform agents into `cliq.agent_catalog` (Hub SoT).
 * Does not write store `cliq.agents` — that table is daemon-local only.
 *
 * - Inserts missing names.
 * - Upgrades version/description/manifest/agent_type when the builtin
 *   version is **newer**.
 * Boot used to `updateOnDuplicate` every row and stuck jira at 1.0.0
 * without get_issue_tree even when a richer catalog had been seeded.
 */
async function seed_agent_catalog(): Promise<void> {
    const { randomUUID } = await import('node:crypto');
    const { AgentCatalog } = await import('../models/index.js');

    function version_tuple(v: string | null | undefined): number[] {
        if (!v) return [0];
        return String(v).split(/[.+-]/).map((p) => {
            const n = Number.parseInt(p, 10);
            return Number.isFinite(n) ? n : 0;
        });
    }

    function is_newer(candidate: string, existing: string | null | undefined): boolean {
        const a = version_tuple(candidate);
        const b = version_tuple(existing);
        const len = Math.max(a.length, b.length);
        for (let i = 0; i < len; i++) {
            const av = a[i] ?? 0;
            const bv = b[i] ?? 0;
            if (av > bv) return true;
            if (av < bv) return false;
        }
        return false;
    }

type SE = string | { key: string; description: string; default?: unknown; when?: Record<string, string> };
    type AgentType = 'llm' | 'exec' | 'gate' | 'connector' | 'notify' | 'meta';
    interface BuiltinDef {
        name: string; description: string; version: string; agent_type: AgentType;
        capabilities: string[]; settings?: { required?: SE[]; optional?: SE[] };
        inputs?: Record<string, unknown>; binaries?: string[];
        dockerfile?: string; dependencies?: string;
    }

    const llm_inputs = (default_model: string, needs_fs = false) => ({
        role: { type: 'string', required: true, description: 'Instructions for the agent' },
        model: { type: 'string', required: false, default: default_model, description: 'LLM model to use' },
        temperature: { type: 'number', required: false, description: 'Sampling temperature' },
        max_turns: { type: 'number', required: false, description: 'Maximum conversation turns' },
        needs_filesystem: { type: 'boolean', required: false, default: needs_fs, description: 'Needs workspace filesystem access' },
    });

    const llm_optional_settings = (default_model: string, needs_fs = false) => ([
        { key: 'model', description: 'LLM model to use', default: default_model },
        { key: 'temperature', description: 'Sampling temperature' },
        { key: 'max_turns', description: 'Maximum conversation turns' },
        { key: 'needs_filesystem', description: 'Needs workspace filesystem access', default: needs_fs },
    ]);

    const builtin_dockerfile = 'FROM ghcr.io/sapshah/cliq-runtime:latest\n# Built-in agent.\n# No additional build steps.';
    const cli_dockerfile = (binary: string, cmd: string) => `FROM ghcr.io/sapshah/cliq-runtime:latest\n# Requires ${binary} CLI.\nRUN ${cmd}`;
    const cli_deps = (binary: string, cmd: string) => `- name: ${binary}\n  install: ${cmd}\n`;

    const runtime_task = { type: 'string', required: false, source: 'runtime', description: 'Requirement or instruction' } as const;

    const builtins: BuiltinDef[] = [
        { name: 'exec', agent_type: 'exec', description: 'Execute shell commands sequentially', version: '1.0.0', capabilities: ['phase:standard'],
          inputs: { commands: { type: 'command[]', required: true, description: 'Shell commands to execute' } }, dockerfile: builtin_dockerfile },
        { name: 'cursor', agent_type: 'llm', description: 'Cursor AI agent', version: '1.0.0', capabilities: ['phase:standard', 'phase:gate'],
          settings: { required: [{ key: 'api_key', description: 'Cursor API key' }], optional: llm_optional_settings('claude-sonnet-4-20250514', true) }, binaries: ['agent'],
          inputs: { ...llm_inputs('claude-sonnet-4-20250514', true), task: runtime_task },
          dockerfile: cli_dockerfile('cursor', 'npm install -g @anthropic-ai/cursor'), dependencies: cli_deps('cursor', 'npm install -g @anthropic-ai/cursor') },
        { name: 'claude-code', agent_type: 'llm', description: 'Claude Code agent', version: '1.0.0', capabilities: ['phase:standard', 'phase:gate'],
          settings: { required: [{ key: 'api_key', description: 'Anthropic API key' }], optional: llm_optional_settings('claude-sonnet-4-20250514', true) }, binaries: ['claude'],
          inputs: { ...llm_inputs('claude-sonnet-4-20250514', true), task: runtime_task },
          dockerfile: cli_dockerfile('claude', 'npm install -g @anthropic-ai/claude-code'), dependencies: cli_deps('claude', 'npm install -g @anthropic-ai/claude-code') },
        { name: 'claude-api', agent_type: 'llm', description: 'Claude API agent', version: '1.0.0', capabilities: ['phase:standard', 'phase:gate'],
          settings: { required: [{ key: 'api_key', description: 'Anthropic API key' }], optional: llm_optional_settings('claude-sonnet-4-20250514') },
          inputs: { ...llm_inputs('claude-sonnet-4-20250514'), task: runtime_task }, dockerfile: builtin_dockerfile },
        { name: 'gemini', agent_type: 'llm', description: 'Gemini agent', version: '1.0.0', capabilities: ['phase:standard', 'phase:gate'],
          settings: { required: [{ key: 'api_key', description: 'Google API key' }], optional: llm_optional_settings('gemini-2.5-pro', true) }, binaries: ['gemini'],
          inputs: { ...llm_inputs('gemini-2.5-pro', true), task: runtime_task },
          dockerfile: cli_dockerfile('gemini', 'npm install -g @anthropic-ai/gemini'), dependencies: cli_deps('gemini', 'npm install -g @anthropic-ai/gemini') },
        { name: 'gemini-api', agent_type: 'llm', description: 'Gemini API agent', version: '1.0.0', capabilities: ['phase:standard', 'phase:gate'],
          settings: { required: [{ key: 'api_key', description: 'Google API key' }], optional: llm_optional_settings('gemini-2.5-flash') },
          inputs: { ...llm_inputs('gemini-2.5-flash'), task: runtime_task }, dockerfile: builtin_dockerfile },
        { name: 'openai-api', agent_type: 'llm', description: 'OpenAI API agent', version: '1.0.0', capabilities: ['phase:standard', 'phase:gate'],
          settings: { required: [{ key: 'api_key', description: 'OpenAI API key' }], optional: llm_optional_settings('gpt-4o') },
          inputs: { ...llm_inputs('gpt-4o'), task: runtime_task }, dockerfile: builtin_dockerfile },
        { name: 'codex', agent_type: 'llm', description: 'Codex agent', version: '1.0.0', capabilities: ['phase:standard', 'phase:gate'],
          settings: { required: [{ key: 'api_key', description: 'OpenAI API key' }], optional: llm_optional_settings('gpt-4.1', true) }, binaries: ['codex'],
          inputs: { ...llm_inputs('gpt-4.1', true), task: runtime_task },
          dockerfile: cli_dockerfile('codex', 'npm install -g @openai/codex'), dependencies: cli_deps('codex', 'npm install -g @openai/codex') },
        { name: 'curl', agent_type: 'connector', description: 'HTTP connector', version: '1.0.0', capabilities: ['phase:standard'],
          inputs: { sources: { type: 'source_entry[]', required: false }, target_entries: { type: 'target_entry[]', required: false } }, dockerfile: builtin_dockerfile },
        { name: 'git', agent_type: 'connector', description: 'Git finalization', version: '1.1.0', capabilities: ['phase:standard', 'notify'],
          settings: {
            required: [
              { key: 'provider', description: 'Git hosting provider: github or bitbucket', default: 'github' },
              { key: 'github.token', description: 'GitHub personal access token (repo scope)', when: { provider: 'github' } },
              { key: 'bitbucket.email', description: 'Bitbucket account email', when: { provider: 'bitbucket' } },
              { key: 'bitbucket.api_token', description: 'Bitbucket API token / app password', when: { provider: 'bitbucket' } },
              { key: 'bitbucket.workspace', description: 'Bitbucket workspace slug', when: { provider: 'bitbucket' } },
            ] as SE[],
            optional: [
              { key: 'github.base_branch', description: "Default PR base branch for GitHub repos (fallback when the open-pr phase does not pin one; further fallback to the remote's HEAD symref, then 'main')", default: 'main', when: { provider: 'github' } },
              { key: 'github.remote', description: 'Git remote name', default: 'origin', when: { provider: 'github' } },
              { key: 'github.pr_draft', description: 'Create PRs as drafts', default: false, when: { provider: 'github' } },
              { key: 'bitbucket.base_url', description: 'Bitbucket API base URL', when: { provider: 'bitbucket' } },
              { key: 'bitbucket.base_branch', description: "Default PR base branch for Bitbucket repos (fallback when the open-pr phase does not pin one; further fallback to the remote's HEAD symref, then 'main')", when: { provider: 'bitbucket' } },
            ] as SE[],
          }, binaries: ['git'],
          inputs: {
            action: { type: 'string', required: true, default: 'create_pr', description: "Git operation to perform (currently only 'create_pr')" },
            project_dir: { type: 'string', required: false, description: 'Working tree the PR is opened from (defaults to process.cwd())' },
            base_branch: { type: 'string', required: false, description: "Destination branch for the PR (e.g. 'master', 'develop'). Overrides settings.<provider>.base_branch and the remote HEAD auto-detect; falls back to 'main' if none is available" },
          }, dockerfile: builtin_dockerfile,
          dependencies: '- name: git\n  install: apk add --no-cache git\n' },
        // Keep in sync with cliq-agents/jira/manifest.json (v1.2.1).
        { name: 'jira', agent_type: 'connector',
          description: 'Jira connector — fetch issues/trees, create/update Stories from dispatch.json, comments, transitions',
          version: '1.2.0', capabilities: ['phase:standard', 'notify'],
          settings: { required: [
            { key: 'base_url', description: 'Jira instance URL, e.g. https://yoursite.atlassian.net' },
            { key: 'email', description: 'Jira account email for authentication' },
            { key: 'api_token', description: 'Jira API token for authentication' },
          ] },
          inputs: {
            action: {
              type: 'string', required: true,
              description: 'Jira operation: get_issue | get_issue_tree | get_comments | search | add_comment | transition | create_issue | update_issue | update_fields',
            },
            sources: { type: 'source_entry[]', required: false, description: 'Jira resources to fetch (issues, trees, comments, search)' },
            target_entries: { type: 'target_entry[]', required: false, description: 'Jira resources to write (comments, transitions, dispatch.json create/update)' },
          },
          dockerfile: builtin_dockerfile },
        { name: 'confluence', agent_type: 'connector', description: 'Confluence connector', version: '1.0.0', capabilities: ['phase:standard'],
          settings: { required: [{ key: 'base_url', description: 'Confluence URL' }, { key: 'email', description: 'Email' }, { key: 'api_token', description: 'API token' }] },
          inputs: { action: { type: 'string', required: true } }, dockerfile: builtin_dockerfile },
        { name: 'zendesk', agent_type: 'connector', description: 'Zendesk connector', version: '1.0.0', capabilities: ['phase:standard'],
          settings: { required: [{ key: 'subdomain', description: 'Zendesk subdomain' }, { key: 'email', description: 'Email' }, { key: 'api_token', description: 'API token' }] },
          inputs: { action: { type: 'string', required: true } }, dockerfile: builtin_dockerfile },
        { name: 'hubspot', agent_type: 'connector', description: 'HubSpot connector', version: '1.0.0', capabilities: ['phase:standard'],
          settings: { required: [{ key: 'access_token', description: 'HubSpot access token' }] },
          inputs: { action: { type: 'string', required: true } }, dockerfile: builtin_dockerfile },
        { name: 'datadog', agent_type: 'connector', description: 'Datadog connector', version: '1.0.0', capabilities: ['phase:standard'],
          settings: { required: [{ key: 'api_key', description: 'Datadog API key' }, { key: 'app_key', description: 'Datadog app key' }] },
          inputs: { action: { type: 'string', required: true } }, dockerfile: builtin_dockerfile },
        { name: 's3', agent_type: 'connector', description: 'S3 connector', version: '1.0.0', capabilities: ['phase:standard'],
          settings: { required: [{ key: 'access_key_id', description: 'AWS access key' }, { key: 'secret_access_key', description: 'AWS secret key' }] },
          inputs: { sources: { type: 'source_entry[]', required: false }, target_entries: { type: 'target_entry[]', required: false } }, dockerfile: builtin_dockerfile },
        { name: 'gdrive', agent_type: 'connector', description: 'Google Drive connector', version: '1.0.0', capabilities: ['phase:standard'],
          settings: { required: [{ key: 'credentials_file', description: 'Service account credentials JSON' }] },
          inputs: { sources: { type: 'source_entry[]', required: false }, target_entries: { type: 'target_entry[]', required: false } }, dockerfile: builtin_dockerfile },
        { name: 'slack', agent_type: 'notify', description: 'Slack notification agent', version: '1.0.0', capabilities: ['notify'],
          settings: { required: [{ key: 'channels', description: 'Channel-to-webhook mapping' }] },
          inputs: { notify: { type: 'string[]', required: false } }, dockerfile: builtin_dockerfile },
        { name: 'mesh', agent_type: 'connector', description: 'Svantic mesh agent', version: '1.0.0', capabilities: ['phase:standard'],
          settings: { required: [{ key: 'url', description: 'Mesh server URL' }, { key: 'client_id', description: 'OAuth client ID' }, { key: 'client_secret', description: 'OAuth client secret' }] },
          inputs: { role: { type: 'string', required: false, description: 'Instructions for the agent' }, sources: { type: 'source_entry[]', required: false },
                    task: { type: 'string', required: true, source: 'runtime', description: 'Query for the mesh agent' } }, dockerfile: builtin_dockerfile },
        { name: 'hug', agent_type: 'gate', description: 'HUG human-in-the-loop gate via CliqHub reviews', version: '1.0.0', capabilities: ['phase:gate'],
          settings: { required: [], optional: [{ key: 'server_url', description: 'Legacy standalone HUG server URL (unused when Hub-native)' }] },
          inputs: { role: { type: 'string', required: true, description: 'Instructions for the agent' }, review: { type: 'object', required: true } }, dockerfile: builtin_dockerfile },
        { name: 'team', agent_type: 'meta', description: 'Team phase agent — sub-team launcher', version: '1.0.0', capabilities: ['phase:standard'],
          inputs: { team: { type: 'string', required: true } }, dockerfile: builtin_dockerfile },
        { name: 'echo', agent_type: 'exec', description: 'Echo agent — echoes upstream data', version: '1.0.0', capabilities: ['phase:standard'],
          inputs: {}, dockerfile: builtin_dockerfile },
        { name: 'auto-gate', agent_type: 'gate', description: 'Auto-gate agent — deterministic gate', version: '1.0.0', capabilities: ['phase:gate'],
          inputs: {}, dockerfile: builtin_dockerfile },
    ];
    const now = new Date();
    const rows = builtins.map((agent) => {
        const manifest: Record<string, unknown> = {
            name: agent.name,
            transport: 'PROCESS',
            version: agent.version,
            description: agent.description,
            entry: './agent.js',
            capabilities: agent.capabilities,
            inputs: agent.inputs ?? {},
            agent_type: agent.agent_type,
        };
        if (agent.settings) manifest.settings = agent.settings;
        if (agent.binaries) manifest.binaries = agent.binaries;
        if (agent.dockerfile) manifest.dockerfile = agent.dockerfile;
        if (agent.dependencies) manifest.dependencies = agent.dependencies;

        return {
            id: randomUUID(),
            name: agent.name,
            version: agent.version,
            description: agent.description,
            agent_type: agent.agent_type,
            manifest,
            is_system: true,
            deleted: false,
            deleted_at: null as number | null,
            created_at: now,
            updated_at: now,
        };
    });

    await AgentCatalog.bulkCreate(rows, {
        ignoreDuplicates: true,
    });

    // Upgrade outdated builtin metadata (version/description/manifest/agent_type).
    for (const row of rows) {
        const existing = await AgentCatalog.findOne({ where: { name: row.name } });
        if (!existing) continue;
        if (!is_newer(row.version, existing.version)) continue;
        await existing.update({
            version: row.version,
            description: row.description,
            agent_type: row.agent_type,
            manifest: row.manifest,
            is_system: true,
            updated_at: now,
        });
    }
}


async function seed_teams(): Promise<void> {
    const { Team, Scope: PublicScope, User } = await import('../db/models/index.js');
    const { TeamVersion } = await import('../db/models/index.js');

    /**
     * Ensure the @cliq scope exists in public.scopes so teams are
     * visible on the Teams page. Needs an existing user for owner_id
     * (e2e global_setup / first admin may create users after first boot).
     */
    let owner_id: string | undefined = (
        await User.findOne({
            order: [['id', 'ASC']],
            attributes: ['id'],
            raw: true,
        })
    )?.id;
    if (owner_id == null) {
        // Fresh DB: create bootstrap admin so @cliq scope + hello-world can seed.
        // e2e global_setup upserts the same username with a known password.
        const { hash_password } = await import('../auth/password.js');
        const password_hash = await hash_password('admin123');
        const created = await User.create({
            username: 'admin',
            email: 'admin@cliqhub.io',
            password_hash,
            display_name: 'admin',
            role: 'admin',
        });
        owner_id = created.id;
    }

    await PublicScope.findOrCreate({
        where: { slug: 'cliq' },
        defaults: {
            slug: 'cliq',
            display_name: 'Cliq',
            owner_id,
            visibility: 'public',
            scope_type: 'org',
        },
    });

    const HELLO_WORLD_VERSION = '2.0.0';
    const HELLO_WORLD_DESCRIPTION =
        'Prints a greeting for the provided name, produces a review artifact, and waits for human approval.';

    const workflow_json = JSON.stringify({
        phases: [
            {
                name: 'greet',
                type: 'standard',
                agent: 'exec',
                commands: [
                    { name: 'print-name', run: 'echo "Hi {{inputs.name}}"' },
                    { name: 'write-artifact', run: 'printf \'Hi %s, this is cliq team running and producing this artifact for your review.\\n\' "{{inputs.name}}" > review.txt' },
                    { name: 'show-artifact', run: 'cat review.txt' },
                ],
            },
            {
                name: 'human-review',
                type: 'gate',
                agent: 'hug',
                depends_on: ['greet'],
                review: {
                    timeout: 60,
                    reviewers: [
                        { policy: 'any', channels: ['{{inputs.reviewers}}'] },
                    ],
                },
            },
            {
                name: 'done',
                type: 'standard',
                agent: 'exec',
                depends_on: ['human-review'],
                commands: [
                    { name: 'complete', run: 'echo "Approved for {{inputs.name}} — hello-world complete."' },
                ],
            },
        ],
    });

    const [team, created] = await Team.findOrCreate({
        where: { name: 'hello-world', scope: 'cliq' },
        defaults: {
            name: 'hello-world',
            scope: 'cliq',
            scope_type: 'org',
            description: HELLO_WORLD_DESCRIPTION,
            author_id: null,
            license: 'MIT',
            visibility: 'public',
            listed: 1,
            install_count: 0,
        },
    });

    if (created) {
        log.info('seeded registry team @cliq/hello-world');
    }

    /** Upsert the version row — update workflow_json if version already exists. */
    const existing_ver = await TeamVersion.findOne({
        where: { team_id: team.id, version: HELLO_WORLD_VERSION },
    });

    const version_data = {
        team_id: team.id,
        version: HELLO_WORLD_VERSION,
        changelog: 'Built-in hello-world team.',
        package_path: '',
        workflow_json,
        readme: '# @cliq/hello-world\n\nA simple team that greets a user, produces a review artifact, and waits for human approval.',
        capability_json: JSON.stringify({
            inputs: [
                { name: 'name', type: 'text', description: 'Who to greet', required: true },
                { name: 'reviewers', type: 'channel', description: 'Who should review this run', required: true },
            ],
        }),
        agents_json: JSON.stringify({ exec: {}, hug: {} }),
        roles_json: '[]',
        cliq_version: null,
        tools: '[]',
    };

    if (existing_ver) {
        await existing_ver.update(version_data);
        log.info(`updated registry version @cliq/hello-world@${HELLO_WORLD_VERSION}`);
    } else {
        await TeamVersion.create(version_data);
        log.info(`seeded registry version @cliq/hello-world@${HELLO_WORLD_VERSION}`);
    }
}


async function seed_notifications(): Promise<void> {
    // Channels are realm-scoped and created on realm provisioning
    // (cliqhub in-app channel + user-created Slack/email/webhook).
}


async function seed_settings(): Promise<void> {
    const { DaemonConfig } = await import('../models/index.js');
    const now = Date.now();

    const defaults: Array<[string, unknown]> = [
        ['hub.registry_url', 'https://cliqhub.io'],
        ['logging.level', 'info'],
        ['logging.format', 'text'],
        ['notifications.idle_threshold_minutes', 10],
        ['notifications.on_complete.enabled', true],
        ['notifications.on_error.enabled', true],
        ['docker.base_image', 'ghcr.io/sapshah/cliq-runtime:latest'],
    ];

    await DaemonConfig.bulkCreate(
        defaults.map(([key, value]) => ({ daemon_id: '__global__', key, value: JSON.stringify(value), updated_at: now })),
        { ignoreDuplicates: true },
    );
}

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { hub_legacy_uuid } from '../../../src/lib/hub_legacy_uuid.js';
import { BuilderService } from '../../../src/services/builder_service.js';

function make_llm_adapter() {
	return {
		complete: vi.fn().mockResolvedValue({ text: '{}', usage: { prompt_tokens: 10, completion_tokens: 20 } }),
	};
}

const AUTH = { user: { id: hub_legacy_uuid(1), username: 'alice', display_name: 'alice', role: 'user', email: 'alice@test.com' }, org_slugs: [], org_ids: [], scopes: [] };

const LONG_ROLE_CONTENT = 'You are a developer. Do the thing. Make sure to write comprehensive tests and documentation for all changes.';

function make_valid_team_json(overrides: Record<string, unknown> = {}) {
	return JSON.stringify({
		name: 'test-team',
		description: 'A test team',
		phases: [{ name: 'dev', type: 'standard', depends_on: [] }],
		roles: [{ name: 'dev', content: LONG_ROLE_CONTENT }],
		...overrides,
	});
}

function make_team(overrides: Record<string, unknown> = {}) {
	return {
		name: 'test-team',
		description: 'A test team',
		phases: [{ name: 'dev', type: 'standard' as const, depends_on: [] }],
		roles: [{ name: 'dev', content: LONG_ROLE_CONTENT }],
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// generate
// ---------------------------------------------------------------------------

describe('generate', () => {
	let adapter: ReturnType<typeof make_llm_adapter>;
	let service: BuilderService;

	beforeEach(() => {
		adapter = make_llm_adapter();
		service = new BuilderService(adapter as any);
	});

	it('returns generated team from LLM response', async () => {
		adapter.complete.mockResolvedValueOnce({ text: make_valid_team_json(), usage: { prompt_tokens: 10, completion_tokens: 20 } });

		const result = await service.generate(AUTH as any, { intent: 'Build a code review pipeline' });

		expect(result.team.name).toBe('test-team');
		expect(result.team.description).toBe('A test team');
		expect(result.team.phases).toHaveLength(1);
		expect(result.team.roles).toHaveLength(1);
		expect(result.usage).toEqual({ prompt_tokens: 10, completion_tokens: 20 });
	});

	it('returns error for empty intent', async () => {
		await expect(service.generate(AUTH as any, { intent: '' })).rejects.toThrow('intent is required');
	});

	it('returns error for missing intent', async () => {
		await expect(service.generate(AUTH as any, { intent: undefined as any })).rejects.toThrow('intent is required');
	});

	it('returns error when LLM throws', async () => {
		adapter.complete.mockRejectedValueOnce(new Error('LLM down'));

		await expect(service.generate(AUTH as any, { intent: 'something' })).rejects.toThrow('LLM down');
	});

	it('normalises team name to kebab-case', async () => {
		const json = make_valid_team_json({ name: 'My Team Name' });
		adapter.complete.mockResolvedValueOnce({ text: json, usage: { prompt_tokens: 10, completion_tokens: 20 } });

		const result = await service.generate(AUTH as any, { intent: 'build something' });

		expect(result.team.name).toBe('my-team-name');
	});

	it('parses sources and target_entries from LLM response', async () => {
		const json = JSON.stringify({
			name: 'data-pipeline',
			description: 'Fetches and publishes',
			phases: [
				{ name: 'fetch', type: 'standard', depends_on: [], sources: [{ url: 'https://example.com/data.csv', name: 'data' }] },
				{ name: 'process', type: 'standard', depends_on: ['fetch'] },
				{ name: 'publish', type: 'standard', depends_on: ['process'], target_entries: [{ file: 'out.md', name: 'report', mode: 'create' }] },
			],
			roles: [
				{ name: 'fetch', content: LONG_ROLE_CONTENT },
				{ name: 'process', content: LONG_ROLE_CONTENT },
				{ name: 'publish', content: LONG_ROLE_CONTENT },
			],
		});
		adapter.complete.mockResolvedValueOnce({ text: json, usage: { prompt_tokens: 10, completion_tokens: 20 } });

		const result = await service.generate(AUTH as any, { intent: 'data pipeline' });

		const fetch_phase = result.team.phases.find(p => p.name === 'fetch');
		expect(fetch_phase?.sources).toHaveLength(1);
		expect(fetch_phase?.sources![0].url).toBe('https://example.com/data.csv');

		const publish_phase = result.team.phases.find(p => p.name === 'publish');
		expect(publish_phase?.target_entries).toHaveLength(1);
		expect(publish_phase?.target_entries![0].file).toBe('out.md');
	});
});

// ---------------------------------------------------------------------------
// improve_role
// ---------------------------------------------------------------------------

describe('improve_role', () => {
	let adapter: ReturnType<typeof make_llm_adapter>;
	let service: BuilderService;

	beforeEach(() => {
		adapter = make_llm_adapter();
		service = new BuilderService(adapter as any);
	});

	it('returns improved role content', async () => {
		const response_json = JSON.stringify({
			name: 'dev',
			original_content: 'old content',
			improved_content: 'better content',
			changes_summary: 'made it better',
		});
		adapter.complete.mockResolvedValueOnce({ text: response_json, usage: { prompt_tokens: 10, completion_tokens: 20 } });

		const result = await service.improve_role(AUTH as any, {
			role_name: 'dev',
			role_content: 'old content',
			team_name: 'test-team',
			team_description: 'A test team',
			phases: ['dev'],
		});

		expect(result.improved_content).toBe('better content');
		expect(result.changes_summary).toBe('made it better');
	});

	it('returns error for missing role_name', async () => {
		await expect(
			service.improve_role(AUTH as any, {
				role_name: '',
				role_content: 'some content',
				team_name: 'test-team',
				team_description: 'desc',
				phases: [],
			}),
		).rejects.toThrow('role_name and role_content are required');
	});

	it('returns error for missing role_content', async () => {
		await expect(
			service.improve_role(AUTH as any, {
				role_name: 'dev',
				role_content: '',
				team_name: 'test-team',
				team_description: 'desc',
				phases: [],
			}),
		).rejects.toThrow('role_name and role_content are required');
	});

	it('returns error when LLM throws', async () => {
		adapter.complete.mockRejectedValueOnce(new Error('timeout'));

		await expect(
			service.improve_role(AUTH as any, {
				role_name: 'dev',
				role_content: 'content here',
				team_name: 'test-team',
				team_description: 'desc',
				phases: [],
			}),
		).rejects.toThrow('timeout');
	});
});

// ---------------------------------------------------------------------------
// suggest
// ---------------------------------------------------------------------------

describe('suggest', () => {
	let adapter: ReturnType<typeof make_llm_adapter>;
	let service: BuilderService;

	beforeEach(() => {
		adapter = make_llm_adapter();
		service = new BuilderService(adapter as any);
	});

	it('returns suggestions for team', async () => {
		const suggestions = [{ type: 'missing_gate', title: 'Add gate', description: 'You need a quality gate' }];
		adapter.complete.mockResolvedValueOnce({ text: JSON.stringify(suggestions), usage: { prompt_tokens: 10, completion_tokens: 20 } });

		const result = await service.suggest(AUTH as any, {
			team_name: 'test-team',
			description: 'A test team',
			phases: [{ name: 'dev', type: 'standard' as const, depends_on: [] }],
			roles: [{ name: 'dev', content: LONG_ROLE_CONTENT }],
		});

		expect(result.suggestions).toHaveLength(1);
		expect((result.suggestions as any[])[0].type).toBe('missing_gate');
	});

	it('returns error for missing team_name', async () => {
		await expect(
			service.suggest(AUTH as any, {
				team_name: '',
				description: '',
				phases: [],
				roles: [],
			}),
		).rejects.toThrow('team_name is required');
	});
});

// ---------------------------------------------------------------------------
// validate
// ---------------------------------------------------------------------------

describe('validate', () => {
	let service: BuilderService;

	beforeEach(() => {
		const adapter = make_llm_adapter();
		service = new BuilderService(adapter as any);
	});

	it('returns valid for well-formed team', () => {
		const team = make_team();
		const result = service.validate(AUTH as any, { team: team as any });

		expect(result.valid).toBe(true);
		expect(result.errors).toHaveLength(0);
	});

	it('returns errors for empty team (no phases)', () => {
		const team = make_team({ phases: [] });
		const result = service.validate(AUTH as any, { team: team as any });

		expect(result.valid).toBe(false);
		expect(result.errors).toContain('Team must have at least one phase');
	});

	it('detects duplicate phase names', () => {
		const team = make_team({
			phases: [
				{ name: 'dev', type: 'standard', depends_on: [] },
				{ name: 'dev', type: 'standard', depends_on: [] },
			],
		});
		const result = service.validate(AUTH as any, { team: team as any });

		expect(result.errors.some(e => e.includes('Duplicate phase name'))).toBe(true);
	});

	it('detects unknown dependency', () => {
		const team = make_team({
			phases: [{ name: 'dev', type: 'standard', depends_on: ['nonexistent'] }],
		});
		const result = service.validate(AUTH as any, { team: team as any });

		expect(result.errors.some(e => e.includes('unknown phase "nonexistent"'))).toBe(true);
	});

	it('detects source entry with empty name', () => {
		const team = make_team({
			phases: [
				{ name: 'fetch', type: 'standard', depends_on: [], sources: [{ url: 'https://example.com', name: '' }] },
			],
		});
		const result = service.validate(AUTH as any, { team: team as any });

		expect(result.errors.some(e => e.includes('empty name'))).toBe(true);
	});

	it('detects target entry with empty file', () => {
		const team = make_team({
			phases: [
				{ name: 'publish', type: 'standard', depends_on: [], target_entries: [{ file: '', name: 'report' }] },
			],
		});
		const result = service.validate(AUTH as any, { team: team as any });

		expect(result.errors.some(e => e.includes('empty file'))).toBe(true);
	});

	it('detects target entry with empty name', () => {
		const team = make_team({
			phases: [
				{ name: 'publish', type: 'standard', depends_on: [], target_entries: [{ file: 'out.md', name: '' }] },
			],
		});
		const result = service.validate(AUTH as any, { team: team as any });

		expect(result.errors.some(e => e.includes('empty name'))).toBe(true);
	});

	it('errors when exec phase has no commands', () => {
		const team = make_team({
			phases: [
				{ name: 'setup', type: 'standard', depends_on: [], agent: 'exec' },
			],
		});
		const result = service.validate(AUTH as any, { team: team as any });

		expect(result.errors.some(e => e.includes('Exec phase') && e.includes('at least one command'))).toBe(true);
	});

	it('warns when hug gate has no commands', () => {
		const team = make_team({
			phases: [
				{ name: 'dev', type: 'standard', depends_on: [] },
				{ name: 'review', type: 'gate', depends_on: ['dev'], agent: 'hug' },
			],
			roles: [
				{ name: 'dev', content: LONG_ROLE_CONTENT },
				{ name: 'review', content: LONG_ROLE_CONTENT },
			],
		});
		const result = service.validate(AUTH as any, { team: team as any });

		expect(result.warnings.some(w => w.includes('has no commands'))).toBe(true);
	});

	it('errors when hug gate has no reviewer', () => {
		const team = make_team({
			phases: [
				{ name: 'dev', type: 'standard', depends_on: [] },
				{ name: 'review', type: 'gate', depends_on: ['dev'], agent: 'hug' },
			],
			roles: [
				{ name: 'dev', content: LONG_ROLE_CONTENT },
				{ name: 'review', content: LONG_ROLE_CONTENT },
			],
		});
		const result = service.validate(AUTH as any, { team: team as any });

		expect(result.valid).toBe(false);
		expect(result.errors.some(e => e.includes('requires review.reviewer'))).toBe(true);
	});

	it('passes when hug gate has review.reviewer', () => {
		const team = make_team({
			phases: [
				{ name: 'dev', type: 'standard', depends_on: [] },
				{
					name: 'review',
					type: 'gate',
					depends_on: ['dev'],
					agent: 'hug',
					review: { reviewer: 'architects' },
				},
			],
			roles: [
				{ name: 'dev', content: LONG_ROLE_CONTENT },
				{ name: 'review', content: LONG_ROLE_CONTENT },
			],
		});
		const result = service.validate(AUTH as any, { team: team as any });

		expect(result.errors.some(e => e.includes('review.reviewer'))).toBe(false);
		expect(result.valid).toBe(true);
	});

	it('errors when team phase has no team field', () => {
		const team = make_team({
			phases: [
				{ name: 'sub', type: 'team', depends_on: [] },
			],
		});
		const result = service.validate(AUTH as any, { team: team as any });

		expect(result.errors.some(e => e.includes('Team phase') && e.includes('team field'))).toBe(true);
	});

	it('errors when gate phase (non-hug) has no commands', () => {
		const team = make_team({
			phases: [
				{ name: 'dev', type: 'standard', depends_on: [] },
				{ name: 'qa', type: 'gate', depends_on: ['dev'] },
			],
			roles: [
				{ name: 'dev', content: LONG_ROLE_CONTENT },
				{ name: 'qa', content: LONG_ROLE_CONTENT },
			],
		});
		const result = service.validate(AUTH as any, { team: team as any });

		expect(result.errors.some(e => e.includes('Gate phase') && e.includes('at least one command'))).toBe(true);
	});

	it('detects invalid phase type', () => {
		const team = make_team({
			phases: [{ name: 'dev', type: 'pull', depends_on: [] }],
		});
		const result = service.validate(AUTH as any, { team: team as any });

		expect(result.errors.some(e => e.includes('invalid type'))).toBe(true);
	});

	it('warns when declared input not referenced', () => {
		const team = make_team({
			inputs: [{ name: 'unused_param', description: 'never used' }],
			phases: [{ name: 'dev', type: 'standard', depends_on: [] }],
		});
		const result = service.validate(AUTH as any, { team: team as any });

		expect(result.warnings.some(w => w.includes('never referenced'))).toBe(true);
	});

	it('does not warn about missing role for connector agents', () => {
		const team = make_team({
			phases: [{ name: 'fetch', type: 'standard', depends_on: [], agent: 'jira', action: 'get_issue', sources: [{ name: 'ticket', url: 'https://jira.test/PROJ-1' }] }],
			roles: [],
		});
		const result = service.validate(AUTH as any, { team: team as any });

		expect(result.warnings.some(w => w.includes('No role file'))).toBe(false);
	});

	it('does not warn about missing role for exec agent', () => {
		const team = make_team({
			phases: [{ name: 'setup', type: 'standard', depends_on: [], agent: 'exec', commands: [{ name: 'init', run: 'npm install' }] }],
			roles: [],
		});
		const result = service.validate(AUTH as any, { team: team as any });

		expect(result.warnings.some(w => w.includes('No role file'))).toBe(false);
	});

	it('errors when connector phase is missing action', () => {
		const team = make_team({
			phases: [{ name: 'fetch', type: 'standard', depends_on: [], agent: 'jira', sources: [{ name: 'ticket', url: 'https://jira.test/PROJ-1' }] }],
			roles: [],
		});
		const result = service.validate(AUTH as any, { team: team as any });

		expect(result.errors.some(e => e.includes('must have an action'))).toBe(true);
	});

	it('warns when connector phase has no sources', () => {
		const team = make_team({
			phases: [{ name: 'fetch', type: 'standard', depends_on: [], agent: 'gdrive', action: 'download' }],
			roles: [],
		});
		const result = service.validate(AUTH as any, { team: team as any });

		expect(result.warnings.some(w => w.includes('no sources'))).toBe(true);
	});

	it('errors when curl phase has no sources or targets', () => {
		const team = make_team({
			phases: [{ name: 'fetch', type: 'standard', depends_on: [], agent: 'curl' }],
			roles: [],
		});
		const result = service.validate(AUTH as any, { team: team as any });

		expect(result.errors.some(e => e.includes('must have at least one source or target entry'))).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// chat
// ---------------------------------------------------------------------------

describe('chat', () => {
	let adapter: ReturnType<typeof make_llm_adapter>;
	let service: BuilderService;

	beforeEach(() => {
		adapter = make_llm_adapter();
		service = new BuilderService(adapter as any);
	});

	it('returns reply and actions on success', async () => {
		const response_json = JSON.stringify({
			reply: 'Added a gate phase.',
			actions: [{ type: 'ADD_PHASE', phase: { name: 'qa', type: 'gate', depends_on: ['dev'], commands: [{ name: 'test', run: 'npm test' }], max_iterations: 3 } }],
		});
		adapter.complete.mockResolvedValueOnce({ text: response_json, usage: { prompt_tokens: 10, completion_tokens: 20 } });

		const result = await service.chat(AUTH as any, {
			team: make_team() as any,
			message: 'Add a QA gate',
		});

		expect(result.reply).toBe('Added a gate phase.');
		expect(result.actions).toHaveLength(1);
		expect(result.actions[0].type).toBe('ADD_PHASE');
	});

	it('returns error for missing team', async () => {
		await expect(
			service.chat(AUTH as any, { team: undefined as any, message: 'hello' }),
		).rejects.toThrow('team is required');
	});

	it('returns error for empty message', async () => {
		await expect(
			service.chat(AUTH as any, { team: make_team() as any, message: '' }),
		).rejects.toThrow('message is required');
	});

	it('filters out invalid action types', async () => {
		const response_json = JSON.stringify({
			reply: 'Tried something.',
			actions: [
				{ type: 'ADD_PHASE', phase: { name: 'qa', type: 'gate', depends_on: [] } },
				{ type: 'INVALID_ACTION', data: {} },
				{ type: 'UPDATE_ROLE', name: 'dev', content: 'updated' },
			],
		});
		adapter.complete.mockResolvedValueOnce({ text: response_json, usage: { prompt_tokens: 10, completion_tokens: 20 } });

		const result = await service.chat(AUTH as any, {
			team: make_team() as any,
			message: 'Do stuff',
		});

		expect(result.actions).toHaveLength(2);
		expect(result.actions.every((a: any) => a.type !== 'INVALID_ACTION')).toBe(true);
	});
});

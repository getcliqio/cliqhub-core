/**
 * Team lint — every phase line is a phase field or an input its agent declares; required agent
 * inputs are there; team inputs use only the Run form's fields. Architect v0.1.28 (as published on
 * cliqhub.io) is the real-world fixture: four ignored phase lines and one ignored input field.
 */
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { describe, it, expect } from 'vitest';
import { lint_team, type AgentInputs } from '@getcliqio/cliq-sdk';

const AGENTS = new Map<string, AgentInputs>([
    ['jira', { action: { required: true }, sources: { required_unless: ['target_entries'] }, target_entries: { required_unless: ['sources'] }, notify: {} }],
    ['exec', { commands: { required: true } }],
    ['git', { action: { required: true, default: 'create_pr' }, project_dir: {}, base_branch: {}, notify: {} }],
    ['claude-code', { role: { required: true }, model: {}, temperature: {}, max_turns: {}, needs_filesystem: {}, task: { required: true, source: 'runtime' } }],
    ['hug', { role: { required: true }, review: { required: true } }],
]);
const lint = (team: Record<string, unknown>) => lint_team(team, AGENTS);
const lines = (team: Record<string, unknown>) => lint(team).map((p) => `${p.phase ?? '-'}:${p.line}`);

describe('lint_team', () => {
    it('architect v0.1.28: team_inputs (use args), when, two phase-level escalate_on_fail, and optional on an input', () => {
        const file = path.resolve(import.meta.dirname, '../../fixtures/teams/architect-0.1.28.team.yml');
        const team = yaml.load(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
        const problems = lint(team);
        expect(problems.map((p) => `${p.phase ?? '-'}:${p.line}`)).toEqual([
            'fetch:escalate_on_fail',
            'ensure-clones:team_inputs',
            'create-stories:escalate_on_fail',
            'create-stories:when',
            '-:optional',
        ]);
        expect(problems[1].message).toBe('phase `ensure-clones`: `team_inputs` isn\'t accepted by a team phase — use `args`');
        expect(problems[3].message).toBe('phase `create-stories`: `when` isn\'t accepted by agent `exec`');
        expect(problems[4].message).toMatch(/^input `create_stories`: `optional` isn't an input field/);
    });

    it('a clean team has no problems: agent inputs, phase fields, args on a team phase, a gate route, a map phase', () => {
        expect(lint({
            inputs: [{ name: 'ticket', label: 'Ticket', type: 'text', required: true, help: 'Jira key', placeholder: 'M1-1' }, { name: 'mode', type: 'select', choices: ['a', 'b'], default: 'a' }],
            phases: [
                { name: 'fetch', agent: 'jira', action: 'get_issue', sources: [{ name: 't', ref: 'x' }], timeout: 60 },
                { name: 'draft', agent: 'claude-code', role: 'Write it', model: 'sonnet', depends_on: ['fetch'] },
                { name: 'review', type: 'gate', agent: 'hug', role: 'Check it', review: { reviewers: ['@a'] }, route_targets: ['draft'], max_iterations: 3 },
                { name: 'sync', type: 'team', team: '@acme/git-sync', args: { mode: 'ensure' } },
                { name: 'each', type: 'map', team: '@acme/one', over: '{{x}}', key: '{{id}}', concurrency: 2 },
                { name: 'run', commands: [{ run: 'make' }] },
                { name: 'pr', agent: 'git' },
            ],
        })).toEqual([]);
    });

    it('a required agent input missing; one of a pair missing; a default or a runtime input counts as given', () => {
        expect(lines({ phases: [
            { name: 'a', agent: 'exec' },
            { name: 'b', agent: 'jira', action: 'get_issue' },
            { name: 'c', agent: 'jira', action: 'add_comment', target_entries: [{ name: 'x' }] },
            { name: 'd', agent: 'claude-code' },
            { name: 'e', agent: 'git' },
        ] })).toEqual(['a:commands', 'b:sources', 'd:role']);
        expect(lint({ phases: [{ name: 'b', agent: 'jira', action: 'get_issue' }] })[0].message).toBe('phase `b`: agent `jira` needs one of `sources` or `target_entries`');
    });

    it('team and map phases take phase fields only; a team phase needs `team`; a phase without an agent takes phase fields only', () => {
        expect(lines({ phases: [
            { name: 't', type: 'team', team: '@a/b', role: 'x' },
            { name: 'u', type: 'team', args: {} },
            { name: 'm', type: 'map', team: '@a/b', over: '[]', model: 'x' },
            { name: 's', commands: [{ run: 'x' }], role: 'nope' },
        ] })).toEqual(['t:role', 'u:team', 'm:model', 's:role']);
    });

    it('an agent the team defines itself, or one the hub doesn\'t know, isn\'t line-checked here', () => {
        expect(lint({ agents: { mine: { entry: './x.js' } }, phases: [{ name: 'a', agent: 'mine', anything: 1 }, { name: 'b', agent: 'unheard-of', whatever: 2 }] })).toEqual([]);
    });

    it('support phases are checked like phases', () => {
        expect(lines({ phases: [{ name: 'a', commands: [{ run: 'x' }] }], support: [{ name: 'fix', agent: 'claude-code', role: 'x', when: 'y' }] })).toEqual(['fix:when']);
    });
});

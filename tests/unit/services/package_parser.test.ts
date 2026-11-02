import { describe, it, expect } from 'vitest';
import {
    normalize_tags,
    compute_next_version,
    workflow_from_team_yml,
    enrich_required_inputs,
    dependencies_problems,
} from '../../../src/services/package_parser.js';

describe('normalize_tags', () => {
    it('normalizes, dedupes empties, and caps length/count', () => {
        expect(normalize_tags(['  Hello_World  ', 'AI!!', '', 'x'.repeat(60), 1 as unknown as string]))
            .toEqual(['hello-world', 'ai']);
    });
});

describe('compute_next_version', () => {
    it('starts at 1.0.0 when current is missing or invalid', () => {
        expect(compute_next_version(null, 'patch')).toBe('1.0.0');
        expect(compute_next_version('not-semver', 'minor')).toBe('1.0.0');
    });

    it('bumps major minor and patch', () => {
        expect(compute_next_version('1.2.3', 'major')).toBe('2.0.0');
        expect(compute_next_version('1.2.3', 'minor')).toBe('1.3.0');
        expect(compute_next_version('1.2.3', 'patch')).toBe('1.2.4');
    });
});

describe('workflow_from_team_yml', () => {
    it('reads top-level phases and support', () => {
        expect(workflow_from_team_yml({
            phases: [{ name: 'a' }],
            support: [{ name: 's' }],
        })).toEqual({
            phases: [{ name: 'a' }],
            support: [{ name: 's' }],
        });
    });

    it('ignores nested workflow — phases is the workflow', () => {
        expect(workflow_from_team_yml({
            workflow: { phases: [{ name: 'legacy' }] },
        } as Record<string, unknown>)).toEqual({ phases: [] });
    });

    it('returns empty phases for null/empty', () => {
        expect(workflow_from_team_yml(null)).toEqual({ phases: [] });
        expect(workflow_from_team_yml({})).toEqual({ phases: [] });
    });
});

describe('enrich_required_inputs', () => {
    it('does not override declared required: false when referenced in commands', () => {
        const result = enrich_required_inputs(
            [{ name: 'note', type: 'text', required: false }],
            {
                phases: [{
                    name: 'echo',
                    commands: [{ run: 'echo {{inputs.note}}' }],
                }],
            } as never,
        );
        expect(result).toEqual([
            expect.objectContaining({ name: 'note', required: false }),
        ]);
    });

    it('preserves declared required: true', () => {
        const result = enrich_required_inputs(
            [{ name: 'name', type: 'text', required: true }],
            {
                phases: [{
                    name: 'greet',
                    commands: [{ run: 'echo {{inputs.name}}' }],
                }],
            } as never,
        );
        expect(result).toEqual([
            expect.objectContaining({ name: 'name', required: true }),
        ]);
    });

    it('invents undeclared template refs as required', () => {
        const result = enrich_required_inputs(
            undefined,
            {
                phases: [{
                    name: 'go',
                    commands: [{ run: 'echo {{inputs.orphan}}' }],
                }],
            } as never,
        );
        expect(result).toEqual([
            { name: 'orphan', type: 'text', required: true },
        ]);
    });
});

describe('dependencies.yml', () => {
    const DEPS = '- name: jq\n  version: "1.7"\n  install: apt-get install -y jq\n';

    it('problems: each dependency has a name and an install command (version optional)', () => {
        expect(dependencies_problems('')).toEqual([]);
        expect(dependencies_problems(DEPS)).toEqual([]);
        expect(dependencies_problems('name: jq')).toEqual(['dependencies.yml must be a list of dependencies']);
        expect(dependencies_problems('- name: jq\n- install: x\n- name: jq\n  install: y\n')).toEqual([
            'dependency `jq` has no `install` command',
            'dependency 2 has no `name`',
            'dependency `jq` is listed twice',
        ]);
        expect(dependencies_problems('- name: jq\n  install: y\n')).toEqual([]);
        expect(dependencies_problems('- [')[0]).toMatch(/isn't valid YAML/);
    });
});

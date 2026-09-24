import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import {
    extract_package,
    normalize_tags,
    compute_next_version,
    workflow_from_team_yml,
    enrich_required_inputs,
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

describe('extract_package', () => {
    it('rejects oversized packages', async () => {
        const huge = Buffer.alloc(10 * 1024 * 1024 + 1);
        await expect(extract_package(huge)).rejects.toThrow('Package too large');
    });

    it('parses json packages with team.yml roles and readme', async () => {
        const pkg = {
            'team.yml': 'name: demo\ndescription: hi\n',
            roles: [
                { name: 'dev', content: '# Dev' },
                { name: 'skip' },
            ],
            readme: '# Hello',
        };
        const result = await extract_package(Buffer.from(JSON.stringify(pkg)));
        expect(result.team_yml?.name).toBe('demo');
        expect(result.roles).toEqual([{ name: 'dev', content_md: '# Dev' }]);
        expect(result.readme).toBe('# Hello');
    });

    it('parses zip packages with nested root and roles', async () => {
        const zip = new JSZip();
        zip.file('pkg/team.yml', 'name: zipped\n');
        zip.file('pkg/roles/coder.md', '# Coder');
        zip.file('pkg/roles/nested/skip.md', '# Skip');
        zip.file('pkg/README.md', '# Readme');
        const buf = await zip.generateAsync({ type: 'nodebuffer' });

        const result = await extract_package(buf);
        expect(result.team_yml?.name).toBe('zipped');
        expect(result.roles).toEqual([{ name: 'coder', content_md: '# Coder' }]);
        expect(result.readme).toBe('# Readme');
    });
});

import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import {
    extract_package,
    normalize_tags,
    compute_next_version,
    workflow_from_team_yml,
    enrich_required_inputs,
    to_package_zip,
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

describe('to_package_zip (what is stored: daemons install with unzip)', () => {
    it('a JSON package (the builder\'s) is stored as a zip with team.yml, roles and README', async () => {
        const json = Buffer.from(JSON.stringify({ 'team.yml': 'name: x\nphases: []\n', roles: [{ name: 'dev', content: '# Dev' }], readme: '# Read' }));
        const content = await extract_package(json);
        const out = await to_package_zip(json, content);
        expect([out[0], out[1]]).toEqual([0x50, 0x4B]);
        const zip = await JSZip.loadAsync(out);
        expect(await zip.file('team.yml')!.async('string')).toBe('name: x\nphases: []\n');
        expect(await zip.file('roles/dev.md')!.async('string')).toBe('# Dev');
        expect(await zip.file('README.md')!.async('string')).toBe('# Read');
        // And it reads back the same.
        expect(await extract_package(out)).toMatchObject({ manifest_yaml: content.manifest_yaml, roles: content.roles, readme: content.readme });
    });

    it('a zip is stored as sent', async () => {
        const zip = new JSZip();
        zip.file('team.yml', 'name: y\n');
        const buf = await zip.generateAsync({ type: 'nodebuffer' });
        expect(await to_package_zip(buf, await extract_package(buf))).toBe(buf);
    });
});

describe('dependencies.yml in a package', () => {
    const DEPS = '- name: jq\n  version: "1.7"\n  install: apt-get install -y jq\n';

    it('is read from a JSON package and from a zip, and packed into the stored zip', async () => {
        const json = Buffer.from(JSON.stringify({ 'team.yml': 'name: x\nphases: []\n', roles: [], 'dependencies.yml': DEPS }));
        const from_json = await extract_package(json);
        expect(from_json.dependencies_yml).toBe(DEPS);
        const stored = await to_package_zip(json, from_json);
        expect(await (await JSZip.loadAsync(stored)).file('dependencies.yml')!.async('string')).toBe(DEPS);
        expect((await extract_package(stored)).dependencies_yml).toBe(DEPS);
    });

    it('a package without one has none', async () => {
        const json = Buffer.from(JSON.stringify({ 'team.yml': 'name: x\n' }));
        const c = await extract_package(json);
        expect(c.dependencies_yml).toBe('');
        expect((await JSZip.loadAsync(await to_package_zip(json, c))).file('dependencies.yml')).toBeNull();
    });

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

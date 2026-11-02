/**
 * The check before the content columns go (PLAN-team-bundle S1.5): a version's columns hold nothing its files
 * don't. Empty columns hold nothing; derived columns aren't compared; any real difference stops the drop.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/services/version_content.js', () => ({ version_content: vi.fn() }));

import { column_differences, type VersionColumns } from '../../../src/models/migrations/team_files_only.js';
import { derive_version_content } from '../../../src/services/package_parser.js';

const TEAM_YML = 'name: "@acme/leaf"\nagents:\n  mine:\n    entry: node mine.js\nphases:\n  - name: say\n    agent: mine\n';
const FILES = { 'team.yml': TEAM_YML, 'README.md': '# leaf', 'dependencies.yml': '- name: jq\n', 'roles/say.md': 'Say it.' };
const content = (files: Record<string, string> = FILES) => ({ version_id: 'v1', ...derive_version_content(files) });
const columns = (over: Partial<VersionColumns> = {}): VersionColumns => ({
    id: 'v1', team_id: 't1', version: '1.0.0',
    manifest_yaml: TEAM_YML, readme: '# leaf', dependencies_yaml: '- name: jq\n',
    roles_json: JSON.stringify([{ name: 'say', content_md: 'Say it.' }]),
    agents_json: JSON.stringify({ mine: { entry: 'node mine.js' } }),
    ...over,
});

describe('column_differences', () => {
    it('nothing when the columns hold what the files hold', () => {
        expect(column_differences(columns(), content())).toEqual([]);
    });

    it('a version without files stops the drop', () => {
        expect(column_differences(columns(), null)).toEqual(['no files']);
    });

    it('empty columns hold nothing (versions rebuilt from their phases, built-ins without roles)', () => {
        expect(column_differences(columns({ manifest_yaml: '', readme: null, dependencies_yaml: '', roles_json: '[]', agents_json: '{}' }), content())).toEqual([]);
    });

    it('each content column is compared: team.yml, README, dependencies, roles', () => {
        expect(column_differences(columns({ manifest_yaml: 'name: other\n' }), content())).toEqual(['team.yml differs from manifest_yaml']);
        expect(column_differences(columns({ readme: '# other' }), content())).toEqual(['README.md differs from readme']);
        expect(column_differences(columns({ dependencies_yaml: '- name: yq\n' }), content())).toEqual(['dependencies.yml differs from dependencies_yaml']);
        expect(column_differences(columns({ roles_json: JSON.stringify([{ name: 'say', content_md: 'Other.' }]) }), content())).toEqual(['roles/say.md differs']);
        expect(column_differences(columns({ roles_json: JSON.stringify([{ name: 'gone.md', content_md: 'Only here.' }]) }), content())).toEqual(['roles/gone.md missing']);
    });

    it("an agent defined only in agents_json (an old publish's override) stops the drop; agents named with no definition don't", () => {
        expect(column_differences(columns({ agents_json: JSON.stringify({ mine: { entry: 'node other.js' } }) }), content())).toEqual(['agent mine defined differently']);
        expect(column_differences(columns({ agents_json: JSON.stringify({ extra: { env: ['X'] } }) }), content())).toEqual(['agent extra defined differently']);
        expect(column_differences(columns({ agents_json: JSON.stringify({ exec: {}, hug: {} }) }), content())).toEqual([]);
    });
});

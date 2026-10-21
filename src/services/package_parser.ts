import yaml from 'js-yaml';
import JSZip from 'jszip';

import type { InputFieldSpec } from '../lib/input_field_spec.js';
import { InputFieldSpecUtil } from '../lib/input_field_spec.js';

export interface ParsedTeamYml {
    name: string;
    description?: string;
    domain?: string;
    tags?: string[];
    /** Full input field specs — type, label, help, choices, etc. */
    inputs?: InputFieldSpec[];
    use_when?: string[];
    not_for?: string[];
    agents?: Record<string, unknown>;
    /** Current team.yml shape (top-level phases). */
    phases?: unknown[];
    support?: unknown[];
    cliq_version?: string;
    tools?: string[];
}

/** Canonical workflow blob stored in team_versions.workflow_json. */
export interface NormalizedWorkflow {
    phases: unknown[];
    support?: unknown[];
}

/**
 * Build workflow_json from team.yml.
 * The workflow is the top-level `phases` array (ordered). Optional `support` phases
 * are stored alongside. Nested `workflow:` is not used.
 */
export function workflow_from_team_yml(
    team_yml: ParsedTeamYml | Record<string, unknown> | null | undefined,
): NormalizedWorkflow {
    if (!team_yml || typeof team_yml !== 'object') {
        return { phases: [] };
    }

    const phases = Array.isArray(team_yml.phases) ? team_yml.phases : [];
    const support = Array.isArray(team_yml.support) ? team_yml.support : undefined;
    if (support?.length) return { phases, support };
    return { phases };
}

export interface PackageContent {
    team_yml: ParsedTeamYml | null;
    /** Raw team.yml text — preserved verbatim for display. */
    manifest_yaml: string;
    roles: { name: string; content_md: string }[];
    readme: string;
    /** dependencies.yml text: tools the team needs and how to install them ('' when none). */
    dependencies_yml: string;
}

const MAX_PACKAGE_SIZE = 10 * 1024 * 1024;
const MAX_EXTRACTED = 50 * 1024 * 1024;

export async function extract_package(data_buffer: Buffer): Promise<PackageContent> {
    if (data_buffer.length > MAX_PACKAGE_SIZE) {
        throw new Error('Package too large (max 10MB)');
    }

    if (data_buffer[0] === 0x50 && data_buffer[1] === 0x4B) {
        return extract_zip_package(data_buffer);
    }
    return extract_json_package(data_buffer);
}

function extract_json_package(data_buffer: Buffer): PackageContent {
    const text = data_buffer.toString('utf8');
    const pkg = JSON.parse(text) as Record<string, unknown>;

    let team_yml: ParsedTeamYml | null = null;
    const manifest_yaml = typeof pkg['team.yml'] === 'string' ? pkg['team.yml'] : '';
    if (manifest_yaml) {
        team_yml = yaml.load(manifest_yaml) as ParsedTeamYml;
    }

    const roles: { name: string; content_md: string }[] = [];
    if (Array.isArray(pkg.roles)) {
        for (const r of pkg.roles) {
            const role = r as { name?: string; content?: string };
            if (role.name && role.content) {
                roles.push({ name: role.name, content_md: role.content });
            }
        }
    }

    const readme = typeof pkg.readme === 'string' ? pkg.readme : '';
    const dependencies_yml = typeof pkg['dependencies.yml'] === 'string' ? pkg['dependencies.yml'] : '';
    return { team_yml, manifest_yaml, roles, readme, dependencies_yml };
}

/**
 * The package as stored: always a zip (`team.yml`, `roles/<name>.md`, `README.md`, `dependencies.yml`) — daemons install with
 * `unzip`. A zip is kept as sent; a JSON package (the builder's) is rebuilt as a zip from its content.
 */
export async function to_package_zip(data_buffer: Buffer, content: Pick<PackageContent, 'manifest_yaml' | 'roles' | 'readme'> & { dependencies_yml?: string }): Promise<Buffer> {
    if (data_buffer[0] === 0x50 && data_buffer[1] === 0x4B) return data_buffer;
    const zip = new JSZip();
    zip.file('team.yml', content.manifest_yaml ?? '');
    for (const role of content.roles) zip.file(`roles/${role.name}.md`, role.content_md);
    if (content.readme) zip.file('README.md', content.readme);
    if (content.dependencies_yml) zip.file('dependencies.yml', content.dependencies_yml);
    return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/**
 * Problems with a dependencies.yml — the same rules cliq-docker applies when it builds a realm image:
 * a list of entries, each with a `name` and an `install` command (`version` optional).
 */
export function dependencies_problems(text: string): string[] {
    if (!text.trim()) return [];
    let raw: unknown;
    try {
        raw = yaml.load(text);
    } catch (err) {
        return [`dependencies.yml isn't valid YAML: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`];
    }
    if (raw === null || raw === undefined) return [];
    if (!Array.isArray(raw)) return ['dependencies.yml must be a list of dependencies'];
    const out: string[] = [];
    const seen = new Set<string>();
    raw.forEach((item, i) => {
        const rec = item && typeof item === 'object' && !Array.isArray(item) ? item as Record<string, unknown> : null;
        const name = typeof rec?.name === 'string' ? rec.name.trim() : '';
        if (!name) { out.push(`dependency ${i + 1} has no \`name\``); return; }
        if (typeof rec?.install !== 'string' || !rec.install.trim()) out.push(`dependency \`${name}\` has no \`install\` command`);
        if (rec?.version !== undefined && typeof rec.version !== 'string' && typeof rec.version !== 'number') out.push(`dependency \`${name}\`: \`version\` must be text`);
        if (seen.has(name)) out.push(`dependency \`${name}\` is listed twice`);
        seen.add(name);
    });
    return out;
}

async function extract_zip_package(zip_buffer: Buffer): Promise<PackageContent> {
    const zip = await JSZip.loadAsync(zip_buffer);

    const all_paths = Object.keys(zip.files);
    const top_dirs = new Set(all_paths.map(p => p.split('/')[0]));
    let prefix = '';
    if (top_dirs.size === 1) {
        const candidate = [...top_dirs][0] + '/';
        const has_nested = all_paths.some(p => p.startsWith(candidate) && p !== candidate);
        if (has_nested) prefix = candidate;
    }

    let bytes_read = 0;

    async function read_text(rel_path: string): Promise<string | null> {
        const entry = zip.file(prefix + rel_path);
        if (!entry) return null;
        const content = await entry.async('string');
        bytes_read += Buffer.byteLength(content, 'utf8');
        if (bytes_read > MAX_EXTRACTED) throw new Error('Package extracts to more than 50MB');
        return content;
    }

    let team_yml: ParsedTeamYml | null = null;
    const yml_text = await read_text('team.yml');
    const manifest_yaml = yml_text ?? '';
    if (yml_text) {
        team_yml = yaml.load(yml_text) as ParsedTeamYml;
    }

    const roles: { name: string; content_md: string }[] = [];
    const roles_prefix = prefix + 'roles/';
    const role_entries = Object.keys(zip.files)
        .filter(p => p.startsWith(roles_prefix) && p.endsWith('.md') && !zip.files[p].dir)
        .sort();

    for (const role_path of role_entries) {
        const filename = role_path.slice(roles_prefix.length);
        if (filename.includes('/')) continue;
        const content = await zip.file(role_path)!.async('string');
        bytes_read += Buffer.byteLength(content, 'utf8');
        if (bytes_read > MAX_EXTRACTED) throw new Error('Package extracts to more than 50MB');
        roles.push({ name: filename.replace(/\.md$/, ''), content_md: content });
    }

    const readme = await read_text('README.md') ?? '';
    const dependencies_yml = await read_text('dependencies.yml') ?? '';
    return { team_yml, manifest_yaml, roles, readme, dependencies_yml };
}

/**
 * Merge undeclared `{{inputs.X}}` template references into the inputs
 * array so Hub UI can show fields for them.
 *
 * Does **not** override an author's `required` flag. A declared
 * `required: false` stays optional even when a phase command references
 * the input (daemon `scan_missing_inputs` honors the same rule via
 * `_team_allows_missing`). Only invents missing declarations for
 * undeclared refs, defaulting those to `required: true`.
 */
export function enrich_required_inputs(
    declared_inputs: InputFieldSpec[] | undefined,
    workflow: NormalizedWorkflow,
): InputFieldSpec[] {
    /** Collect all input names referenced in command templates. */
    const referenced = new Set<string>();
    const all_phases = [
        ...(workflow.phases ?? []),
        ...(workflow.support ?? []),
    ] as Array<{ commands?: Array<{ run?: string }> }>;

    for (const phase of all_phases) {
        if (!Array.isArray(phase?.commands)) continue;
        for (const cmd of phase.commands) {
            if (typeof cmd?.run !== 'string') continue;
            const matches = cmd.run.matchAll(/\{\{inputs\.([^}]+)\}\}/g);
            for (const m of matches) {
                referenced.add(m[1].trim());
            }
        }
    }

    /** Coerce declared inputs through the canonical spec validator. */
    const coerced = InputFieldSpecUtil.coerce(declared_inputs);

    if (referenced.size === 0 && coerced.length === 0) {
        return coerced;
    }

    /** Index declared inputs by name for fast lookup. */
    const by_name = new Map(
        coerced.map((inp) => [inp.name, { ...inp }]),
    );

    /** Invent undeclared refs only — never flip a declared required flag. */
    for (const name of referenced) {
        if (by_name.has(name)) continue;
        by_name.set(name, { name, type: 'text', required: true });
    }

    return [...by_name.values()];
}

export function normalize_tags(tags: string[]): string[] {
    return tags
        .map(t => typeof t === 'string'
            ? t.trim().toLowerCase().replace(/[\s_]+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '')
            : '')
        .filter(t => t.length > 0 && t.length <= 50)
        .slice(0, 20);
}

export function compute_next_version(current: string | null, bump: 'patch' | 'minor' | 'major'): string {
    if (!current) return '1.0.0';
    const match = current.match(/^(\d+)\.(\d+)\.(\d+)/);
    if (!match) return '1.0.0';
    const [, maj, min, pat] = match.map(Number);
    if (bump === 'major') return `${maj + 1}.0.0`;
    if (bump === 'minor') return `${maj}.${min + 1}.0`;
    return `${maj}.${min}.${pat + 1}`;
}

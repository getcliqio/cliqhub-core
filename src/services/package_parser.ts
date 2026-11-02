import { TEAM_YML } from '@getcliqio/cliq-sdk';
import yaml from 'js-yaml';

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

/** team.yml text as an object (YAML, or JSON), or null when it doesn't parse to one. */
export function parse_team_yml_text(text: string): ParsedTeamYml | null {
    try {
        const parsed = yaml.load(text);
        if (parsed && typeof parsed === 'object') return parsed as ParsedTeamYml;
    } catch { /* not YAML */ }
    try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === 'object') return parsed as ParsedTeamYml;
    } catch { /* not JSON */ }
    return null;
}

/** What a version's files say (PLAN-team-bundle S1.4b): everything CliqHub shows or checks about it. */
export interface VersionContentFields {
    /** team.yml text ('' when missing). */
    manifest_yaml: string;
    team_yml: ParsedTeamYml | null;
    /** roles/<name>.md, by name. */
    roles: Array<{ name: string; content_md: string }>;
    readme: string;
    /** dependencies.yml text ('' when none). */
    dependencies_yml: string;
    workflow: NormalizedWorkflow;
    /** Declared inputs plus any a command uses without declaring (required). */
    inputs: InputFieldSpec[];
    use_when?: string[];
    not_for?: string[];
    agents: Record<string, unknown>;
    tools: string[];
    cliq_version: string | null;
}

/**
 * Derive a version's content from its files: the one derivation publish and every read use, so what is shown
 * is what the files say. Lenient: a team.yml that doesn't parse gives no phases (publish checks files first).
 *
 * @param files - The version's files by path.
 */
export function derive_version_content(files: Record<string, string>): VersionContentFields {
    const manifest_yaml = files[TEAM_YML] ?? '';
    const team_yml = manifest_yaml ? parse_team_yml_text(manifest_yaml) : null;
    // Role briefs are the .md files directly in roles/ (a nested folder is not a role).
    const roles = Object.keys(files)
        .filter((p) => p.startsWith('roles/') && p.endsWith('.md') && !p.slice('roles/'.length).includes('/'))
        .sort()
        .map((p) => ({ name: p.slice('roles/'.length, -'.md'.length), content_md: files[p] }));
    const workflow = workflow_from_team_yml(team_yml);
    const agents = team_yml?.agents && typeof team_yml.agents === 'object' && !Array.isArray(team_yml.agents) ? team_yml.agents : {};
    return {
        manifest_yaml, team_yml, roles,
        readme: files['README.md'] ?? '',
        dependencies_yml: files['dependencies.yml'] ?? '',
        workflow,
        inputs: enrich_required_inputs(team_yml?.inputs, workflow),
        ...(Array.isArray(team_yml?.use_when) ? { use_when: team_yml.use_when } : {}),
        ...(Array.isArray(team_yml?.not_for) ? { not_for: team_yml.not_for } : {}),
        agents,
        tools: Array.isArray(team_yml?.tools) ? team_yml.tools : [],
        cliq_version: team_yml?.cliq_version || null,
    };
}

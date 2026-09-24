import { Realm } from '../models/index.js';
import { Team as HubTeam, TeamVersion } from '../db/models/index.js';
import { ApiError } from '../lib/api_error.js';
import { RealmA2aService } from './realm_a2a.service.js';
import type { TeamListEntry } from '../models/realm.model.js';

export interface A2a_skill {
    id: string;
    name: string;
    description: string;
    tags: string[];
    examples?: string[];
    inputModes: string[];
    outputModes: string[];
    /** Cliq extension: Hub team id `scope/slug` and declared inputs. */
    metadata: {
        team_id: string;
        inputs: unknown;
        use_when?: string[];
        not_for?: string[];
    };
}

export interface A2a_agent_card {
    name: string;
    description: string;
    url: string;
    version: string;
    protocolVersion: string;
    provider: { organization: string; url: string };
    capabilities: {
        streaming: boolean;
        pushNotifications: boolean;
        stateTransitionHistory: boolean;
    };
    defaultInputModes: string[];
    defaultOutputModes: string[];
    skills: A2a_skill[];
    securitySchemes: Record<string, { type: string; scheme: string }>;
    security: Array<Record<string, string[]>>;
}

function public_api_base(): string {
    const from_env =
        process.env.CLIQHUB_PUBLIC_API_URL
        || process.env.CLIQHUB_PUBLIC_URL
        || 'https://api.cliqhub.io';
    return from_env.replace(/\/$/, '');
}

function skill_id_for_team(scope: string, slug: string): string {
    return `${scope}/${slug}`;
}

function parse_capability(raw: string | null | undefined): {
    inputs: unknown;
    use_when?: string[];
    not_for?: string[];
} {
    if (!raw) return { inputs: [] };
    try {
        const parsed = JSON.parse(raw) as {
            inputs?: unknown;
            use_when?: string[];
            not_for?: string[];
        };
        return {
            inputs: parsed.inputs ?? [],
            use_when: parsed.use_when,
            not_for: parsed.not_for,
        };
    } catch {
        return { inputs: [] };
    }
}

async function skill_from_team_entry(entry: TeamListEntry): Promise<A2a_skill | null> {
    const hub_team = await HubTeam.findOne({
        where: { scope: entry.scope, name: entry.slug },
    });
    if (!hub_team) return null;

    const latest = await TeamVersion.findOne({
        where: { team_id: hub_team.id },
        order: [['published_at', 'DESC']],
    });
    if (!latest) return null;

    const capability = parse_capability(latest.capability_json);
    const team_id = skill_id_for_team(entry.scope, entry.slug);
    const description =
        hub_team.description?.trim()
        || `Run Cliq team ${team_id}`;

    return {
        id: team_id,
        name: hub_team.name || entry.slug,
        description,
        tags: ['cliq-team', entry.scope],
        inputModes: ['application/json', 'text/plain'],
        outputModes: ['application/json', 'text/plain'],
        metadata: {
            team_id,
            inputs: capability.inputs,
            use_when: capability.use_when,
            not_for: capability.not_for,
        },
    };
}

export class AgentCardService {
    /**
     * Build a public A2A agent card for a realm slug.
     * Throws not_found when realm missing/deleted or A2A disabled.
     */
    /**
     * Build an agent card for a realm identified by slug.
     * Accepts optional org_id for org-scoped resolution.
     */
    static async build_for_slug(slug: string, opts?: { org_id?: string }): Promise<A2a_agent_card> {
        const where: Record<string, unknown> = { slug };
        if (opts?.org_id) where.org_id = opts.org_id;
        const realm = await Realm.findOne({ where });
        if (!realm || realm.deleted) {
            throw ApiError.not_found(`Realm '${slug}' not found`);
        }

        const enabled = await RealmA2aService.is_enabled(realm.id);
        if (!enabled) {
            throw ApiError.not_found(`A2A is not enabled for realm '${slug}'`);
        }

        return AgentCardService.build_for_realm(realm);
    }

    /** Build card assuming realm exists and caller already checked a2a_enabled. */
    static async build_for_realm(realm: {
        id: string;
        slug: string;
        name: string;
        org_id?: string;
        team_list: TeamListEntry[];
    }): Promise<A2a_agent_card> {
        const team_list = realm.team_list ?? [];
        const skills: A2a_skill[] = [];

        for (const entry of team_list) {
            const skill = await skill_from_team_entry(entry);
            if (!skill) continue;
            skills.push(skill);
        }

        skills.push({
            id: 'notify_member',
            name: 'notify_member',
            description: 'Notify a realm user member via CliqHub notifications',
            tags: ['cliq-builtin', 'notify'],
            inputModes: ['application/json'],
            outputModes: ['application/json'],
            metadata: {
                team_id: 'notify_member',
                inputs: [
                    { name: 'member_id', type: 'string', required: true, description: 'Realm user member id' },
                    { name: 'message', type: 'string', required: true },
                    { name: 'title', type: 'string', required: false },
                ],
            },
        });

        // Resolve org slug for the new /a2a/o/:org/r/:slug URL scheme.
        let org_slug = '';
        if (realm.org_id) {
            try {
                const { Org } = await import('../db/models/index.js');
                const org = await Org.findByPk(realm.org_id, { attributes: ['slug'] });
                org_slug = org?.slug ?? '';
            } catch { /* best-effort */ }
        }

        const base = public_api_base();
        const url = org_slug
            ? `${base}/a2a/o/${org_slug}/r/${realm.slug}`
            : `${base}/a2a/r/${realm.slug}`;

        return {
            name: realm.name,
            description: `CliqHub realm agent for ${org_slug ? `${org_slug}.` : ''}${realm.slug}`,
            url,
            version: '1.0.0',
            protocolVersion: '0.3.0',
            provider: {
                organization: 'CliqHub',
                url: base,
            },
            capabilities: {
                streaming: true,
                pushNotifications: false,
                stateTransitionHistory: false,
            },
            defaultInputModes: ['application/json', 'text/plain'],
            defaultOutputModes: ['application/json', 'text/plain'],
            skills,
            securitySchemes: {
                bearer: { type: 'http', scheme: 'bearer' },
            },
            security: [{ bearer: [] }],
        };
    }
}

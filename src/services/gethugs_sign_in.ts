/**
 * Federated sign-in to getHugs (PLAN-gethugs-step7-sign-in.md): a link that signs a cliqhub person in to getHugs and
 * lands them on a Hug's page or their inbox — a short statement (getHugs' `sessions/create_with_statement`) signed with
 * cliqhub's Ed25519 key, in the link's fragment.
 */

import { randomUUID } from 'node:crypto';
import { calculateJwkThumbprint, importJWK, SignJWT, type JWK } from 'jose';
import { QueryTypes } from 'sequelize';

import { gethugs_config } from '../config/env.js';
import { visible_realm_ids } from '../auth/route_policy/visible.js';
import { get_sequelize } from '../db/sequelize.js';
import { ApiError } from '../lib/api_error.js';
import { get_logger } from '../lib/log.js';
import { Hug } from '../models/index.js';
import { EXTERNAL_SOURCE } from './gethugs_reconcile.js';
import { hugs_provider_of } from './gethugs.service.js';

const log = get_logger('svc.gethugs_sign_in');

/** How long a statement works (getHugs takes at most 60 s). */
const STATEMENT_TTL_S = 60;

export interface GethugsSignInConfig {
    /** `GETHUGS_SIGNIN_JWK`: cliqhub's private Ed25519 key (JWK). A secret: only ever in the environment. */
    jwk: JWK;
    /** The key's RFC 7638 thumbprint, as getHugs shows it. */
    kid: string;
    /** `GETHUGS_PARTNER_ID`: cliqhub's partner at getHugs (`prt_…`), the statements' issuer. */
    partner_id: string;
}

/**
 * The sign-in settings, read on each call: null when neither is set (signing in falls back to the plain link).
 *
 * @throws Error when only one is set, or the key isn't a private Ed25519 JWK
 */
export async function gethugs_signin_config(): Promise<GethugsSignInConfig | null> {
    const raw = process.env.GETHUGS_SIGNIN_JWK?.trim();
    const partner_id = process.env.GETHUGS_PARTNER_ID?.trim();
    if (!raw && !partner_id) return null;
    if (!raw || !partner_id) throw new Error('Set both GETHUGS_SIGNIN_JWK and GETHUGS_PARTNER_ID, or neither');
    let jwk: JWK;
    try {
        jwk = JSON.parse(raw) as JWK;
    } catch {
        throw new Error('GETHUGS_SIGNIN_JWK must be a JSON Web Key');
    }
    if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || !jwk.x || !jwk.d) throw new Error('GETHUGS_SIGNIN_JWK must be a private Ed25519 key (kty OKP, crv Ed25519, x and d)');
    if (!/^prt_[0-9a-z]+$/.test(partner_id)) throw new Error('GETHUGS_PARTNER_ID must be a getHugs partner id (prt_…)');
    const kid = await calculateJwkThumbprint({ kty: 'OKP', crv: 'Ed25519', x: jwk.x });
    return { jwk, kid, partner_id };
}

async function linked(org_id: string, kind: 'org' | 'user', cliq_id: string): Promise<string | null> {
    const [row] = await get_sequelize().query<{ gethugs_id: string }>(
        'SELECT gethugs_id FROM cliq.gethugs_links WHERE org_id = :org_id AND kind = :kind AND cliq_id = :cliq_id',
        { replacements: { org_id, kind, cliq_id }, type: QueryTypes.SELECT },
    );
    return row?.gethugs_id ?? null;
}

/**
 * A link that signs `user_id` in to getHugs, landing on the Hug `hug_id` (they must see its run) or the getHugs inbox
 * of the org `org_id` (they must be an active member).
 *
 * @throws 404 — no such Hug, or one they can't see; 403 — not a member of the org
 * @throws 409 `not_in_gethugs` — the org or the person isn't in getHugs; 409 `not_configured` — no key here
 */
export async function gethugs_sign_in_link(input: { user_id: string; hug_id?: string; org_id?: string }): Promise<{ url: string }> {
    let org_id: string;
    let next = '/hugs';
    if (input.hug_id) {
        const hug = await Hug.findByPk(input.hug_id, { attributes: ['id', 'org_id', 'realm_id', 'provider', 'gethugs_id'], raw: true });
        if (!hug || !(await visible_realm_ids(input.user_id, { perm: 'runs.view' })).includes(hug.realm_id)) throw ApiError.not_found('Hug not found');
        if (hug.provider !== 'gethugs' || !hug.gethugs_id) throw new ApiError(409, 'This Hug is not in getHugs', 'not_in_gethugs');
        org_id = hug.org_id;
        next = `/hugs/${hug.gethugs_id}`;
    } else {
        org_id = input.org_id!;
        const [member] = await get_sequelize().query<{ user_id: string }>(
            `SELECT user_id FROM cliq.org_members WHERE org_id = :org_id AND user_id = :user_id AND status = 'active' AND deleted_at IS NULL`,
            { replacements: { org_id, user_id: input.user_id }, type: QueryTypes.SELECT },
        );
        if (!member) throw ApiError.forbidden('Not a member of this org');
    }

    if (await hugs_provider_of(org_id) !== 'gethugs' || !(await linked(org_id, 'org', org_id)) || !(await linked(org_id, 'user', input.user_id))) {
        throw new ApiError(409, 'This org or person is not in getHugs yet', 'not_in_gethugs');
    }
    const sign_in = await gethugs_signin_config();
    const app = gethugs_config()?.app_url;
    if (!sign_in || !app) throw new ApiError(409, 'Signing in to getHugs is not set up on this CliqHub', 'not_configured');

    const statement = await new SignJWT({ src: EXTERNAL_SOURCE, org: `org:${org_id}`, next })
        .setProtectedHeader({ alg: 'EdDSA', kid: sign_in.kid })
        .setIssuer(sign_in.partner_id)
        .setAudience(app)
        .setSubject(`user:${input.user_id}`)
        .setJti(randomUUID())
        .setExpirationTime(`${STATEMENT_TTL_S}s`)
        .sign(await importJWK(sign_in.jwk, 'EdDSA'));
    log.info('gethugs_sign_in_link', { user_id: input.user_id, org_id, next });
    return { url: `${app}/sign-in/statement#${statement}` };
}

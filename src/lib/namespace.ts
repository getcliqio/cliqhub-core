/**
 * The shared slug namespace: org slugs, scope slugs and usernames, plus the
 * email uniqueness check that goes with creating a user.
 *
 * A personal org and its user share one name (org slug = username), and every
 * org gets a scope with its slug, so one name can be held by an org, a scope
 * and a user at once. Signup, org create, scope create and admin user create
 * all check the namespace through {@link assert_namespace_free}. A conflict
 * says `The name measureone is already taken.`; who holds the name (org,
 * scope or user, and its owner) is in `details`.
 *
 * A live holder gives `409 conflict` with the holder in `details`
 * ({@link NamespaceHolder} plus `field` and `holder: { id, slug }`).
 * Soft-deleted orgs and users keep their names: when only deleted rows (and
 * scopes belonging to them) hold a name, the error is `409 deleted` with
 * `details: { kind, id, deleted_at, was_active }` so a site admin can offer
 * to reactivate it.
 */

import { UniqueConstraintError } from 'sequelize';

import { ApiError, type DeletedDetails } from '../errors/api_error.js';

/** What can hold a name. */
export type NamespaceKind = 'org' | 'scope' | 'user';

/** One holder of a name (sent as the conflict's `details`). */
export interface NamespaceHolder {
    kind: NamespaceKind;
    slug: string;
    /** The holder row's id (org, scope or user). */
    id?: string;
    /** scope: `user` or `org`. */
    scope_type?: string;
    /** scope: the owning org's slug (null when the org is gone or unset). */
    org_slug?: string | null;
    /** scope: the owning user (user scopes); org: the user of a personal org. */
    owner_username?: string | null;
    /** org: a personal org (a user has the same name). */
    personal?: boolean;
    /** scope: the owning org id. */
    org_id?: string | null;
    /** scope: the owning user id. */
    owner_id?: string | null;
    /** Set when the holder is soft-deleted (a deleted personal org reports its deleted user). */
    deleted?: DeletedDetails;
}

/** A row's soft-delete fields as the lookups return them. */
interface SoftDeleteFields {
    deleted_at?: Date | string | null;
    status?: string | null;
    activated_at?: Date | string | null;
}

/** The repository lookups the check needs (services pass their own repositories). */
export interface NamespaceRepos {
    org_repo: {
        find_by_slug(slug: string): Promise<({ id: string; slug: string } & SoftDeleteFields) | null>;
        find_by_id(id: string): Promise<{ slug: string } | null>;
    };
    scope_repo: {
        find_by_slug(slug: string): Promise<{ id: string; scope_type?: string | null; org_id?: string | null; owner_id?: string | null } | null>;
    };
    user_repo: {
        find_by_username(username: string): Promise<({ id?: string; username: string } & SoftDeleteFields) | null>;
        find_profile_by_id(id: string): Promise<{ username: string } | null>;
    };
}

/** Normalized form of a name (lowercase, no leading @). */
export function normalize_name(name: string): string {
    return name.trim().toLowerCase().replace(/^@/, '');
}

function iso(value: Date | string): string {
    return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/** `deleted` details for a soft-deleted org row, or undefined when it is live. */
function org_deleted(org: { id: string } & SoftDeleteFields): DeletedDetails | undefined {
    if (!org.deleted_at) return undefined;
    return { kind: 'org', id: String(org.id), deleted_at: iso(org.deleted_at), was_active: Boolean(org.activated_at) };
}

/** `deleted` details for a soft-deleted user row, or undefined when it is live. */
function user_deleted(user: { id?: string } & SoftDeleteFields): DeletedDetails | undefined {
    if (!user.deleted_at || !user.id) return undefined;
    return { kind: 'user', id: String(user.id), deleted_at: iso(user.deleted_at), was_active: user.status !== 'invited' };
}

/**
 * The `409 deleted` error for a soft-deleted user (`details.kind = 'user'`).
 *
 * @param user - The deleted user row (`deleted_at` set).
 * @param message - What the caller tried to use the user for.
 */
export function deleted_user_error(user: { id: string; deleted_at: Date | string; status?: string | null }, message: string): ApiError {
    return ApiError.deleted(message, user_deleted(user)!);
}

/**
 * Who holds `name`, in `kinds` order (default org, scope, user), deleted rows included.
 *
 * @param repos - The caller's org / scope / user repositories.
 * @param name - The slug / username to look up.
 * @param kinds - Which namespaces to check.
 */
export async function namespace_holders(repos: NamespaceRepos, name: string, kinds: NamespaceKind[] = ['org', 'scope', 'user']): Promise<NamespaceHolder[]> {
    const slug = normalize_name(name);
    // Looked up once, only when needed (a user check, or to tell whether an org is personal).
    let user: Promise<({ id?: string; username: string } & SoftDeleteFields) | null> | null = null;
    const user_named = () => (user ??= repos.user_repo.find_by_username(slug));
    const out: NamespaceHolder[] = [];
    for (const kind of kinds) {
        if (kind === 'org') {
            const org = await repos.org_repo.find_by_slug(slug);
            if (org) {
                const u = await user_named();
                const org_gone = org_deleted(org);
                const deleted = org_gone && ((u && user_deleted(u)) || org_gone);
                out.push({ kind, slug, id: String(org.id), personal: Boolean(u), owner_username: u ? u.username : null, ...(deleted ? { deleted } : {}) });
            }
        } else if (kind === 'scope') {
            const scope = await repos.scope_repo.find_by_slug(slug);
            if (scope) {
                const org = scope.org_id ? await repos.org_repo.find_by_id(scope.org_id) : null;
                const owner = scope.owner_id ? await repos.user_repo.find_profile_by_id(scope.owner_id) : null;
                out.push({
                    kind, slug, id: String(scope.id), scope_type: scope.scope_type ?? undefined,
                    org_slug: org?.slug ?? null, owner_username: owner?.username ?? null,
                    org_id: scope.org_id ?? null, owner_id: scope.owner_id ?? null,
                });
            }
        } else {
            const u = await user_named();
            if (u) {
                const deleted = user_deleted(u);
                out.push({ kind, slug, id: u.id ? String(u.id) : undefined, ...(deleted ? { deleted } : {}) });
            }
        }
    }
    return out;
}

/**
 * The user-facing sentence for one holder. Who holds the name travels in
 * `details`; the sentence only says the name is taken (or deleted).
 */
export function namespace_message(h: NamespaceHolder): string {
    if (h.deleted) return `The name ${h.slug} belongs to a deleted ${h.deleted.kind === 'org' ? 'organization' : 'user'}.`;
    return `The name ${h.slug} is already taken.`;
}

/**
 * The error for one holder: `409 deleted` for a soft-deleted holder, otherwise
 * `409 conflict` with the holder, the colliding `field` and `holder: { id, slug }`.
 *
 * @param h - The holder.
 * @param field - The request field that collided (default `slug`).
 */
export function namespace_conflict(h: NamespaceHolder, field = 'slug'): ApiError {
    if (h.deleted) return ApiError.deleted(namespace_message(h), h.deleted);
    const { deleted: _deleted, ...rest } = h;
    return ApiError.name_conflict(namespace_message(h), { ...rest, field, holder: { id: h.id ?? '', slug: h.slug } });
}

/**
 * The holder that decides the error: the first live holder, ignoring scopes
 * that belong to a deleted org or user holding the same name; otherwise the
 * first deleted holder. Null when the name is free.
 */
export function deciding_holder(holders: NamespaceHolder[]): NamespaceHolder | null {
    const deleted_ids = new Set(holders.filter((h) => h.deleted).flatMap((h) => [h.id, h.deleted!.id]));
    const live = holders.find((h) => !h.deleted && !(h.kind === 'scope'
        && ((h.org_id && deleted_ids.has(h.org_id)) || (h.owner_id && deleted_ids.has(h.owner_id)))));
    return live ?? holders.find((h) => h.deleted) ?? null;
}

/**
 * Throws for the holder {@link deciding_holder} picks among the holders of `name` in `kinds`.
 *
 * @param repos - The caller's org / scope / user repositories.
 * @param name - The slug / username a create would take.
 * @param kinds - The namespaces it must be free in, in reporting order.
 * @param field - The request field carrying the name (`slug` or `username`).
 * @throws ApiError 409 conflict (live holder) or 409 deleted (only deleted holders)
 */
export async function assert_namespace_free(repos: NamespaceRepos, name: string, kinds: NamespaceKind[] = ['org', 'scope', 'user'], field = 'slug'): Promise<void> {
    const holder = deciding_holder(await namespace_holders(repos, name, kinds));
    if (holder) throw namespace_conflict(holder, field);
}

/** The lookup {@link assert_email_free} needs (`UserRepository.find_by_email`). */
export interface EmailHolderRepo {
    find_by_email(email: string, exclude_id?: string): Promise<({ id: string; username?: string | null } & SoftDeleteFields) | null>;
}

/**
 * Throws when a user, live or soft-deleted, already has `email`.
 *
 * @param user_repo - The caller's user repository.
 * @param email - The address a create or update would set (normalized here).
 * @param exclude_user_id - The user being updated, whose own address does not count.
 * @throws ApiError 409 conflict (`details.field = 'email'`; the message points
 *   an invited person to their invite) or 409 deleted
 */
export async function assert_email_free(user_repo: EmailHolderRepo, email: string, exclude_user_id?: string): Promise<void> {
    const norm = email.trim().toLowerCase();
    const holder = await user_repo.find_by_email(norm, exclude_user_id);
    if (!holder) return;
    const deleted = user_deleted(holder);
    if (deleted) throw ApiError.deleted(`${norm} belongs to a deleted user`, deleted);
    const message = holder.status === 'invited'
        ? 'This email has an open invite. Use the link in the invite email to set up the account.'
        : 'Email already in use';
    throw ApiError.name_conflict(message, { kind: 'user', field: 'email', holder: { id: String(holder.id), slug: holder.username ?? null } });
}

/**
 * Runs a create whose unique names (slug, username, email) were checked
 * before it started. When a concurrent create took a name in between and the
 * insert hits a unique index, `recheck` runs the same checks again so the
 * caller gets the usual `409 conflict` / `409 deleted` instead of a 500.
 *
 * @param work - The create (usually one transaction).
 * @param recheck - The name checks; throws for the name that is now taken.
 * @throws ApiError 409 conflict when the race hit a name `recheck` does not cover
 */
export async function on_name_race<T>(work: () => Promise<T>, recheck: () => Promise<void>): Promise<T> {
    try {
        return await work();
    } catch (err) {
        if (!(err instanceof UniqueConstraintError)) throw err;
        await recheck();
        throw new ApiError('conflict', 'This name was taken a moment ago. Choose another.', 409);
    }
}

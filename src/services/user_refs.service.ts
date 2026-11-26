/**
 * User refs — `{ id, username, display_name }` for a set of user ids, in one read.
 *
 * For lists that show a person per row (who started a run, who published a team version):
 * collect the page's ids, call {@link UserRefs.by_ids} once, look each row up.
 */
import { Op } from 'sequelize';
import { User } from '../models/index.js';

/** A person as a list row shows them. */
export interface UserRef {
    id: string;
    username: string | null;
    display_name: string | null;
}

export class UserRefs {
    /**
     * The users behind `ids` (empty, null and repeated ids ignored), keyed by id.
     * An id with no user (deleted account) is absent; callers show it as unknown.
     */
    static async by_ids(ids: ReadonlyArray<string | null | undefined>): Promise<Map<string, UserRef>> {
        const want = [...new Set(ids.filter((x): x is string => typeof x === 'string' && x.length > 0))];
        if (!want.length) return new Map();
        const rows = await User.findAll({
            where: { id: { [Op.in]: want } },
            attributes: ['id', 'username', 'display_name'],
            raw: true,
        }) as unknown as Array<{ id: string; username: string | null; display_name: string | null }>;
        return new Map(rows.map((u) => [String(u.id), { id: String(u.id), username: u.username ?? null, display_name: u.display_name ?? null }]));
    }

    /** The ref for `id`, or null (no id, or no such user). */
    static pick(refs: Map<string, UserRef>, id: string | null | undefined): UserRef | null {
        return id ? refs.get(id) ?? null : null;
    }
}

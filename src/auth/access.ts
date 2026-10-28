import type { AuthContext } from '../schemas/auth_types.js';

export interface TeamAccess {
    visibility: 'public' | 'private' | 'draft';
    author_id: string | null;
    scope: string | null;
}

/**
 * Who sees a team (PLAN-team-visibility §3.2): public, everyone; private, the members of its scope
 * (`auth.member_scopes`); draft, its author.
 */
export function can_view_team(auth: Pick<AuthContext, 'user' | 'member_scopes'>, team: TeamAccess): boolean {
    if (team.visibility === 'public') return true;
    if (!auth.user) return false;
    if (team.visibility === 'draft') return team.author_id === auth.user.id;
    if (!team.scope) return false;
    return auth.member_scopes.some((s) => s.slug === team.scope);
}

/**
 * Who may read a team (decision 6): without signing in, only listed public
 * teams; signed in, `can_view_team`; site admins (user token) any team.
 */
export function can_read_team(auth: AuthContext | undefined, team: TeamAccess & { listed?: number | boolean | null }): boolean {
    if (!auth?.user) return team.visibility === 'public' && Boolean(team.listed);
    if (auth.auth_via !== 'daemon_token' && auth.user.role === 'admin') return true;
    return can_view_team(auth, team);
}

import type { AuthContext } from '../schemas/auth_types.js';

export interface TeamAccess {
    visibility: 'public' | 'private' | 'draft';
    author_id: string | null;
    scope: string | null;
}

export function can_view_team(auth: AuthContext, team: TeamAccess): boolean {
    if (team.visibility === 'public') return true;
    if (!auth.user) return false;
    if (team.author_id === auth.user.id) return true;
    if (!team.scope) return false;
    return auth.scopes.some((s) => s.slug === team.scope);
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

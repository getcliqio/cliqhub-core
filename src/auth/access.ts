import type { AuthContext } from '../types/vo.js';

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

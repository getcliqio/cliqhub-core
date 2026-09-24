import type { Request } from 'express';

/** True when the authenticated Hub account is a site admin. */
export function is_site_admin(req: Request): boolean {
	return req.user?.role === 'admin' || req.auth?.user?.role === 'admin';
}

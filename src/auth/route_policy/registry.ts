/**
 * Route registry — remembers which routers are mounted where, so the start-up
 * check can compare every mounted route with the policy table.
 */

import type { Application, Router } from 'express';

interface Mounted { prefix: string; router: Router }
const mounted = new WeakMap<Application, Mounted[]>();

/** `app.use(prefix, router)` that also records the mount. Use for every Core router. */
export function mount(app: Application, prefix: string, router: Router): void {
    app.use(prefix, router);
    const list = mounted.get(app) ?? [];
    list.push({ prefix, router });
    mounted.set(app, list);
}

interface RouteLayer {
    route?: { path: string | string[]; methods: Record<string, boolean> };
}

/** Every mounted route as `METHOD /full/path`, sorted and de-duplicated. */
export function list_routes(app: Application): string[] {
    const out = new Set<string>();
    for (const { prefix, router } of mounted.get(app) ?? []) {
        for (const layer of (router as unknown as { stack: RouteLayer[] }).stack) {
            if (!layer.route) continue;
            const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
            for (const p of paths) {
                for (const [method, on] of Object.entries(layer.route.methods)) {
                    if (on && method !== '_all') out.add(`${method.toUpperCase()} ${prefix}${p}`);
                }
            }
        }
    }
    return [...out].sort();
}

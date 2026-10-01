import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { SettingsService } from '../services/hub_settings_service.js';
import { RealmService } from '../services/realm.service.js';
import { AdminCheck } from '../lib/site_admin.js';
import { ApiError } from '../lib/api_error.js';
import { get_logger } from '../lib/log.js';

const get_by_key_schema = z.object({
    key: z.string(),
});

const set_schema = z.object({
    key: z.string(),
    value: z.string(),
});

const get_schema = z.object({
    prefix: z.string().optional(),
}).optional();

const remove_schema = z.object({
    key: z.string(),
});

const log = get_logger('ctrl.hub_settings');

/**
 * Hub-wide settings are global daemon config (`docker.base_image`, `hub.registry_url`, …)
 * that every daemon picks up, so writes are site-admin only (S1).
 *
 * Reads (S2): a site admin reads anything; a daemon token reads the global
 * settings and those of daemons in its own realm. Everyone else gets 403.
 */
function deny(req: Request, route: string, reason: string): never {
    log.warn('access_denied', {
        request_id: req.request_id,
        route,
        reason,
        user_id: req.auth?.user?.id,
        auth_via: req.auth?.auth_via,
    });
    if (!req.auth?.user) throw ApiError.unauthorized('Authentication required');
    throw ApiError.forbidden('Site admin required');
}

async function require_settings_reader(req: Request, route: string, daemon_id: string | undefined): Promise<void> {
    if (AdminCheck.is_site_admin(req)) return;
    if (req.auth?.auth_via === 'daemon_token' && req.auth.realm_id) {
        if (!daemon_id) return;
        try {
            await RealmService.assert_daemon_in_realm(req.auth.realm_id, daemon_id);
            return;
        } catch {
            deny(req, route, 'daemon_not_in_token_realm');
        }
    }
    deny(req, route, req.auth?.user ? 'not_site_admin' : 'no_token');
}

export class SettingsController {
    static async get_by_key(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const { key } = get_by_key_schema.parse(req.body);
            await require_settings_reader(req, 'settings/get_by_key', undefined);
            log.debug('get_by_key', { key, user_id: req.auth?.user?.id });
            const setting = await SettingsService.get(key);
            res.json({ ok: true, setting: setting ?? null });
        } catch (err) { next(err); }
    }

    static async set(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            // Route policy: site admin.
            const { key, value } = set_schema.parse(req.body);
            await SettingsService.set(key, value);
            log.info('setting_changed', { key, user_id: req.auth?.user?.id, request_id: req.request_id });
            res.json({ ok: true });
        } catch (err) { next(err); }
    }

    static async get(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const body = get_schema.parse(req.body);
            const daemon_id = typeof req.body?.daemon_id === 'string' ? req.body.daemon_id : undefined;
            await require_settings_reader(req, 'settings/get', daemon_id);
            log.debug('get', { daemon_id, prefix: body?.prefix, user_id: req.auth?.user?.id });
            if (body?.prefix) {
                const settings = await SettingsService.list_by_prefix(body.prefix, daemon_id);
                res.json({ ok: true, settings });
                return;
            }
            const settings = await SettingsService.list(daemon_id);
            res.json({ ok: true, settings });
        } catch (err) { next(err); }
    }

    static async remove(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            // Route policy: site admin.
            const { key } = remove_schema.parse(req.body);
            const removed = await SettingsService.remove(key);
            log.info('setting_removed', { key, removed, user_id: req.auth?.user?.id, request_id: req.request_id });
            res.json({ ok: true, removed });
        } catch (err) { next(err); }
    }
}

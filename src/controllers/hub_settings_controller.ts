import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { SettingsService } from '../services/hub_settings_service.js';

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

export class SettingsController {
    static async get_by_key(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const { key } = get_by_key_schema.parse(req.body);
            const setting = await SettingsService.get(key);
            res.json({ ok: true, setting: setting ?? null });
        } catch (err) { next(err); }
    }

    static async set(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const { key, value } = set_schema.parse(req.body);
            await SettingsService.set(key, value);
            res.json({ ok: true });
        } catch (err) { next(err); }
    }

    static async get(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const body = get_schema.parse(req.body);
            const daemon_id = req.body?.daemon_id as string | undefined;
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
            const { key } = remove_schema.parse(req.body);
            const removed = await SettingsService.remove(key);
            res.json({ ok: true, removed });
        } catch (err) { next(err); }
    }
}

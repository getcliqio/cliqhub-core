import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { ScopeService } from '../services/control_scope_service.js';
import { ApiError } from '../lib/api_error.js';

const get_schema = z.object({}).optional();
const get_default_schema = z.object({}).optional();
const set_default_schema = z.object({ slug: z.string() });

const add_schema = z.object({
    slug: z.string(),
    name: z.string().optional(),
    org_id: z.string().optional(),
    scope_type: z.string().optional(),
});

const remove_schema = z.object({ slug: z.string() });
const get_by_id_schema = z.object({ id: z.string() });
const get_by_slug_schema = z.object({ slug: z.string() });
const resolve_schema = z.object({ ref: z.string() });

export class ScopeController {
    static async get(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            get_schema.parse(req.body);
            const scopes = await ScopeService.list();
            res.json({ ok: true, scopes });
        } catch (err) { next(err); }
    }

    static async get_default(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            get_default_schema.parse(req.body);
            const scope = await ScopeService.get_default();
            res.json({ ok: true, scope });
        } catch (err) { next(err); }
    }

    static async set_default(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const { slug } = set_default_schema.parse(req.body);
            const updated = await ScopeService.set_default(slug);
            res.json({ ok: true, updated });
        } catch (err) { next(err); }
    }

    static async add(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const data = add_schema.parse(req.body);
            const scope = await ScopeService.add(data.slug, data.name, data.org_id, data.scope_type);
            res.json({ ok: true, scope });
        } catch (err) { next(err); }
    }

    static async remove(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const { slug } = remove_schema.parse(req.body);
            const removed = await ScopeService.remove(slug);
            res.json({ ok: true, removed });
        } catch (err) { next(err); }
    }

    static async get_by_id(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const { id } = get_by_id_schema.parse(req.body);
            const scope = await ScopeService.find_by_id(id);
            res.json({ ok: true, scope: scope ?? null });
        } catch (err) { next(err); }
    }

    static async get_by_slug(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const { slug } = get_by_slug_schema.parse(req.body);
            const scope = await ScopeService.find_by_slug(slug);
            res.json({ ok: true, scope });
        } catch (err) { next(err); }
    }

    static async resolve(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const { ref } = resolve_schema.parse(req.body);
            const scope = await ScopeService.resolve(ref);
            res.json({ ok: true, scope });
        } catch (err) { next(err); }
    }
}

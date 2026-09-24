import { z } from 'zod';

export const drafts_get_by_id_schema = z.object({
    id: z.string().uuid({ message: 'id must be a uuid' }),
});

export const drafts_new_schema = z.object({
    title: z.string().optional(),
    team_json: z.string().min(1, 'team_json is required'),
});

export const drafts_update_schema = z.object({
    id: z.string().uuid({ message: 'id must be a uuid' }),
    title: z.string().optional(),
    team_json: z.string().min(1, 'team_json is required'),
});

export const drafts_delete_schema = z.object({
    id: z.string().uuid({ message: 'id must be a uuid' }),
});

import { z } from 'zod';

/**
 * Canonical wire shape for a draft list item (used in paginated lists).
 * Replaces DraftListItemDto / DraftListItemVo.
 */
export const DraftListItemData = z.object({
    id: z.string().uuid()
        .describe('Draft UUID'),
    title: z.string()
        .describe('Draft title'),
    updated_at: z.string()
        .describe('ISO timestamp of last update'),
});

export type DraftListItemData = z.infer<typeof DraftListItemData>;

/**
 * Canonical wire shape for a full draft (get_by_id).
 * Replaces DraftDto / DraftVo.
 */
export const DraftDetailData = z.object({
    id: z.string().uuid()
        .describe('Draft UUID'),
    user_id: z.string().uuid()
        .describe('UUID of the owning user'),
    title: z.string()
        .describe('Draft title'),
    team_json: z.string()
        .describe('Serialized team definition JSON'),
    created_at: z.string()
        .describe('ISO timestamp of draft creation'),
    updated_at: z.string()
        .describe('ISO timestamp of last update'),
});

export type DraftDetailData = z.infer<typeof DraftDetailData>;

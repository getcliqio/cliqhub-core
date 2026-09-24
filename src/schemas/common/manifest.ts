/**
 * Shared Zod inputs reused across resources.
 * Add here when a shape appears in more than one `*Input` schema.
 */

import { z } from 'zod';

/** Agent / team manifest: YAML string or already-parsed object. */
export const ManifestInput = z.union([
    z.string().min(1).describe('Manifest as a YAML or JSON string'),
    z.record(z.string(), z.unknown()).describe('Already-parsed manifest object'),
]).describe('Agent or team manifest (string or object)');
export type ManifestInput = z.infer<typeof ManifestInput>;

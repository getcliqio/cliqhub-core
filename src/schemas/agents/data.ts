/**
 * Agents API — response Zod schemas (SoT for OpenAPI / Mintlify).
 *
 * Naming matches inputs: PascalCase value + type with the same name.
 * Every field must have `.describe(…)` (feeds Hub OpenAPI).
 */

import { z } from 'zod';

import type { BooleanData } from '../../types/api_response.js';
import type { SettingsData } from '../settings_schemas.js';

/** Catalog agent on the wire. */
export const AgentData = z.object({
	id: z.string().describe('Catalog row UUID'),
	name: z.string().describe('Agent name (natural key with org + version)'),
	version: z.string().nullable().describe('Version string, or null when unversioned'),
	description: z.string().nullable().describe('Human-readable summary'),
	agent_type: z.string().describe('Runtime kind (e.g. exec, connector)'),
	is_system: z.boolean().describe('True for platform built-ins; false for org-registered custom agents'),
	manifest: z.record(z.string(), z.unknown()).optional().describe('Parsed manifest object when include_manifest was true'),
	created_at: z.number().describe('Row create time (unix ms)'),
	updated_at: z.number().describe('Row last update time (unix ms)'),
});
export type AgentData = z.infer<typeof AgentData>;

/**
 * Full agents resource `data` union.
 * get / get_by_id / register → AgentData | AgentData[]
 * get_settings → SettingsData | SettingsData[]
 * deregister / update_settings → BooleanData
 */
export type AgentsData =
	| AgentData
	| AgentData[]
	| SettingsData
	| SettingsData[]
	| BooleanData;

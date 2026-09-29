/**
 * Platform settings wire shapes — Zod SoT + inferred types.
 *
 * Naming: PascalCase value + type with the same name (same as Agents*Input).
 * Every field must have `.describe(…)` (feeds Hub OpenAPI / Mintlify).
 */

import { z } from 'zod';

/** One setting key as declared on a schema (manifest, channel, hub, …). */
export const SettingDef = z.object({
	key: z.string().describe('Setting key as declared on the subject schema'),
	description: z.string().optional().describe('Human-readable help for the key'),
	default: z.unknown().optional().describe('Default value when unset'),
	when: z.record(z.string(), z.string()).optional().describe('Conditional visibility map (key → required value)'),
});
export type SettingDef = z.infer<typeof SettingDef>;

/**
 * Settings snapshot on the wire.
 * List → `SettingsData[]`; one subject → `SettingsData`.
 */
export const SettingsData = z.object({
	id: z.string().uuid().describe('Catalog row UUID (round-trip for get_settings / update_settings)'),
	name: z.string().describe('Subject name (e.g. agent catalog name)'),
	version: z.string().nullable().describe('Subject version, or null when unversioned'),
	description: z.string().nullable().describe('Subject summary'),
	is_system: z.boolean().describe('True for platform built-ins'),
	settings: z.object({
		required: z.array(SettingDef).describe('Required setting definitions from the schema'),
		optional: z.array(SettingDef).describe('Optional setting definitions from the schema'),
	}).describe('Schema split into required vs optional keys'),
	values: z.record(z.string(), z.string()).describe('Resolved string values by key'),
	source: z.record(z.string(), z.enum(['org', 'realm']).nullable()).describe('Where each value was set (org, realm, or unset)'),
	inherited: z.record(z.string(), z.boolean()).describe('True when the value is inherited rather than local'),
	configured: z.record(z.string(), z.boolean()).describe('True when the key has a non-empty resolved value'),
	required_total: z.number().describe('Count of required keys'),
	required_configured: z.number().describe('Count of required keys that are configured'),
	optional_total: z.number().describe('Count of optional keys'),
	optional_configured: z.number().describe('Count of optional keys that are configured'),
	all_required_configured: z.boolean().describe('True when every required key is configured'),
});
export type SettingsData = z.infer<typeof SettingsData>;

/** @deprecated Use SettingsData. */
export type AgentSettingsData = SettingsData;

/** @deprecated Use SettingDef. */
export const setting_def_schema = SettingDef;

/** @deprecated Use SettingsData. */
export const settings_data_schema = SettingsData;

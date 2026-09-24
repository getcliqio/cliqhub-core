/**
 * Hub Agents API — barrel.
 *
 * Layout:
 *   agents/data.ts      — response Zod (`AgentData`, …)
 *   agents/inputs.ts    — PascalCase Zod `Agents*Input` (+ `type` same name)
 *   common/manifest.ts  — shared reusable inputs (import before duplicating)
 *   settings_schemas.ts — `SettingsData` / `SettingDef`
 *
 * Prefer importing from the leaf modules when editing; this barrel is for
 * existing call sites.
 */

export { AgentData } from './agents/data.js';
export type { AgentsData } from './agents/data.js';
export * from './agents/inputs.js';
export * from './common/manifest.js';
export { SettingDef, SettingsData, setting_def_schema, settings_data_schema } from './settings_schemas.js';
export type { AgentSettingsData } from './settings_schemas.js';

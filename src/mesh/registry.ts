import type { Mesh_adapter, Mesh_adapter_descriptor } from './types.js';
import { ApiError } from '../lib/api_error.js';

const adapters = new Map<string, Mesh_adapter>();

export function register_mesh_adapter(adapter: Mesh_adapter): void {
    if (!adapter.id.trim()) throw new Error('Mesh adapter id is required');
    adapters.set(adapter.id, adapter);
}

export function get_mesh_adapter(provider_id: string): Mesh_adapter {
    const adapter = adapters.get(provider_id);
    if (!adapter) throw ApiError.bad_request(`Unknown mesh provider '${provider_id}'`);
    return adapter;
}

export function try_get_mesh_adapter(provider_id: string | null | undefined): Mesh_adapter | null {
    if (!provider_id) return null;
    return adapters.get(provider_id) ?? null;
}

export function list_mesh_adapters(): Mesh_adapter_descriptor[] {
    return [...adapters.values()].map((adapter) => ({
        id: adapter.id,
        label: adapter.label,
        settings_schema: adapter.settings_schema,
    }));
}

/** Test helper — clears registry between unit tests. */
export function reset_mesh_adapter_registry(): void {
    adapters.clear();
}

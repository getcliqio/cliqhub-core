import { describe, it, expect, beforeEach } from 'vitest';
import {
    register_mesh_adapter,
    get_mesh_adapter,
    list_mesh_adapters,
    reset_mesh_adapter_registry,
    try_get_mesh_adapter,
} from '../../../src/mesh/registry.js';
import { reset_mesh_bootstrap, bootstrap_mesh_adapters } from '../../../src/mesh/bootstrap.js';
import type { Mesh_adapter } from '../../../src/mesh/types.js';
import {
    mask_provider_settings,
    merge_provider_settings_patch,
} from '../../../src/mesh/settings_util.js';

function fake_adapter(id: string): Mesh_adapter {
    return {
        id,
        label: id,
        settings_schema: [
            { key: 'token', label: 'Token', type: 'secret', required: true },
            { key: 'url', label: 'URL', type: 'url' },
        ],
        async connect() { return { status: 'connected' }; },
        async disconnect() { return { status: 'disconnected' }; },
        async re_register() { return { status: 'connected' }; },
        async health() { return { status: 'connected' }; },
    };
}

describe('mesh adapter registry', () => {
    beforeEach(() => {
        reset_mesh_adapter_registry();
        reset_mesh_bootstrap();
    });

    it('registers and resolves adapters', () => {
        register_mesh_adapter(fake_adapter('alpha'));
        expect(get_mesh_adapter('alpha').label).toBe('alpha');
        expect(try_get_mesh_adapter('missing')).toBeNull();
        expect(() => get_mesh_adapter('missing')).toThrow();
    });

    it('bootstrap registers svantic', () => {
        bootstrap_mesh_adapters();
        bootstrap_mesh_adapters(); // idempotent
        const ids = list_mesh_adapters().map((a) => a.id);
        expect(ids).toContain('svantic');
        expect(get_mesh_adapter('svantic').settings_schema.length).toBeGreaterThan(0);
    });

    it('masks secrets and preserves on empty patch', () => {
        register_mesh_adapter(fake_adapter('alpha'));
        const masked = mask_provider_settings('alpha', { token: 'secret-value', url: 'https://x' });
        expect(masked.token).toBe('••••••••');
        expect(masked.token_set).toBe(true);
        expect(masked.url).toBe('https://x');

        const merged = merge_provider_settings_patch(
            'alpha',
            { token: 'secret-value', url: 'https://x' },
            { token: '••••••••', url: 'https://y' },
        );
        expect(merged.token).toBe('secret-value');
        expect(merged.url).toBe('https://y');
    });
});

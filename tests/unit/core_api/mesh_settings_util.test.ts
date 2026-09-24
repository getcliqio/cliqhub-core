import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
    mask_provider_settings,
    merge_provider_settings_patch,
} from '../../../src/mesh/settings_util.js';
import {
    register_mesh_adapter,
    reset_mesh_adapter_registry,
} from '../../../src/mesh/registry.js';
import type { Mesh_adapter } from '../../../src/mesh/types.js';

const svantic_like: Mesh_adapter = {
    id: 'svantic',
    label: 'Svantic',
    settings_schema: [
        { key: 'api_url', label: 'API URL', type: 'url', required: true },
        { key: 'client_id', label: 'Client ID', type: 'string', required: true },
        { key: 'client_secret', label: 'Client secret', type: 'secret', required: true },
        { key: 'mode', label: 'Mode', type: 'enum', required: true, default: 'hosted' },
        { key: 'dispatch_secret', label: 'Dispatch secret', type: 'secret' },
    ],
    connect: async () => ({ status: 'connected' }),
    disconnect: async () => ({ status: 'disconnected' }),
    re_register: async () => ({ status: 'connected' }),
    health: async () => ({ status: 'disconnected' }),
};

describe('mesh settings_util (svantic fields)', () => {
    beforeEach(() => {
        reset_mesh_adapter_registry();
        register_mesh_adapter(svantic_like);
    });

    it('masks secrets but keeps api_url and client_id visible', () => {
        const masked = mask_provider_settings('svantic', {
            api_url: 'https://api.svantic.com',
            client_id: 'cid-1',
            client_secret: 'super-secret',
            mode: 'hosted',
            dispatch_secret: 'dispatch-sec',
        });
        expect(masked.api_url).toBe('https://api.svantic.com');
        expect(masked.client_id).toBe('cid-1');
        expect(masked.mode).toBe('hosted');
        expect(masked.client_secret).toBe('••••••••');
        expect(masked.client_secret_set).toBe(true);
        expect(masked.dispatch_secret).toBe('••••••••');
        expect(masked.dispatch_secret_set).toBe(true);
    });

    it('merge keeps existing secret when patch sends mask', () => {
        const merged = merge_provider_settings_patch(
            'svantic',
            {
                api_url: 'https://api.svantic.com',
                client_id: 'cid-1',
                client_secret: 'kept-secret',
                mode: 'hosted',
            },
            {
                api_url: 'https://mesh.example.com',
                client_id: 'cid-2',
                client_secret: '••••••••',
                mode: 'connected',
            },
        );
        expect(merged.api_url).toBe('https://mesh.example.com');
        expect(merged.client_id).toBe('cid-2');
        expect(merged.client_secret).toBe('kept-secret');
        expect(merged.mode).toBe('connected');
    });

    it('merge updates secret when a new value is provided', () => {
        const merged = merge_provider_settings_patch(
            'svantic',
            { client_secret: 'old' },
            { client_secret: 'new-secret' },
        );
        expect(merged.client_secret).toBe('new-secret');
    });
});

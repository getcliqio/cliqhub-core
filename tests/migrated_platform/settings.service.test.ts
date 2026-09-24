import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';

import { SettingsService } from '../../src/services/hub_settings_service.js';
import { close_test_control_plane_store, open_test_control_plane_store, postgres_reachable } from './helpers/control_plane_store.js';
import { DaemonConfig } from '../../src/models/index.js';

const has_postgres = await postgres_reachable();

const uid = () => `test.setting.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;

beforeAll(async () => {
    if (!has_postgres) return;
    process.env.CLIQ_BFF_LOG_LEVEL = 'error';
    await open_test_control_plane_store();
});

beforeEach(async () => {
    if (!has_postgres) return;
    await DaemonConfig.destroy({ where: {}, truncate: true, cascade: true });
});

afterAll(async () => {
    if (!has_postgres) return;
    await DaemonConfig.destroy({ where: {}, truncate: true, cascade: true });
    await close_test_control_plane_store();
});

describe.skipIf(!has_postgres)('SettingsService.get', () => {
    it('returns null for nonexistent key', async () => {
        const result = await SettingsService.get('missing-key');
        expect(result).toBeNull();
    });

    it('returns stored value', async () => {
        const key = uid();
        await SettingsService.set(key, 'hello');

        const result = await SettingsService.get(key);
        expect(result).not.toBeNull();
        expect(result!.value).toBe('hello');
    });
});

describe.skipIf(!has_postgres)('SettingsService.set', () => {
    it('returns false when creating new key', async () => {
        const key = uid();
        const existed = await SettingsService.set(key, 'value1');
        expect(existed).toBe(false);
    });

    it('returns true when updating existing key', async () => {
        const key = uid();
        await SettingsService.set(key, 'original');
        const existed = await SettingsService.set(key, 'updated');
        expect(existed).toBe(true);

        const result = await SettingsService.get(key);
        expect(result!.value).toBe('updated');
    });
});

describe.skipIf(!has_postgres)('SettingsService.list', () => {
    it('returns empty when no settings exist', async () => {
        const result = await SettingsService.list();
        expect(result).toEqual([]);
    });

    it('returns all settings ordered by key', async () => {
        const key_b = `b.${uid()}`;
        const key_a = `a.${uid()}`;
        await SettingsService.set(key_b, 'val_b');
        await SettingsService.set(key_a, 'val_a');

        const result = await SettingsService.list();
        const keys = result.map((r) => r.key);
        expect(keys).toEqual([key_a, key_b]);
    });
});

describe.skipIf(!has_postgres)('SettingsService.list_by_prefix', () => {
    it('returns only keys matching prefix', async () => {
        const prefix = `pfx.${Date.now()}.`;
        await SettingsService.set(`${prefix}one`, 'v1');
        await SettingsService.set(`${prefix}two`, 'v2');
        await SettingsService.set(`other.${uid()}`, 'v3');

        const result = await SettingsService.list_by_prefix(prefix);
        expect(result).toHaveLength(2);
        result.forEach((r) => expect(r.key.startsWith(prefix)).toBe(true));
    });

    it('returns empty for non-matching prefix', async () => {
        await SettingsService.set(uid(), 'val');

        const result = await SettingsService.list_by_prefix('zzz.no.match.');
        expect(result).toEqual([]);
    });
});

describe.skipIf(!has_postgres)('SettingsService.remove', () => {
    it('removes existing key and returns true', async () => {
        const key = uid();
        await SettingsService.set(key, 'doomed');

        const removed = await SettingsService.remove(key);
        expect(removed).toBe(true);

        const check = await SettingsService.get(key);
        expect(check).toBeNull();
    });

    it('returns false for nonexistent key', async () => {
        const removed = await SettingsService.remove('no-such-key');
        expect(removed).toBe(false);
    });
});


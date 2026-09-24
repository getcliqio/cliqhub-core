import { describe, it, expect, afterEach } from 'vitest';
import { load_env } from '../../../src/config/env.js';

const KEYS = [
    'DATABASE_URL',
    'JWT_SECRET',
    'PORT',
    'ALLOWED_ORIGINS',
    'STORAGE_BACKEND',
    'RATE_LIMIT_PUBLIC_RPM',
] as const;

const saved: Partial<Record<(typeof KEYS)[number], string | undefined>> = {};

afterEach(() => {
    for (const key of KEYS) {
        if (saved[key] === undefined) {
            delete process.env[key];
            continue;
        }
        process.env[key] = saved[key];
    }
});

function stash() {
    for (const key of KEYS) {
        saved[key] = process.env[key];
    }
}

describe('load_env', () => {
    it('requires DATABASE_URL', () => {
        stash();
        delete process.env.DATABASE_URL;
        expect(() => load_env()).toThrow('Missing required env var: DATABASE_URL');
    });

    it('loads defaults and parses lists', () => {
        stash();
        process.env.DATABASE_URL = 'postgres://localhost/hub';
        delete process.env.JWT_SECRET;
        delete process.env.PORT;
        delete process.env.STORAGE_BACKEND;
        delete process.env.RATE_LIMIT_PUBLIC_RPM;
        process.env.ALLOWED_ORIGINS = 'https://a.test, https://b.test';

        const cfg = load_env();
        expect(cfg.database_url).toBe('postgres://localhost/hub');
        expect(cfg.port).toBe(4000);
        expect(cfg.jwt_secret).toBe('dev-only-secret-not-for-production');
        expect(cfg.storage_backend).toBe('local');
        expect(cfg.allowed_origins).toEqual(['https://a.test', 'https://b.test']);
        expect(cfg.rate_limit_public_rpm).toBe(30);
    });
});

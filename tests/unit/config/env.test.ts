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

describe('load_env link settings', () => {
    const LINK_KEYS = ['DATABASE_URL', 'NODE_ENV', 'TOKEN_ENCRYPTION_KEY', 'PUBLIC_APP_URL', 'BREVO_API_KEY', 'EMAIL_FROM_ADDRESS', 'EMAIL_FROM_NAME'] as const;
    const before: Record<string, string | undefined> = {};

    afterEach(() => {
        for (const key of LINK_KEYS) {
            if (before[key] === undefined) delete process.env[key];
            else process.env[key] = before[key];
        }
    });

    function reset() {
        for (const key of LINK_KEYS) {
            before[key] = process.env[key];
            delete process.env[key];
        }
        process.env.DATABASE_URL = 'postgres://localhost/hub';
    }

    it('production refuses to boot without a valid TOKEN_ENCRYPTION_KEY', () => {
        reset();
        process.env.NODE_ENV = 'production';
        expect(() => load_env()).toThrow('TOKEN_ENCRYPTION_KEY');
        process.env.TOKEN_ENCRYPTION_KEY = 'too-short';
        expect(() => load_env()).toThrow('32 bytes');
    });

    it('production refuses to boot without a valid PUBLIC_APP_URL', () => {
        reset();
        process.env.NODE_ENV = 'production';
        process.env.TOKEN_ENCRYPTION_KEY = 'ab'.repeat(32);
        expect(() => load_env()).toThrow('PUBLIC_APP_URL');
        process.env.PUBLIC_APP_URL = 'not a url';
        expect(() => load_env()).toThrow('http(s) URL');
        process.env.PUBLIC_APP_URL = 'https://app.example.test';
        expect(() => load_env()).not.toThrow();
    });

    it('outside production the key is optional but validated when set; email settings are read', () => {
        reset();
        expect(() => load_env()).not.toThrow();
        process.env.TOKEN_ENCRYPTION_KEY = 'nope';
        expect(() => load_env()).toThrow('32 bytes');
        process.env.TOKEN_ENCRYPTION_KEY = 'ab'.repeat(32);
        process.env.PUBLIC_APP_URL = 'nope';
        expect(() => load_env()).toThrow('http(s) URL');
        process.env.PUBLIC_APP_URL = 'https://app.example.test/';
        process.env.EMAIL_FROM_ADDRESS = 'noreply@example.test';
        process.env.EMAIL_FROM_NAME = 'CliqHub';
        const cfg = load_env();
        expect(cfg.email_from_address).toBe('noreply@example.test');
        expect(cfg.email_from_name).toBe('CliqHub');
        expect(cfg.brevo_api_key).toBeUndefined();
    });
});

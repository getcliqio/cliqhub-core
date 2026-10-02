import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';

import { decrypt_token, encrypt_token, generate_token, hash_token, issue_token } from '../../../src/lib/secure_token.js';
import { parse_token_encryption_key, public_app_url, token_encryption_key } from '../../../src/config/env.js';
import { TEST_TOKEN_ENCRYPTION_KEY, use_test_link_env } from '../../helpers/link_env.js';

describe('secure_token', () => {
    let restore: () => void;
    beforeEach(() => { restore = use_test_link_env(); });
    afterEach(() => restore());

    it('generates URL-safe 256-bit tokens that differ every time', () => {
        const a = generate_token();
        const b = generate_token();
        expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(a).not.toBe(b);
    });

    it('hashes with SHA-256 hex', () => {
        expect(hash_token('abc')).toBe(crypto.createHash('sha256').update('abc').digest('hex'));
        expect(hash_token('abc')).toHaveLength(64);
    });

    it('encrypts with AES-256-GCM and decrypts back; each encryption uses a fresh IV', () => {
        const token = generate_token();
        const one = encrypt_token(token);
        const two = encrypt_token(token);
        expect(one).toMatch(/^v1\.[\w-]+\.[\w-]+\.[\w-]+$/);
        expect(one).not.toBe(two);
        expect(one).not.toContain(token);
        expect(decrypt_token(one)).toBe(token);
        expect(decrypt_token(two)).toBe(token);
    });

    it('rejects a tampered value, a value from another key and an unknown format', () => {
        const enc = encrypt_token('secret-token');
        const parts = enc.split('.');
        const ct = Buffer.from(parts[3], 'base64url');
        ct[0] ^= 0xff;
        expect(() => decrypt_token([parts[0], parts[1], parts[2], ct.toString('base64url')].join('.'))).toThrow();
        expect(() => decrypt_token(enc, crypto.randomBytes(32))).toThrow();
        expect(() => decrypt_token('plain-text')).toThrow('Unrecognised encrypted token format');
    });

    it('issue_token returns the token with its stored forms', () => {
        const issued = issue_token();
        expect(issued.token_hash).toBe(hash_token(issued.token));
        expect(decrypt_token(issued.token_enc)).toBe(issued.token);
    });

    it('fails clearly when TOKEN_ENCRYPTION_KEY is missing', () => {
        delete process.env.TOKEN_ENCRYPTION_KEY;
        expect(() => encrypt_token('x')).toThrow('TOKEN_ENCRYPTION_KEY');
    });
});

describe('TOKEN_ENCRYPTION_KEY / PUBLIC_APP_URL', () => {
    let restore: () => void;
    beforeEach(() => { restore = use_test_link_env(); });
    afterEach(() => restore());

    it('accepts 64 hex characters or base64 / base64url of 32 bytes', () => {
        const key = crypto.randomBytes(32);
        expect(parse_token_encryption_key(key.toString('hex')).equals(key)).toBe(true);
        expect(parse_token_encryption_key(key.toString('base64')).equals(key)).toBe(true);
        expect(parse_token_encryption_key(key.toString('base64url')).equals(key)).toBe(true);
        expect(token_encryption_key().equals(Buffer.from(TEST_TOKEN_ENCRYPTION_KEY, 'hex'))).toBe(true);
    });

    it('rejects keys of the wrong length', () => {
        expect(() => parse_token_encryption_key('abcd')).toThrow('32 bytes');
        expect(() => parse_token_encryption_key(crypto.randomBytes(16).toString('base64'))).toThrow('32 bytes');
    });

    it('PUBLIC_APP_URL must be http(s); a trailing slash is dropped', () => {
        process.env.PUBLIC_APP_URL = 'https://app.example.test/';
        expect(public_app_url()).toBe('https://app.example.test');
        process.env.PUBLIC_APP_URL = 'ftp://nope';
        expect(() => public_app_url()).toThrow('http(s)');
        delete process.env.PUBLIC_APP_URL;
        expect(() => public_app_url()).toThrow('PUBLIC_APP_URL');
    });
});

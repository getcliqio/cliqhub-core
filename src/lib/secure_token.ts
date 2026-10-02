/**
 * One-time link tokens (invite, set-password, reset-password).
 *
 * A token is a random URL-safe string that only ever travels inside a link.
 * The database keeps two forms of it:
 *
 *   - `token_hash` — SHA-256 hex of the token, for lookup when a link is opened;
 *   - `token_enc`  — the token encrypted with AES-256-GCM under
 *     `TOKEN_ENCRYPTION_KEY`, so reminders and "send again" can rebuild the
 *     same link at delivery time.
 *
 * Neither the token nor a link built from it is ever logged, stored in an
 * event row or returned by the API; the only exception is the `invite_url` /
 * `setup_url` / `reset_url` a response carries when the email could not be sent.
 *
 * The encrypted form is `v1.<iv>.<tag>.<ciphertext>`, each part base64url.
 */

import crypto from 'node:crypto';

import { token_encryption_key } from '../config/env.js';

const TOKEN_BYTES = 32;
const IV_BYTES = 12;
const FORMAT_VERSION = 'v1';

/** A freshly issued token with the two forms that are stored. */
export interface IssuedToken {
    /** The raw token: put it in the link, never store or log it. */
    token: string;
    /** SHA-256 hex of the token (lookup column). */
    token_hash: string;
    /** AES-256-GCM encrypted token (rebuild-the-link column). */
    token_enc: string;
}

/**
 * Generates a random URL-safe token (base64url, 256 bits).
 */
export function generate_token(): string {
    return crypto.randomBytes(TOKEN_BYTES).toString('base64url');
}

/**
 * SHA-256 hex digest of a token, as stored in `token_hash` columns.
 *
 * @param token - The raw token from a link.
 */
export function hash_token(token: string): string {
    return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Encrypts a token with AES-256-GCM under `TOKEN_ENCRYPTION_KEY`.
 *
 * @param token - The raw token.
 * @param key - 32-byte key; defaults to the configured `TOKEN_ENCRYPTION_KEY`.
 * @throws Error when no valid key is configured.
 */
export function encrypt_token(token: string, key: Buffer = token_encryption_key()): string {
    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [FORMAT_VERSION, iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join('.');
}

/**
 * Decrypts a value produced by {@link encrypt_token}.
 *
 * @param token_enc - The stored `token_enc` value.
 * @param key - 32-byte key; defaults to the configured `TOKEN_ENCRYPTION_KEY`.
 * @throws Error when the value is malformed, was encrypted under another key
 *   or was tampered with, or when no valid key is configured.
 */
export function decrypt_token(token_enc: string, key: Buffer = token_encryption_key()): string {
    const parts = token_enc.split('.');
    if (parts.length !== 4 || parts[0] !== FORMAT_VERSION) {
        throw new Error('Unrecognised encrypted token format');
    }
    const [, iv_b64, tag_b64, ct_b64] = parts;
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv_b64, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag_b64, 'base64url'));
    const plain = Buffer.concat([decipher.update(Buffer.from(ct_b64, 'base64url')), decipher.final()]);
    return plain.toString('utf8');
}

/**
 * Issues a new token with its hash and encrypted copy, ready to store.
 *
 * @param key - 32-byte key; defaults to the configured `TOKEN_ENCRYPTION_KEY`.
 * @throws Error when no valid key is configured.
 */
export function issue_token(key: Buffer = token_encryption_key()): IssuedToken {
    const token = generate_token();
    return { token, token_hash: hash_token(token), token_enc: encrypt_token(token, key) };
}

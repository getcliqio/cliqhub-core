import { describe, it, expect } from 'vitest';
import { hash_password, verify_password } from '../../../src/auth/password.js';

describe('password', () => {
    it('hash_password returns a bcrypt hash', async () => {
        const hash = await hash_password('mypassword');
        expect(hash).toMatch(/^\$2[aby]\$/);
    });

    it('verify_password returns true for matching password', async () => {
        const hash = await hash_password('mypassword');
        const result = await verify_password('mypassword', hash);
        expect(result).toBe(true);
    });

    it('verify_password returns false for wrong password', async () => {
        const hash = await hash_password('mypassword');
        const result = await verify_password('wrongpassword', hash);
        expect(result).toBe(false);
    });

    it('hash_password produces different hashes for same input', async () => {
        const hash1 = await hash_password('mypassword');
        const hash2 = await hash_password('mypassword');
        expect(hash1).not.toBe(hash2);
    });
});

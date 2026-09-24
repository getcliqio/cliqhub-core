import { describe, it, expect } from 'vitest';
import { hub_legacy_uuid } from '../../../src/lib/hub_legacy_uuid.js';
import { sign_token, verify_token } from '../../../src/auth/jwt.js';

const SECRET = 'test-secret-key';

describe('jwt', () => {
    it('sign_token returns a valid JWT string', () => {
        const token = sign_token({ user_id: hub_legacy_uuid(1), username: 'alice', role: 'user' }, SECRET);
        expect(typeof token).toBe('string');
        expect(token.split('.')).toHaveLength(3);
    });

    it('verify_token decodes payload with user_id, username, role', () => {
        const token = sign_token({ user_id: hub_legacy_uuid(1), username: 'alice', role: 'user' }, SECRET);
        const payload = verify_token(token, SECRET);
        expect(payload.user_id).toBe(hub_legacy_uuid(1));
        expect(payload.username).toBe('alice');
        expect(payload.role).toBe('user');
    });

    it('verify_token throws for expired token', () => {
        const token = sign_token({ user_id: hub_legacy_uuid(1), username: 'alice', role: 'user' }, SECRET, '0s');
        expect(() => verify_token(token, SECRET)).toThrow();
    });

    it('verify_token throws for invalid token string', () => {
        expect(() => verify_token('not-a-jwt', SECRET)).toThrow();
    });

    it('verify_token throws for token signed with wrong secret', () => {
        const token = sign_token({ user_id: hub_legacy_uuid(1), username: 'alice', role: 'user' }, SECRET);
        expect(() => verify_token(token, 'wrong-secret')).toThrow();
    });

    it('sign_token includes iat and exp claims', () => {
        const token = sign_token({ user_id: hub_legacy_uuid(1), username: 'alice', role: 'user' }, SECRET);
        const parts = token.split('.');
        const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
        expect(payload.iat).toBeDefined();
        expect(payload.exp).toBeDefined();
        expect(payload.exp).toBeGreaterThan(payload.iat);
    });
});

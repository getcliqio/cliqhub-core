import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { create_test_app } from '../helpers/test_container.js';

const { app } = create_test_app();

describe('GET /v1/health', () => {
    it('returns 200 with ok + timestamp', async () => {
        const res = await request(app).get('/v1/health');
        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
        expect(typeof res.body.timestamp).toBe('number');
    });

    it('returns correct content-type application/json', async () => {
        const res = await request(app).get('/v1/health');
        expect(res.headers['content-type']).toMatch(/json/);
    });

    it('root /health is removed', async () => {
        const res = await request(app).get('/health');
        expect(res.status).toBe(404);
    });

    it('returns 404 for unknown routes', async () => {
        const res = await request(app).get('/nonexistent');
        expect(res.status).toBe(404);
    });
});

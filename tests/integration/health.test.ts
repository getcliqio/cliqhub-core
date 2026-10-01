import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { create_test_app } from '../helpers/test_container.js';
import { CORE_API_VERSION } from '../../src/lib/api_version.js';

const { app } = create_test_app();

describe('GET /v1/health', () => {
    it('returns 200 with ok + timestamp', async () => {
        const res = await request(app).get('/v1/health');
        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
        expect(typeof res.body.timestamp).toBe('number');
    });

    it('reports version, api_version and started_at', async () => {
        const res = await request(app).get('/v1/health');
        expect(res.body.api_version).toBe(CORE_API_VERSION);
        expect(Number.isInteger(res.body.api_version)).toBe(true);
        expect(typeof res.body.version).toBe('string');
        expect(typeof res.body.started_at).toBe('number');
        expect(res.body.started_at).toBeLessThanOrEqual(Date.now());
    });

    it('unknown /v1 routes: JSON 404 with route_not_found and the method + path', async () => {
        const res = await request(app).post('/v1/no_such/thing?x=1').send({});
        expect(res.status).toBe(404);
        expect(res.headers['content-type']).toMatch(/json/);
        expect(res.body).toEqual({ ok: false, error: { code: 'route_not_found', message: 'Unknown API route: POST /v1/no_such/thing' } });
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

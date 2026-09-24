/**
 * Slice F/G smoke — /v1 is live; /api is gone (no redirects).
 */

import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { create_test_app } from '../helpers/test_container.js';

const { app } = create_test_app();

describe('API prefix cutover (F/G)', () => {
    it('GET /v1/health returns ok', async () => {
        const res = await request(app).get('/v1/health');
        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
    });

    it('POST /api/auth/login is 404 (no legacy surface)', async () => {
        const res = await request(app)
            .post('/api/auth/login')
            .send({ username: 'x', password: 'y' });
        expect(res.status).toBe(404);
    });

    it('POST /api/teams/get is 404', async () => {
        const res = await request(app).post('/api/teams/get').send({});
        expect(res.status).toBe(404);
    });
});

/**
 * Audit log reads on live Postgres: details come back as objects, and facets
 * count entries per action, target type and admin under the other filters.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Op } from 'sequelize';

import { postgres_reachable } from '../migrated_platform/helpers/control_plane_store.js';
import { open_live_hub_app, close_live_hub_app } from '../migrated_platform/helpers/live_hub_app.js';
import { AuditLog, User } from '../../src/models/index.js';
import { AuditRepository } from '../../src/repositories/audit_repository.js';

const has_postgres = await postgres_reachable();

describe.skipIf(!has_postgres)('audit log facets', () => {
    const repo = new AuditRepository();
    const stamp = randomUUID().slice(0, 8);
    const target = `af-${stamp}`;
    let admin_id: string;

    beforeAll(async () => {
        await open_live_hub_app();
        const u = await User.create({ username: `afadmin${stamp}`, email: `af${stamp}@x.test`, password_hash: 'x', role: 'admin', status: 'active' } as never);
        admin_id = String((u as unknown as { id: string }).id);
        await repo.create(admin_id, 'user.suspend', 'user', target, { username: 'bob', reason: 'spam' });
        await repo.create(admin_id, 'user.suspend', 'user', target, { username: 'bob' });
        await repo.create(admin_id, 'org.delete', 'org', target, { slug: 'acme' });
    }, 300_000);

    afterAll(async () => {
        await AuditLog.destroy({ where: { target_id: target } });
        await User.destroy({ where: { id: { [Op.in]: [admin_id] } }, force: true } as never);
        await close_live_hub_app();
    }, 300_000);

    it('returns details as objects', async () => {
        const rows = await repo.list_paginated({ target_id: target }, 10, 0);
        expect(rows.map((r) => r.details)).toEqual(expect.arrayContaining([{ slug: 'acme' }, { username: 'bob', reason: 'spam' }]));
    });

    it('counts per action, target type and admin; a field’s own filter does not narrow its counts', async () => {
        const f = await repo.facets({ target_id: target, action: 'user.suspend' });
        expect(f.action).toEqual(expect.arrayContaining([{ value: 'user.suspend', label: 'user.suspend', count: 2 }, { value: 'org.delete', label: 'org.delete', count: 1 }]));
        expect(f.target_type).toEqual([{ value: 'user', label: 'user', count: 2 }]);
        expect(f.admin).toEqual([{ value: admin_id, label: `afadmin${stamp}`, count: 2 }]);
    });
});

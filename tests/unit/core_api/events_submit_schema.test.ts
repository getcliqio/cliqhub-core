import { describe, it, expect } from 'vitest';

import {
	event_submit_schema,
	required_fields_for,
} from '../../../src/schemas/event_types.js';

describe('required_fields_for', () => {
	it('maps run / phase / hug / daemon / realm / team families', () => {
		expect(required_fields_for('run.failed')).toEqual(['realm_id', 'run_id', 'daemon_id']);
		expect(required_fields_for('phase.escalated')).toEqual([
			'realm_id', 'run_id', 'phase', 'daemon_id',
		]);
		expect(required_fields_for('hug.review_requested')).toEqual([
			'realm_id', 'run_id', 'daemon_id',
		]);
		expect(required_fields_for('daemon.enrolled')).toEqual(['realm_id', 'daemon_id']);
		expect(required_fields_for('realm.created')).toEqual(['realm_id']);
		expect(required_fields_for('team.published')).toEqual(['team']);
		expect(required_fields_for('auth.api_key_created')).toEqual([]);
		expect(required_fields_for('notification.test')).toEqual([]);
	});
});

describe('event_submit_schema', () => {
	it('rejects unknown event types', () => {
		const result = event_submit_schema.safeParse({ type: 'phase.stuck' });
		expect(result.success).toBe(false);
		if (result.success) return;
		expect(result.error.issues.some((i) => i.path[0] === 'type')).toBe(true);
	});

	it('rejects run.* without realm_id / run_id / daemon_id', () => {
		const result = event_submit_schema.safeParse({ type: 'run.failed' });
		expect(result.success).toBe(false);
		if (result.success) return;
		const paths = result.error.issues.map((i) => i.path[0]);
		expect(paths).toContain('realm_id');
		expect(paths).toContain('run_id');
		expect(paths).toContain('daemon_id');
	});

	it('rejects empty-string required fields', () => {
		const result = event_submit_schema.safeParse({
			type: 'run.failed',
			realm_id: '  ',
			run_id: 'run-1',
			daemon_id: 'd-1',
		});
		expect(result.success).toBe(false);
		if (result.success) return;
		expect(result.error.issues.some((i) => i.path[0] === 'realm_id')).toBe(true);
	});

	it('accepts a complete run.failed payload', () => {
		const result = event_submit_schema.safeParse({
			type: 'run.failed',
			realm_id: 'realm-1',
			run_id: 'run-1',
			daemon_id: 'daemon-1',
			message: 'boom',
		});
		expect(result.success).toBe(true);
	});

	it('requires phase for phase.*', () => {
		const result = event_submit_schema.safeParse({
			type: 'phase.escalated',
			realm_id: 'realm-1',
			run_id: 'run-1',
			daemon_id: 'daemon-1',
		});
		expect(result.success).toBe(false);
		if (result.success) return;
		expect(result.error.issues.some((i) => i.path[0] === 'phase')).toBe(true);
	});

	it('refuses the retired events: a phase that needs a person posts its own Hug (PLAN-notifications-v2 B4.5)', () => {
		for (const type of ['phase.input_required', 'hug.review_requested']) {
			expect(event_submit_schema.safeParse({
				type, realm_id: 'realm-1', run_id: 'run-1', daemon_id: 'daemon-1', phase: 'implement',
				payload: { kind: 'requested_inputs', summary: 'Pick target env' },
			}).success).toBe(false);
		}
	});

	it('rejects underscored lifecycle aliases', () => {
		expect(event_submit_schema.safeParse({
			type: 'phase_awaiting_input',
			realm_id: 'r', run_id: 'x', daemon_id: 'd', phase: 'p',
		}).success).toBe(false);
		expect(event_submit_schema.safeParse({
			type: 'on_input_required',
			realm_id: 'r', run_id: 'x', daemon_id: 'd', phase: 'p',
		}).success).toBe(false);
	});
});

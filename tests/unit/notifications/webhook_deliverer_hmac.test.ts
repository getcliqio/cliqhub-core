import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHmac } from 'node:crypto';

import {
	WebhookDeliverer,
	sign_webhook_body,
} from '../../../src/notifications/deliverers/webhook_deliverer.js';
import type { NotificationPayload } from '../../../src/notifications/types.js';

const url = 'https://receiver.example.com/hook';
const base_payload: NotificationPayload = {
	event: 'run.completed',
	title: 'test',
	message: 'body',
	realm_id: 'r_test',
	run_id: 'run_test_1',
};

let fetch_calls: Array<{ url: string; init: RequestInit }>;

beforeEach(() => {
	fetch_calls = [];
	vi.stubGlobal('fetch', vi.fn(async (u: string, init: RequestInit) => {
		fetch_calls.push({ url: u, init });
		return { ok: true, status: 200 } as Response;
	}));
});

afterEach(() => {
	vi.unstubAllGlobals();
});

function last_headers(): Record<string, string> {
	const init = fetch_calls[fetch_calls.length - 1]?.init;
	return (init?.headers ?? {}) as Record<string, string>;
}

function last_body(): string {
	return String(fetch_calls[fetch_calls.length - 1]?.init.body ?? '');
}

describe('WebhookDeliverer — HMAC signing', () => {

	it('sends no signature headers when config.secret is absent', async () => {
		const deliverer = new WebhookDeliverer();

		await deliverer.deliver({ url }, base_payload);

		const headers = last_headers();
		expect(headers['Content-Type']).toBe('application/json');
		expect(headers['X-Cliq-Signature']).toBeUndefined();
		expect(headers['X-Cliq-Timestamp']).toBeUndefined();
		expect(headers['X-Cliq-Delivery']).toBeUndefined();
		expect(headers['X-Cliq-Event']).toBeUndefined();
	});

	it('sends signature headers when config.secret is a non-empty string', async () => {
		const deliverer = new WebhookDeliverer();

		await deliverer.deliver({ url, secret: 'whsec_test_abc' }, base_payload);

		const headers = last_headers();
		expect(headers['X-Cliq-Event']).toBe('run.completed');
		expect(headers['X-Cliq-Delivery']).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
		);
		expect(headers['X-Cliq-Timestamp']).toMatch(/^\d{10}$/);
		expect(headers['X-Cliq-Signature']).toMatch(/^sha256=[0-9a-f]{64}$/);
	});

	it('signature verifies against Node crypto over timestamp + "." + body', async () => {
		const deliverer = new WebhookDeliverer();
		const secret = 'whsec_verify_me';

		await deliverer.deliver({ url, secret }, base_payload);

		const headers = last_headers();
		const body = last_body();
		const timestamp = headers['X-Cliq-Timestamp'];
		const signature = headers['X-Cliq-Signature'];

		const expected = 'sha256=' + createHmac('sha256', secret)
			.update(`${timestamp}.${body}`)
			.digest('hex');
		expect(signature).toBe(expected);
	});

	it('empty-string secret is treated as no-secret (does not sign)', async () => {
		const deliverer = new WebhookDeliverer();

		await deliverer.deliver({ url, secret: '' }, base_payload);

		const headers = last_headers();
		expect(headers['X-Cliq-Signature']).toBeUndefined();
	});

	it('non-string secret is ignored (does not sign, does not throw)', async () => {
		const deliverer = new WebhookDeliverer();

		await deliverer.deliver({ url, secret: 12345 } as Record<string, unknown>, base_payload);

		const headers = last_headers();
		expect(headers['X-Cliq-Signature']).toBeUndefined();
	});

	it('user-supplied headers cannot forge X-Cliq-Signature', async () => {
		const deliverer = new WebhookDeliverer();

		await deliverer.deliver({
			url,
			secret: 'whsec_1',
			headers: { 'X-Cliq-Signature': 'sha256=deadbeef' },
		}, base_payload);

		const headers = last_headers();
		expect(headers['X-Cliq-Signature']).not.toBe('sha256=deadbeef');
		expect(headers['X-Cliq-Signature']).toMatch(/^sha256=[0-9a-f]{64}$/);
	});

	it('user-supplied non-signing headers pass through', async () => {
		const deliverer = new WebhookDeliverer();

		await deliverer.deliver({
			url,
			headers: { Authorization: 'Bearer downstream-token', 'X-Trace-Id': 't-1' },
		}, base_payload);

		const headers = last_headers();
		expect(headers['Authorization']).toBe('Bearer downstream-token');
		expect(headers['X-Trace-Id']).toBe('t-1');
	});
});

describe('sign_webhook_body — pure', () => {

	it('matches a hand-computed HMAC-SHA256', () => {
		const secret = 'topsecret';
		const timestamp = '1700000000';
		const body = '{"event":"run.completed"}';

		const got = sign_webhook_body(secret, body, timestamp);
		const expected = 'sha256=' + createHmac('sha256', secret)
			.update(`${timestamp}.${body}`)
			.digest('hex');
		expect(got).toBe(expected);
	});

	it('same inputs → same signature (deterministic)', () => {
		const a = sign_webhook_body('s', 'b', '1');
		const b = sign_webhook_body('s', 'b', '1');
		expect(a).toBe(b);
	});

	it('different timestamps → different signatures', () => {
		const a = sign_webhook_body('s', 'b', '1');
		const b = sign_webhook_body('s', 'b', '2');
		expect(a).not.toBe(b);
	});
});

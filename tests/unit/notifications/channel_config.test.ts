import { describe, it, expect } from 'vitest';

import { ApiError } from '../../../src/lib/api_error.js';
import {
	mask_channel_config,
	parse_channel_config,
	destination_schema,
	destinations_array_schema,
	parse_destinations,
} from '../../../src/notifications/channel_config.js';

describe('parse_channel_config', () => {
	it('accepts valid slack config', () => {
		const config = parse_channel_config('slack', {
			webhook_url: 'https://hooks.slack.com/services/T/B/X',
		});
		expect(config.webhook_url).toContain('hooks.slack.com');
	});

	it('rejects slack without webhook_url', () => {
		expect(() => parse_channel_config('slack', {})).toThrow(ApiError);
	});

	it('accepts valid email config (recipients only)', () => {
		const config = parse_channel_config('email', {
			to: 'ops@example.com',
			cc: 'lead@example.com',
			bcc: 'audit@example.com',
		});
		expect(config.to).toBe('ops@example.com');
		expect(config.cc).toBe('lead@example.com');
		expect(config.bcc).toBe('audit@example.com');
	});

	it('rejects email missing to', () => {
		expect(() => parse_channel_config('email', { cc: 'a@b.c' })).toThrow(ApiError);
	});

	it('rejects email smtp fields (Hub-owned transport)', () => {
		expect(() => parse_channel_config('email', {
			to: 'ops@example.com',
			smtp_host: 'smtp.example.com',
		})).toThrow(ApiError);
	});

	it('accepts webhook with headers', () => {
		const config = parse_channel_config('webhook', {
			url: 'https://example.com/hook',
			headers: { Authorization: 'Bearer x' },
		});
		expect(config.url).toBe('https://example.com/hook');
	});

	it('accepts empty cliqhub config', () => {
		expect(parse_channel_config('cliqhub', {})).toEqual({});
	});

	it('rejects unknown provider', () => {
		expect(() => parse_channel_config('pagerduty', {})).toThrow(/Unknown notification provider/);
	});

	it('rejects unknown keys (strict)', () => {
		expect(() => parse_channel_config('cliqhub', { extra: 1 })).toThrow(ApiError);
	});
});

describe('mask_channel_config', () => {
	it('masks slack webhook path', () => {
		const masked = mask_channel_config('slack', {
			webhook_url: 'https://hooks.slack.com/services/secret',
		});
		expect(masked.webhook_url).toBe('https://hooks.slack.com/***');
	});

	it('masks email password when present', () => {
		const masked = mask_channel_config('email', {
			to: 'a@b.c',
			password: 'secret',
		});
		expect(masked.password).toBe('***');
		expect(masked.to).toBe('a@b.c');
	});
});


describe('destination_schema (v2)', () => {

	it('accepts slack destination', () => {
		const result = destination_schema.safeParse({
			type: 'slack',
			webhook_url: 'https://hooks.slack.com/services/T/B/X',
		});
		expect(result.success).toBe(true);
	});

	it('accepts email destination', () => {
		const result = destination_schema.safeParse({
			type: 'email',
			address: 'ops@example.com',
			cc: 'lead@example.com',
		});
		expect(result.success).toBe(true);
	});

	it('accepts webhook destination', () => {
		const result = destination_schema.safeParse({
			type: 'webhook',
			url: 'https://example.com/hook',
			headers: { Authorization: 'Bearer x' },
		});
		expect(result.success).toBe(true);
	});

	it('accepts http destination', () => {
		const result = destination_schema.safeParse({
			type: 'http',
			url: 'https://api.example.com/notify',
			method: 'PUT',
		});
		expect(result.success).toBe(true);
	});

	it('accepts jira destination', () => {
		const result = destination_schema.safeParse({
			type: 'jira',
			url: 'https://jira.example.com',
			project_key: 'OPS',
			issue_type: 'Task',
		});
		expect(result.success).toBe(true);
	});

	it('accepts channel_ref destination', () => {
		const result = destination_schema.safeParse({
			type: 'channel_ref',
			name: 'ops-team',
		});
		expect(result.success).toBe(true);
	});

	it('accepts cliqhub destination', () => {
		const result = destination_schema.safeParse({ type: 'cliqhub' });
		expect(result.success).toBe(true);
	});

	it('rejects unknown type', () => {
		const result = destination_schema.safeParse({ type: 'pagerduty' });
		expect(result.success).toBe(false);
	});

	it('rejects slack without webhook_url', () => {
		const result = destination_schema.safeParse({ type: 'slack' });
		expect(result.success).toBe(false);
	});

	it('rejects email without address', () => {
		const result = destination_schema.safeParse({ type: 'email' });
		expect(result.success).toBe(false);
	});

	it('rejects jira without project_key', () => {
		const result = destination_schema.safeParse({
			type: 'jira',
			url: 'https://jira.example.com',
			issue_type: 'Task',
		});
		expect(result.success).toBe(false);
	});
});


describe('destinations_array_schema', () => {

	it('accepts array with one destination', () => {
		const result = destinations_array_schema.safeParse([
			{ type: 'cliqhub' },
		]);
		expect(result.success).toBe(true);
	});

	it('accepts mixed destination types', () => {
		const result = destinations_array_schema.safeParse([
			{ type: 'slack', webhook_url: 'https://hooks.slack.com/T/B/X' },
			{ type: 'email', address: 'ops@co.com' },
			{ type: 'channel_ref', name: 'pager' },
		]);
		expect(result.success).toBe(true);
	});

	it('rejects empty array', () => {
		const result = destinations_array_schema.safeParse([]);
		expect(result.success).toBe(false);
	});
});


describe('parse_destinations', () => {

	it('validates and returns typed destinations', () => {
		const dests = parse_destinations([
			{ type: 'slack', webhook_url: 'https://hooks.slack.com/T/B/X' },
		]);
		expect(dests).toHaveLength(1);
		expect(dests[0].type).toBe('slack');
	});

	it('throws ApiError on invalid input', () => {
		expect(() => parse_destinations([{ type: 'bogus' }])).toThrow();
	});
});

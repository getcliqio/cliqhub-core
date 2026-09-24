import { z, type ZodTypeAny } from 'zod';

import { ApiError } from '../lib/api_error.js';
import {
	CHANNEL_PROVIDERS,
	is_channel_provider,
	type ChannelProvider,
} from './types.js';

// ---------------------------------------------------------------------------
// Legacy single-provider config schemas (backward compat)
// ---------------------------------------------------------------------------

const slack_config_schema = z.object({
	webhook_url: z.string().url(),
}).strict();

const email_config_schema = z.object({
	to: z.string().min(1),
	cc: z.string().optional(),
	bcc: z.string().optional(),
}).strict();

const webhook_config_schema = z.object({
	url: z.string().url(),
	headers: z.record(z.string()).optional(),
	// Optional shared secret. When present, WebhookDeliverer signs each
	// POST with X-Cliq-Signature so the receiver can verify authenticity.
	// Slice 1.2 will migrate this into a dedicated column; for now it
	// rides in the JSON blob to keep the schema change minimal.
	secret: z.string().min(1).optional(),
}).strict();

const cliqhub_config_schema = z.object({}).strict();

export const CONFIG_SCHEMA_BY_PROVIDER: Record<ChannelProvider, ZodTypeAny> = {
	slack: slack_config_schema,
	email: email_config_schema,
	webhook: webhook_config_schema,
	cliqhub: cliqhub_config_schema,
};

// ---------------------------------------------------------------------------
// Destination schemas (v2 — multi-destination channels)
// ---------------------------------------------------------------------------

const slack_destination = z.object({
	type: z.literal('slack'),
	webhook_url: z.string().url(),
});

const email_destination = z.object({
	type: z.literal('email'),
	address: z.string().min(1),
	cc: z.string().optional(),
	bcc: z.string().optional(),
});

const webhook_destination = z.object({
	type: z.literal('webhook'),
	url: z.string().url(),
	headers: z.record(z.string()).optional(),
});

const http_destination = z.object({
	type: z.literal('http'),
	url: z.string().url(),
	method: z.enum(['POST', 'PUT']).optional().default('POST'),
	headers: z.record(z.string()).optional(),
});

const jira_destination = z.object({
	type: z.literal('jira'),
	url: z.string().url(),
	project_key: z.string().min(1),
	issue_type: z.string().min(1),
	auth_header: z.string().optional(),
});

const channel_ref_destination = z.object({
	type: z.literal('channel_ref'),
	name: z.string().min(1),
});

const cliqhub_destination = z.object({
	type: z.literal('cliqhub'),
});

export const destination_schema = z.discriminatedUnion('type', [
	slack_destination,
	email_destination,
	webhook_destination,
	http_destination,
	jira_destination,
	channel_ref_destination,
	cliqhub_destination,
]);

export type Destination = z.infer<typeof destination_schema>;

export const destinations_array_schema = z.array(destination_schema).min(1);

/** All recognized destination type strings. */
export const DESTINATION_TYPES = [
	'slack', 'email', 'webhook', 'http', 'jira', 'channel_ref', 'cliqhub',
] as const;
export type DestinationType = (typeof DESTINATION_TYPES)[number];

/**
 * Validate a destinations array. Throws `ApiError` on failure.
 */
export function parse_destinations(raw: unknown[]): Destination[] {
	const result = destinations_array_schema.safeParse(raw);
	if (result.success) return result.data;

	const messages = result.error.issues
		.map((i) => `${i.path.join('.') || 'destinations'}: ${i.message}`)
		.join('; ');
	throw ApiError.bad_request(`Invalid destinations: ${messages}`);
}

export function parse_channel_config(
	provider: string,
	config: Record<string, unknown>,
): Record<string, unknown> {
	if (!is_channel_provider(provider)) {
		throw ApiError.bad_request(
			`Unknown notification provider '${provider}'. `
			+ `Must be one of: ${CHANNEL_PROVIDERS.join(', ')}`,
		);
	}

	const schema = CONFIG_SCHEMA_BY_PROVIDER[provider];
	const result = schema.safeParse(config ?? {});
	if (result.success) {
		return result.data as Record<string, unknown>;
	}

	const messages = result.error.issues
		.map((i) => `${i.path.join('.') || 'config'}: ${i.message}`)
		.join('; ');
	throw ApiError.bad_request(
		`Invalid config for provider '${provider}': ${messages}`,
	);
}

const SECRET_KEYS = new Set(['password', 'webhook_url', 'url']);

export function mask_channel_config(
	provider: ChannelProvider,
	config: Record<string, unknown>,
): Record<string, unknown> {
	const masked: Record<string, unknown> = { ...config };

	if (typeof masked.password === 'string' && masked.password.length > 0) {
		masked.password = '***';
	}

	if (provider === 'slack' && typeof masked.webhook_url === 'string') {
		masked.webhook_url = mask_url(masked.webhook_url);
	}

	if (provider === 'webhook' && typeof masked.url === 'string') {
		masked.url = mask_url(masked.url);
	}

	if (provider === 'webhook' && typeof masked.secret === 'string' && masked.secret.length > 0) {
		masked.secret = '***';
	}

	const headers = masked.headers;
	if (headers && typeof headers === 'object' && !Array.isArray(headers)) {
		const out: Record<string, string> = {};
		for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
			if (typeof value !== 'string') continue;
			out[key] = SECRET_KEYS.has(key.toLowerCase()) || /token|secret|auth/i.test(key)
				? '***'
				: value;
		}
		masked.headers = out;
	}

	return masked;
}

function mask_url(url: string): string {
	try {
		const parsed = new URL(url);
		return `${parsed.origin}/***`;
	} catch {
		return '***';
	}
}

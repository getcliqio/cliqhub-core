/**
 * Human-friendly adj-noun slugs (e.g. bold-meadow).
 */

import { faker } from '@faker-js/faker';

function slug_token(raw: string): string {
	const cleaned = raw
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '')
		.slice(0, 16);
	return cleaned || 'x';
}

export function generate_slug(): string {
	const adj = slug_token(faker.word.adjective());
	const noun = slug_token(faker.word.noun());
	return `${adj}-${noun}`;
}

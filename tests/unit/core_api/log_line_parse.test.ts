import { describe, expect, it } from 'vitest';

import { parse_log_level, split_log_chunk } from '../../../src/lib/log_line_parse.js';

describe('log_line_parse', () => {
	it('splits chunk into non-empty lines', () => {
		expect(split_log_chunk('a\nb\n\nc\n')).toEqual(['a', 'b', 'c']);
	});

	it('detects levels heuristically', () => {
		expect(parse_log_level('ERROR boom')).toBe('error');
		expect(parse_log_level('warn: slow')).toBe('warn');
		expect(parse_log_level('debug detail')).toBe('debug');
		expect(parse_log_level('hello world')).toBe('info');
	});
});

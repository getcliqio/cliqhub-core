/**
 * Parse opaque log chunks into searchable lines with a heuristic level.
 */

const LEVEL_RE = /\b(error|err|warn|warning|info|debug|trace|fatal|critical)\b/i;

export type Log_level = 'error' | 'warn' | 'info' | 'debug';

export function parse_log_level(line: string): Log_level {
	const match = line.match(LEVEL_RE);
	if (!match) return 'info';
	const raw = match[1].toLowerCase();
	if (raw === 'error' || raw === 'err' || raw === 'fatal' || raw === 'critical') return 'error';
	if (raw === 'warn' || raw === 'warning') return 'warn';
	if (raw === 'debug' || raw === 'trace') return 'debug';
	return 'info';
}

export function split_log_chunk(chunk: string): string[] {
	if (!chunk) return [];
	return chunk.split(/\r?\n/).filter((line) => line.length > 0);
}

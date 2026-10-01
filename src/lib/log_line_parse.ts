/**
 * LogLineParser — log-level detection and run-log chunk splitting.
 *
 * `parse_level` scans a raw log line for a severity keyword (error, warn,
 * info, debug, …) and returns the normalised `Log_level`.
 *
 * `split_chunk` breaks a multi-line log chunk into individual log-line
 * records, each carrying its own detected level and content.
 */

const LEVEL_RE = /\b(error|err|warn|warning|info|debug|trace|fatal|critical)\b/i;

export type Log_level = 'error' | 'warn' | 'info' | 'debug';

export class LogLineParser {
    /**
     * Detect the severity level from a single log line.
     *
     * Scans for keywords (`error`, `warn`, `info`, `debug`, `fatal`, …).
     * Returns `'info'` when no keyword is found.
     *
     * @param line - Raw log line text.
     */
    static parse_level(line: string): Log_level {
        const match = line.match(LEVEL_RE);
        if (!match) return 'info';
        const raw = match[1].toLowerCase();
        if (raw === 'error' || raw === 'err' || raw === 'fatal' || raw === 'critical') return 'error';
        if (raw === 'warn' || raw === 'warning') return 'warn';
        if (raw === 'debug' || raw === 'trace') return 'debug';
        return 'info';
    }

    /**
     * Split a multi-line log chunk into individual non-empty lines.
     *
     * @param chunk - Raw string that may contain `\n` or `\r\n` line endings.
     * @returns Array of non-empty lines, preserving order.
     */
    static split_chunk(chunk: string): string[] {
        if (!chunk) return [];
        return chunk.split(/\r?\n/).filter((line) => line.length > 0);
    }
}

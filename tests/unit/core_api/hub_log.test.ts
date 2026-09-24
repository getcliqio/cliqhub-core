import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    configure_hub_logging,
    get_hub_log_level,
    get_logger,
} from '../../../src/lib/log.js';

describe('hub structured logger', () => {
    afterEach(() => {
        configure_hub_logging('error');
        vi.restoreAllMocks();
    });

    it('gates debug below info', () => {
        configure_hub_logging('info');
        expect(get_hub_log_level()).toBe('info');

        const info_spy = vi.spyOn(console, 'info').mockImplementation(() => {});
        const debug_spy = vi.spyOn(console, 'debug').mockImplementation(() => {});

        const log = get_logger('test');
        log.debug('hidden');
        log.info('visible', { a: 1 });

        expect(debug_spy).not.toHaveBeenCalled();
        expect(info_spy).toHaveBeenCalledTimes(1);
        const line = JSON.parse(String(info_spy.mock.calls[0][0]));
        expect(line).toMatchObject({
            level: 'INFO',
            component: 'test',
            msg: 'visible',
            ctx: { a: 1 },
        });
        expect(typeof line.ts).toBe('string');
    });

    it('emits warn and error', () => {
        configure_hub_logging('warn');
        const warn_spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const error_spy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const info_spy = vi.spyOn(console, 'info').mockImplementation(() => {});

        const log = get_logger('ops');
        log.info('nope');
        log.warn('careful');
        log.error('boom');

        expect(info_spy).not.toHaveBeenCalled();
        expect(warn_spy).toHaveBeenCalledTimes(1);
        expect(error_spy).toHaveBeenCalledTimes(1);
    });
});

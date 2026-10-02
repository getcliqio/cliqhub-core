/**
 * Fake link settings for tests that issue or rebuild invite / password links.
 * The key below is an obviously fake test value, never a real secret.
 */

/** 32 bytes of hex, fake. */
export const TEST_TOKEN_ENCRYPTION_KEY = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';

/** Fake web app base URL. */
export const TEST_PUBLIC_APP_URL = 'https://app.cliqhub.test';

/**
 * Sets `TOKEN_ENCRYPTION_KEY` and `PUBLIC_APP_URL` to the fake values.
 *
 * @returns A function that restores the previous values.
 */
export function use_test_link_env(): () => void {
    const prev = { key: process.env.TOKEN_ENCRYPTION_KEY, url: process.env.PUBLIC_APP_URL };
    process.env.TOKEN_ENCRYPTION_KEY = TEST_TOKEN_ENCRYPTION_KEY;
    process.env.PUBLIC_APP_URL = TEST_PUBLIC_APP_URL;
    return () => {
        if (prev.key === undefined) delete process.env.TOKEN_ENCRYPTION_KEY; else process.env.TOKEN_ENCRYPTION_KEY = prev.key;
        if (prev.url === undefined) delete process.env.PUBLIC_APP_URL; else process.env.PUBLIC_APP_URL = prev.url;
    };
}

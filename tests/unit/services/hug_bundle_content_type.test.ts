/**
 * Every file type a hug bundle may carry (cliq-sdk's rules) is served with its own content type, not the text/plain
 * fallback.
 */
import { describe, expect, it } from 'vitest';

import { bundle_content_type } from '../../../src/services/hug_bundles.service.js';

describe('bundle_content_type', () => {
    it.each([
        ['index.html', 'text/html'], ['page.htm', 'text/html'], ['assets/main.js', 'text/javascript'],
        ['definition.mjs', 'text/javascript'], ['legacy.cjs', 'text/javascript'], ['a.css', 'text/css'],
        ['hug.json', 'application/json'], ['main.js.map', 'application/json'], ['icon.svg', 'image/svg+xml'],
        ['notes.txt', 'text/plain'], ['README.md', 'text/markdown'], ['app.webmanifest', 'application/manifest+json'],
        ['INDEX.HTML', 'text/html'],
    ])('%s is %s', (path, type) => {
        expect(bundle_content_type(path).split(';')[0]).toBe(type);
    });
});

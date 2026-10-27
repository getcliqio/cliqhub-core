/**
 * R2Client (PLAN-hug-requests §6.6.5): SigV4 signing against AWS's published example, the requests
 * the client sends, and — only when `R2_ROUND_TRIP=1` with the `S3_*` settings from `.env` — a round
 * trip against the dev bucket.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';

import { R2Client, load_r2_config_from_env, sigv4_authorization } from '../../../src/lib/r2_client.js';

const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

describe('sigv4_authorization', () => {
    it("matches AWS's S3 example (GET Object with a Range header, header-based auth)", () => {
        // https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html — "Example: GET Object"
        const auth = sigv4_authorization({
            method: 'GET',
            canonical_uri: '/test.txt',
            headers: {
                host: 'examplebucket.s3.amazonaws.com',
                range: 'bytes=0-9',
                'x-amz-content-sha256': EMPTY_SHA256,
                'x-amz-date': '20130524T000000Z',
            },
            payload_hash: EMPTY_SHA256,
            date_stamp: '20130524T000000Z',
            region: 'us-east-1',
            service: 's3',
            access_key_id: 'AKIAIOSFODNN7EXAMPLE',
            secret_access_key: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
        });
        expect(auth).toBe(
            'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, '
            + 'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, '
            + 'Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
        );
    });
});

describe('R2Client requests', () => {
    afterEach(() => { vi.unstubAllGlobals(); });

    const client = new R2Client({ endpoint: 'https://acct.r2.test', bucket: 'cliq-artifacts', access_key_id: 'AK', secret_access_key: 'SK' });

    it('PUT streams the body with its real sha256, signed for R2 (region auto)', async () => {
        const fetch = vi.fn(async (_url: string, init: RequestInit) => {
            for await (const _ of init.body as unknown as AsyncIterable<Uint8Array>) { /* drain */ }
            return new Response(null, { status: 200 });
        });
        vi.stubGlobal('fetch', fetch);
        const sha = crypto.createHash('sha256').update('hi').digest('hex');
        await client.put_object_stream('a1', Readable.from([Buffer.from('hi')]), { content_length: 2, content_type: 'text/plain', sha256_hex: sha });
        const [url, init] = fetch.mock.calls[0]!;
        expect(url).toBe('https://acct.r2.test/cliq-artifacts/a1');
        const headers = init.headers as Record<string, string>;
        expect(headers['x-amz-content-sha256']).toBe(sha);
        expect(headers['Authorization']).toMatch(/^AWS4-HMAC-SHA256 Credential=AK\/\d{8}\/auto\/s3\/aws4_request, SignedHeaders=content-length;content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
    });

    it('GET passes Range through and returns the partial body; 404 is null', async () => {
        const fetch = vi.fn(async (_url: string, init: RequestInit) => {
            const range = (init.headers as Record<string, string>)['range'];
            return range
                ? new Response('ell', { status: 206, headers: { 'content-length': '3', 'content-type': 'text/plain', 'content-range': 'bytes 1-3/5' } })
                : new Response(null, { status: 404 });
        });
        vi.stubGlobal('fetch', fetch);
        const part = await client.get_object_stream('a1', { range: 'bytes=1-3' });
        expect(part).toMatchObject({ status: 206, content_length: 3, content_type: 'text/plain', content_range: 'bytes 1-3/5' });
        expect(await new Response(part!.body).text()).toBe('ell');
        expect(await client.get_object_stream('missing')).toBeNull();
    });

    it('has no way to hand out an R2 URL (no presigned URLs)', () => {
        const methods = Object.getOwnPropertyNames(R2Client.prototype);
        expect(methods.filter((m) => /presign|url/i.test(m) && m !== '_s3_url')).toEqual([]);
    });
});

describe.skipIf(process.env.R2_ROUND_TRIP !== '1')('R2Client round trip (dev bucket)', () => {
    it('puts, reads back (whole and a range) and deletes an object', async () => {
        const r2 = new R2Client(load_r2_config_from_env());
        const key = `round-trip-${crypto.randomUUID()}`;
        const body = Buffer.from('hello from the cliq r2 round trip');
        await r2.put_object_stream(key, Readable.from([body]), {
            content_length: body.length, content_type: 'text/plain', sha256_hex: crypto.createHash('sha256').update(body).digest('hex'),
        });
        try {
            const whole = await r2.get_object_stream(key);
            expect(Buffer.from(await new Response(whole!.body).arrayBuffer())).toEqual(body);
            const part = await r2.get_object_stream(key, { range: 'bytes=0-4' });
            expect(part!.status).toBe(206);
            expect(await new Response(part!.body).text()).toBe('hello');
        } finally {
            await r2.delete_object(key);
        }
        expect(await r2.get_object_stream(key)).toBeNull();
    });
});

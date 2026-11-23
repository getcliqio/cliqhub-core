/**
 * Makes cliqhub's sign-in key for getHugs (PLAN-gethugs-step7-sign-in.md).
 *
 *   npm run gethugs:signin-key -- <file for the private key>
 *
 * Writes the private JWK to the file (mode 600; never printed) — put its contents in Core's GETHUGS_SIGNIN_JWK — and
 * prints the public JWK and its kid, for a getHugs site admin to add on the cliqhub partner (Site admin › Partners ›
 * Sign-in keys › Add key). To rotate: a new key, have it added, switch GETHUGS_SIGNIN_JWK, have the old one revoked.
 */

import { existsSync, writeFileSync } from 'node:fs';
import { calculateJwkThumbprint, exportJWK, generateKeyPair } from 'jose';

async function main(): Promise<number> {
    const file = process.argv[2];
    if (!file) {
        console.error('Usage: npm run gethugs:signin-key -- <file for the private key>');
        return 2;
    }
    if (existsSync(file)) {
        console.error(`${file} already exists — choose a new file (a key is never overwritten).`);
        return 1;
    }
    const { publicKey, privateKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
    const private_jwk = await exportJWK(privateKey);
    const public_jwk = await exportJWK(publicKey);
    writeFileSync(file, `${JSON.stringify(private_jwk)}\n`, { mode: 0o600, flag: 'wx' });
    const kid = await calculateJwkThumbprint(public_jwk);
    console.log(`Private key written to ${file} (put its one line in GETHUGS_SIGNIN_JWK; keep it secret).`);
    console.log('Public key, for getHugs (Site admin › Partners › cliqhub › Sign-in keys › Add key):');
    console.log(JSON.stringify(public_jwk));
    console.log(`kid: ${kid}`);
    return 0;
}

main().then((code) => process.exit(code), (err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
});

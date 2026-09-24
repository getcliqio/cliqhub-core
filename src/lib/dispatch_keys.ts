/**
 * Ed25519 key pair helpers for per-org daemon dispatch auth.
 */

import { generateKeyPair, exportSPKI, exportPKCS8 } from 'jose';

export interface DispatchKeyPair {
    public_key_pem: string;
    private_key_pem: string;
}

export async function generate_dispatch_key_pair(): Promise<DispatchKeyPair> {
    const { publicKey, privateKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
    const public_key_pem = await exportSPKI(publicKey);
    const private_key_pem = await exportPKCS8(privateKey);
    return { public_key_pem, private_key_pem };
}

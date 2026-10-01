import { RealmDispatchKeyService } from './realm_dispatch_key.service.js';
import { DispatchAuth, DISPATCH_JWT_TTL_SECONDS } from '../lib/dispatch_auth.js';
import { get_logger } from '../lib/log.js';

const log = get_logger('svc.dispatch_auth');

export class DispatchAuthService {
    /** Mint a short-lived Bearer token for calling a daemon in this realm. */
    static async mint_token(opts: {
        realm_id: string;
        aud?: string;
        run_id?: string;
        action?: 'execute' | 'cancel' | 'access';
    }): Promise<{ token: string; expires_in: number; realm_id: string }> {
        log.debug('mint_token', { realm_id: opts.realm_id, run_id: opts.run_id, action: opts.action });
        const private_key_pem = await RealmDispatchKeyService.get_private_key_pem(opts.realm_id);
        const token = await DispatchAuth.sign_jwt(private_key_pem, {
            realm_id: opts.realm_id,
            aud: opts.aud,
            run_id: opts.run_id,
            action: opts.action ?? 'access',
        });
        return {
            token,
            expires_in: DISPATCH_JWT_TTL_SECONDS,
            realm_id: opts.realm_id,
        };
    }

    static async authorization_header(opts: {
        realm_id: string;
        aud?: string;
        run_id?: string;
        action?: 'execute' | 'cancel' | 'access';
    }): Promise<string> {
        log.debug('authorization_header', { realm_id: opts.realm_id, run_id: opts.run_id });
        const { token } = await DispatchAuthService.mint_token(opts);
        return `Bearer ${token}`;
    }
}

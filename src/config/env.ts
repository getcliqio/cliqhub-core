export interface EnvConfig {
    port: number;
    database_url: string;
    jwt_secret: string;
    jwt_expires_in: string;
    packages_path: string;
    storage_backend: 'local' | 'r2';
    s3_endpoint: string;
    s3_teams_bucket: string;
    s3_artifacts_bucket: string;
    s3_access_key_id: string;
    s3_secret_access_key: string;
    allowed_origins: string[];
    node_env: string;
    rate_limit_public_rpm: number;
    rate_limit_auth_rpm: number;
    rate_limit_window_ms: number;
    /** Brevo API key (`BREVO_API_KEY`, `xkeysib-…`); used when SMTP is not set up. */
    brevo_api_key?: string;
    /** SMTP login (`SMTP_USER`; Brevo shows it under SMTP & API, e.g. `8a1b2c001@smtp-brevo.com`). Set → email goes over SMTP. */
    smtp_user?: string;
    /** SMTP password (`SMTP_PASS`; Brevo's SMTP key `xsmtpsib-…`). */
    smtp_pass?: string;
    /** SMTP server (`SMTP_HOST`, default Brevo's relay) and port (`SMTP_PORT`, default 587). */
    smtp_host?: string;
    smtp_port?: number;
    /** Sender address for all email (`EMAIL_FROM_ADDRESS`). */
    email_from_address?: string;
    /** Sender display name (`EMAIL_FROM_NAME`). */
    email_from_name?: string;
}

export const RESERVED_SCOPES = ['local', 'prebuilt', 'cliq', 'admin'];
export const RESERVED_SLUGS = new Set([
    'local', 'prebuilt', 'cliq', 'admin', 'api', 'bff',
    'new', 'settings', 'login', 'signup', 'logout',
]);
export const PROTECTED_USERNAMES = ['cliq', 'admin'];
export const SLUG_PATTERN = /^[a-z][a-z0-9-]*$/;
export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 128;
export const MIN_SLUG_LENGTH = 2;
export const MAX_SLUG_LENGTH = 64;

const TOKEN_KEY_BYTES = 32;

/**
 * Parses `TOKEN_ENCRYPTION_KEY`: 32 bytes written as 64 hex characters or as
 * base64 / base64url.
 *
 * @throws Error when the value does not decode to exactly 32 bytes.
 */
export function parse_token_encryption_key(raw: string): Buffer {
    const value = raw.trim();
    const key = /^[0-9a-fA-F]{64}$/.test(value)
        ? Buffer.from(value, 'hex')
        : Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    if (key.length !== TOKEN_KEY_BYTES) {
        throw new Error(`TOKEN_ENCRYPTION_KEY must be ${TOKEN_KEY_BYTES} bytes (64 hex characters or base64)`);
    }
    return key;
}

/**
 * The key that encrypts stored link tokens (lib/secure_token.ts), read from
 * `TOKEN_ENCRYPTION_KEY` on each call.
 *
 * @throws Error when the variable is missing or malformed.
 */
export function token_encryption_key(): Buffer {
    const raw = process.env.TOKEN_ENCRYPTION_KEY;
    if (!raw) throw new Error('Missing required env var: TOKEN_ENCRYPTION_KEY');
    return parse_token_encryption_key(raw);
}

/**
 * Base URL of the web app (`PUBLIC_APP_URL`, no trailing slash), read on each call.
 *
 * @throws Error when the variable is missing or not an http(s) URL.
 */
export function public_app_url(): string {
    const raw = process.env.PUBLIC_APP_URL?.trim();
    if (!raw) throw new Error('Missing required env var: PUBLIC_APP_URL');
    if (!/^https?:\/\/[^\s]+$/.test(raw)) throw new Error('PUBLIC_APP_URL must be an http(s) URL');
    return raw.replace(/\/+$/, '');
}

export function load_env(): EnvConfig {
    const required = (key: string): string => {
        const val = process.env[key];
        if (!val) throw new Error(`Missing required env var: ${key}`);
        return val;
    };

    const node_env = process.env.NODE_ENV || 'development';
    // Link tokens are encrypted at rest and every email link points at the web
    // app: production must have both; elsewhere a set value must be valid.
    if (node_env === 'production' || process.env.TOKEN_ENCRYPTION_KEY) token_encryption_key();
    if (node_env === 'production' || process.env.PUBLIC_APP_URL) public_app_url();

    return {
        port: parseInt(process.env.PORT || '4000', 10),
        database_url: required('DATABASE_URL'),
        jwt_secret: process.env.JWT_SECRET || 'dev-only-secret-not-for-production',
        jwt_expires_in: process.env.JWT_EXPIRES_IN || '12h',
        packages_path: process.env.PACKAGES_PATH || './data/packages',
        storage_backend: (process.env.STORAGE_BACKEND || 'local') as 'local' | 'r2',
        s3_endpoint: process.env.S3_ENDPOINT || '',
        s3_teams_bucket: process.env.S3_TEAMS_BUCKET || 'cliqhub-packages',
        s3_artifacts_bucket: process.env.S3_ARTIFACTS_BUCKET || 'cliq-artifacts',
        s3_access_key_id: process.env.S3_ACCESS_KEY_ID || '',
        s3_secret_access_key: process.env.S3_SECRET_ACCESS_KEY || '',
        allowed_origins: (process.env.ALLOWED_ORIGINS || '')
            .split(',').map(s => s.trim()).filter(Boolean),
        node_env,
        rate_limit_public_rpm: parseInt(process.env.RATE_LIMIT_PUBLIC_RPM || '30', 10),
        rate_limit_auth_rpm: parseInt(process.env.RATE_LIMIT_AUTH_RPM || '120', 10),
        rate_limit_window_ms: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10),
        brevo_api_key: process.env.BREVO_API_KEY || undefined,
        smtp_user: process.env.SMTP_USER || undefined,
        smtp_pass: process.env.SMTP_PASS || undefined,
        smtp_host: process.env.SMTP_HOST || undefined,
        smtp_port: process.env.SMTP_PORT ? parseInt(process.env.SMTP_PORT, 10) : undefined,
        email_from_address: process.env.EMAIL_FROM_ADDRESS || undefined,
        email_from_name: process.env.EMAIL_FROM_NAME || undefined,
    };
}

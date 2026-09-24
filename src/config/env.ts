export interface EnvConfig {
    port: number;
    database_url: string;
    jwt_secret: string;
    jwt_expires_in: string;
    packages_path: string;
    storage_backend: 'local' | 'r2';
    s3_endpoint: string;
    s3_bucket: string;
    s3_access_key_id: string;
    s3_secret_access_key: string;
    allowed_origins: string[];
    node_env: string;
    rate_limit_public_rpm: number;
    rate_limit_auth_rpm: number;
    rate_limit_window_ms: number;
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

export function load_env(): EnvConfig {
    const required = (key: string): string => {
        const val = process.env[key];
        if (!val) throw new Error(`Missing required env var: ${key}`);
        return val;
    };

    return {
        port: parseInt(process.env.PORT || '4000', 10),
        database_url: required('DATABASE_URL'),
        jwt_secret: process.env.JWT_SECRET || 'dev-only-secret-not-for-production',
        jwt_expires_in: process.env.JWT_EXPIRES_IN || '12h',
        packages_path: process.env.PACKAGES_PATH || './data/packages',
        storage_backend: (process.env.STORAGE_BACKEND || 'local') as 'local' | 'r2',
        s3_endpoint: process.env.S3_ENDPOINT || '',
        s3_bucket: process.env.S3_BUCKET || '',
        s3_access_key_id: process.env.S3_ACCESS_KEY_ID || '',
        s3_secret_access_key: process.env.S3_SECRET_ACCESS_KEY || '',
        allowed_origins: (process.env.ALLOWED_ORIGINS || '')
            .split(',').map(s => s.trim()).filter(Boolean),
        node_env: process.env.NODE_ENV || 'development',
        rate_limit_public_rpm: parseInt(process.env.RATE_LIMIT_PUBLIC_RPM || '30', 10),
        rate_limit_auth_rpm: parseInt(process.env.RATE_LIMIT_AUTH_RPM || '120', 10),
        rate_limit_window_ms: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10),
    };
}

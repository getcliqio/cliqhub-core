export interface SyncEnvConfig {
    port: number;
    database_url: string;
    jwt_secret: string;
    poll_timeout_ms: number;
    command_ttl_ms: number;
    client_timeout_ms: number;
    liveness_threshold_ms: number;
    notify_channel: string;
    response_notify_channel: string;
    log_level: string;
    node_env: string;
    public_url: string;
}

export function load_env(): SyncEnvConfig {
    const required = (key: string): string => {
        const val = process.env[key];
        if (!val) throw new Error(`Missing required env var: ${key}`);
        return val;
    };

    return {
        port: parseInt(process.env.PORT || '4901', 10),
        database_url: required('DATABASE_URL'),
        jwt_secret: process.env.JWT_SECRET || 'dev-only-secret-not-for-production',
        poll_timeout_ms: parseInt(process.env.POLL_TIMEOUT_MS || '30000', 10),
        command_ttl_ms: parseInt(process.env.COMMAND_TTL_MS || '30000', 10),
        client_timeout_ms: parseInt(process.env.CLIENT_TIMEOUT_MS || '30000', 10),
        liveness_threshold_ms: parseInt(process.env.LIVENESS_THRESHOLD_MS || '60000', 10),
        notify_channel: process.env.NOTIFY_CHANNEL || 'sync_command_ready',
        response_notify_channel: process.env.RESPONSE_NOTIFY_CHANNEL || 'sync_response_ready',
        log_level: process.env.LOG_LEVEL || 'info',
        node_env: process.env.NODE_ENV || 'development',
        public_url: process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || '4901'}`,
    };
}

/** Pluggable mesh network adapters (Svantic, …). */

export interface Mesh_settings_field {
    key: string;
    label: string;
    type: 'string' | 'secret' | 'enum' | 'boolean' | 'url';
    required?: boolean;
    description?: string;
    options?: Array<{ value: string; label: string }>;
    default?: unknown;
}

export interface Mesh_health {
    status: 'disconnected' | 'connecting' | 'connected' | 'error';
    message?: string;
    details?: Record<string, unknown>;
}

export interface Realm_mesh_context {
    realm_id: string;
    realm_slug: string;
    /** Adapter-specific settings blob (secrets may be present). */
    settings: Record<string, unknown>;
    /** Public A2A base URL for this realm, e.g. https://api.cliqhub.io/a2a/r/{slug} */
    public_a2a_url: string;
}

export interface Inbound_dispatch {
    headers: Record<string, string | string[] | undefined>;
    body: unknown;
}

/**
 * One mesh network = one adapter.
 * connect/disconnect/re_register are no-ops or stubs until the vendor slice ships.
 */
export interface Mesh_adapter {
    readonly id: string;
    readonly label: string;
    readonly settings_schema: Mesh_settings_field[];
    connect(ctx: Realm_mesh_context): Promise<Mesh_health>;
    disconnect(ctx: Realm_mesh_context): Promise<Mesh_health>;
    re_register(ctx: Realm_mesh_context): Promise<Mesh_health>;
    health(ctx: Realm_mesh_context): Promise<Mesh_health>;
    verify_inbound?(
    req: Inbound_dispatch,
    settings: Record<string, unknown>,
    realm_id: string,
  ): Promise<boolean>;
}

export interface Mesh_adapter_descriptor {
    id: string;
    label: string;
    settings_schema: Mesh_settings_field[];
}

/**
 * ModelPricingService — resolves token counts to cost_usd using the
 * model_pricing table.
 *
 * Caches the (small) pricing table in memory and refreshes it on a
 * timer. Hub owns cost calculation so daemons only need to report
 * raw token counts.
 */

import type { Sequelize } from 'sequelize';
import { get_logger } from '../lib/log.js';

const log = get_logger('model-pricing');

/** A single rate row from the model_pricing table. */
interface PricingRate {
    provider: string;
    model: string;
    input_per_1m: number;
    output_per_1m: number;
    /** Cache-read price; null → cached tokens are priced as input. */
    cached_input_per_1m?: number | null;
    effective_from: string; // ISO date string (YYYY-MM-DD)
}

/** Result of a cost resolution. */
export interface ResolvedCost {
    cost_usd: number;
    input_per_1m: number;
    output_per_1m: number;
    effective_from: string;
}

/** Cache refresh interval (5 minutes). */
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;

/** Lazily-initialized singleton. */
let _instance: ModelPricingService | null = null;

/**
 * Initialize the singleton with the control-plane Sequelize.
 * Call once at boot (after store is connected).
 */
export function init_model_pricing_service(sq: Sequelize): ModelPricingService {
    if (_instance) return _instance;
    _instance = new ModelPricingService(sq);
    _instance.start();
    return _instance;
}

/**
 * Get the singleton. Throws if not initialized — call
 * `init_model_pricing_service` at boot first.
 */
export function get_model_pricing_service(): ModelPricingService {
    if (!_instance) throw new Error('ModelPricingService not initialized — call init_model_pricing_service at boot');
    return _instance;
}

/** Reset singleton (tests only). */
export function reset_model_pricing_service(): void {
    _instance?.stop();
    _instance = null;
}

export class ModelPricingService {
    private _sq: Sequelize;
    private _cache: PricingRate[] = [];
    private _last_refresh = 0;
    private _refresh_timer: ReturnType<typeof setInterval> | null = null;

    constructor(sq: Sequelize) {
        this._sq = sq;
    }

    /** Start periodic cache refresh. Call once at service boot. */
    start(): void {
        if (this._refresh_timer) return;
        this._refresh_cache().catch((err) => {
            log.warn(`initial pricing cache load failed: ${err}`);
        });
        this._refresh_timer = setInterval(() => {
            this._refresh_cache().catch((err) => {
                log.warn(`pricing cache refresh failed: ${err}`);
            });
        }, REFRESH_INTERVAL_MS);
        this._refresh_timer.unref();
    }

    /** Stop periodic refresh. */
    stop(): void {
        if (this._refresh_timer) {
            clearInterval(this._refresh_timer);
            this._refresh_timer = null;
        }
    }

    /**
     * Resolve cost for a given provider/model/token-counts.
     *
     * Looks up the most recent pricing rate where `effective_from`
     * is on or before `as_of_date`. Returns `null` if no matching
     * rate exists (unknown model — cost should be stored as null,
     * not zero).
     *
     * `tokens_cached` (cache reads, already counted inside `tokens_in`)
     * are priced at the model's cache-read rate when it has one.
     */
    resolve_cost(
        provider: string,
        model: string,
        tokens_in: number,
        tokens_out: number,
        as_of_date?: Date,
        tokens_cached = 0,
    ): ResolvedCost | null {
        const target = as_of_date ?? new Date();
        const target_str = target.toISOString().slice(0, 10);

        // Find the most recent rate for this provider/model that's
        // effective on or before the target date. The cache is sorted
        // by effective_from DESC within each provider/model group.
        const rate = this._find_rate(provider, model, target_str);
        if (!rate) return null;

        const cached = rate.cached_input_per_1m != null ? Math.min(Math.max(tokens_cached, 0), tokens_in) : 0;
        const cost_usd = ((tokens_in - cached) / 1_000_000) * rate.input_per_1m
            + (cached / 1_000_000) * (rate.cached_input_per_1m ?? rate.input_per_1m)
            + (tokens_out / 1_000_000) * rate.output_per_1m;

        return {
            cost_usd: Math.round(cost_usd * 1_000_000) / 1_000_000,
            input_per_1m: rate.input_per_1m,
            output_per_1m: rate.output_per_1m,
            effective_from: rate.effective_from,
        };
    }

    /** Force a cache refresh (useful for tests). */
    async refresh(): Promise<void> {
        await this._refresh_cache();
    }

    // ─── Internals ───────────────────────────────────────────────────

    /**
     * Find the best matching rate for a provider/model/date.
     * Returns the row with the latest `effective_from` that is ≤ target_date.
     */
    private _find_rate(provider: string, model: string, target_date: string): PricingRate | null {
        const want = normalize_model_ref(provider, model);
        let best: PricingRate | null = null;
        for (const rate of this._cache) {
            const have = normalize_model_ref(rate.provider, rate.model);
            if (have.provider !== want.provider) continue;
            if (have.model !== want.model) continue;
            if (rate.effective_from > target_date) continue;
            if (!best || rate.effective_from > best.effective_from) {
                best = rate;
            }
        }
        return best;
    }

    /** Reload the full pricing table into memory. */
    private async _refresh_cache(): Promise<void> {
        const [rows] = await this._sq.query(
            `SELECT provider, model, input_per_1m::float, output_per_1m::float,
                    cached_input_per_1m::float, effective_from::text
             FROM cliq.model_pricing
             ORDER BY provider, model, effective_from DESC`,
        ) as [PricingRate[], unknown];

        this._cache = rows;
        this._last_refresh = Date.now();
        log.debug(`pricing cache refreshed: ${rows.length} rates`);
    }
}

/** Providers priced in `cliq.model_pricing`; anything else (e.g. `cursor`) is resolved from the model id. */
const KNOWN_PROVIDERS = new Set(['anthropic', 'openai', 'google']);

/**
 * The comparable form of a (provider, model) pair, applied to both the
 * reported usage and the pricing rows:
 *
 *   model     lower case; `vendor/` prefix, `-YYYYMMDD` / `-latest` /
 *             `-thinking` suffixes dropped; `.` → `-`; Claude ids as
 *             `claude-<family>-<version>` (so `claude-3-5-sonnet`,
 *             `claude-4.5-sonnet` and `sonnet-4-5` all become
 *             `claude-sonnet-3-5` / `claude-sonnet-4-5`)
 *   provider  lower case; a reseller (`cursor`) or unknown provider is
 *             replaced by the vendor the model id names
 */
export function normalize_model_ref(provider: string, model: string): { provider: string; model: string } {
    let m = (model ?? '').trim().toLowerCase().replace(/^(anthropic|openai|google)\//, '');
    m = m.replace(/\./g, '-').replace(/-(\d{8}|latest)$/, '').replace(/-(thinking|max)$/, '');
    const claude_versioned = /^(?:claude-)?(\d+(?:-\d+)?)-(sonnet|opus|haiku|fable|mythos)$/.exec(m);
    const claude_family = /^(?:claude-)?(sonnet|opus|haiku|fable|mythos)-(\d+(?:-\d+)?)$/.exec(m);
    if (claude_versioned) m = `claude-${claude_versioned[2]}-${claude_versioned[1]}`;
    else if (claude_family) m = `claude-${claude_family[1]}-${claude_family[2]}`;

    let p = (provider ?? '').trim().toLowerCase();
    if (!KNOWN_PROVIDERS.has(p)) {
        if (/^claude-|^(sonnet|opus|haiku|fable|mythos)$/.test(m)) p = 'anthropic';
        else if (/^(gpt|o\d|chatgpt|codex)/.test(m)) p = 'openai';
        else if (/^gemini/.test(m)) p = 'google';
    }
    return { provider: p, model: m };
}

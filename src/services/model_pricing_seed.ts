/**
 * Seed `cliq.model_pricing` from the version-controlled price list
 * (`data/model_pricing.json`) at boot, after the schema migrations.
 *
 * Upserts on (provider, model, effective_from): editing a price in the JSON
 * updates that row; a price change over time is a new row with a later
 * `effective_from`. Rows added by hand are left alone.
 */

import type { Sequelize } from 'sequelize';

import price_list from '../data/model_pricing.json' with { type: 'json' };
import { get_logger } from '../lib/log.js';

const log = get_logger('model-pricing-seed');

/** One price row in `data/model_pricing.json`. */
export interface ModelPriceRow {
    provider: string;
    model: string;
    input_per_1m: number;
    output_per_1m: number;
    /** Cache-read price; null when the vendor lists none. */
    cached_input_per_1m: number | null;
    effective_from: string;
}

/** The seeded price list. */
export const MODEL_PRICES: readonly ModelPriceRow[] = (price_list as { rates: ModelPriceRow[] }).rates;

/**
 * Upsert every price row.
 *
 * @returns how many rows were written.
 */
export async function seed_model_pricing(sq: Sequelize, rows: readonly ModelPriceRow[] = MODEL_PRICES): Promise<number> {
    for (const r of rows) {
        await sq.query(
            `INSERT INTO cliq."model_pricing" ("provider", "model", "input_per_1m", "output_per_1m", "cached_input_per_1m", "effective_from")
             VALUES (:provider, :model, :input_per_1m, :output_per_1m, :cached_input_per_1m, :effective_from)
             ON CONFLICT ("provider", "model", "effective_from")
             DO UPDATE SET "input_per_1m" = EXCLUDED."input_per_1m", "output_per_1m" = EXCLUDED."output_per_1m",
                           "cached_input_per_1m" = EXCLUDED."cached_input_per_1m"`,
            {
                replacements: {
                    provider: r.provider, model: r.model, input_per_1m: r.input_per_1m, output_per_1m: r.output_per_1m,
                    cached_input_per_1m: r.cached_input_per_1m ?? null, effective_from: r.effective_from,
                },
            },
        );
    }
    log.info('model_pricing_seeded', { rows: rows.length });
    return rows.length;
}

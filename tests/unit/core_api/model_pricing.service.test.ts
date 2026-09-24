/**
 * ModelPricingService — resolve token counts to cost_usd using cached
 * pricing rates. Tests exercise the in-memory cache and date matching
 * without a real Postgres connection.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ModelPricingService, type ResolvedCost } from '../../../src/services/model_pricing.service.js';


// ─── Helpers ─────────────────────────────────────────────────────────

/**
 * Create a service and inject rows directly into its cache.
 * Avoids needing a real Sequelize connection.
 */
function make_service(rows: Array<{
    provider: string;
    model: string;
    input_per_1m: number;
    output_per_1m: number;
    effective_from: string;
}>): ModelPricingService {
    // Construct with a fake Sequelize (never used — we pre-fill cache).
    const svc = new ModelPricingService(null as never);
    // Inject cache directly via the private field.
    (svc as unknown as { _cache: typeof rows })._cache = [...rows];
    return svc;
}


// ─── Tests ───────────────────────────────────────────────────────────

describe('ModelPricingService.resolve_cost', () => {
    const CLAUDE_SONNET = {
        provider: 'anthropic',
        model: 'claude-sonnet-4-20250514',
        input_per_1m: 3.0,
        output_per_1m: 15.0,
        effective_from: '2025-05-14',
    };

    const GPT_4O = {
        provider: 'openai',
        model: 'gpt-4o',
        input_per_1m: 2.5,
        output_per_1m: 10.0,
        effective_from: '2025-01-01',
    };

    const GPT_4O_DISCOUNT = {
        provider: 'openai',
        model: 'gpt-4o',
        input_per_1m: 2.0,
        output_per_1m: 8.0,
        effective_from: '2025-06-01',
    };

    it('returns correct cost for known provider/model with one rate row', () => {
        const svc = make_service([CLAUDE_SONNET]);
        const result = svc.resolve_cost('anthropic', 'claude-sonnet-4-20250514', 1_000_000, 100_000);

        expect(result).not.toBeNull();
        // Cost = (1M / 1M) * 3.0 + (100K / 1M) * 15.0 = 3.0 + 1.5 = 4.5
        expect(result!.cost_usd).toBeCloseTo(4.5, 4);
        expect(result!.input_per_1m).toBe(3.0);
        expect(result!.output_per_1m).toBe(15.0);
    });

    it('picks the correct rate when multiple effective_from dates exist', () => {
        const svc = make_service([GPT_4O, GPT_4O_DISCOUNT]);

        // Before discount (2025-03-15): should use original rate.
        const before = svc.resolve_cost('openai', 'gpt-4o', 500_000, 200_000, new Date('2025-03-15'));
        expect(before).not.toBeNull();
        // (500K / 1M) * 2.5 + (200K / 1M) * 10.0 = 1.25 + 2.0 = 3.25
        expect(before!.cost_usd).toBeCloseTo(3.25, 4);
        expect(before!.effective_from).toBe('2025-01-01');

        // After discount (2025-07-01): should use discounted rate.
        const after = svc.resolve_cost('openai', 'gpt-4o', 500_000, 200_000, new Date('2025-07-01'));
        expect(after).not.toBeNull();
        // (500K / 1M) * 2.0 + (200K / 1M) * 8.0 = 1.0 + 1.6 = 2.6
        expect(after!.cost_usd).toBeCloseTo(2.6, 4);
        expect(after!.effective_from).toBe('2025-06-01');
    });

    it('returns null for unknown provider/model', () => {
        const svc = make_service([CLAUDE_SONNET]);

        expect(svc.resolve_cost('unknown', 'model', 1000, 100)).toBeNull();
        expect(svc.resolve_cost('anthropic', 'claude-opus-4', 1000, 100)).toBeNull();
    });

    it('returns null when run_started_at is before any effective_from', () => {
        const svc = make_service([CLAUDE_SONNET]);
        const before = svc.resolve_cost(
            'anthropic', 'claude-sonnet-4-20250514',
            1000, 100,
            new Date('2024-01-01'),
        );
        expect(before).toBeNull();
    });

    it('handles zero tokens correctly', () => {
        const svc = make_service([CLAUDE_SONNET]);
        const result = svc.resolve_cost('anthropic', 'claude-sonnet-4-20250514', 0, 0);

        expect(result).not.toBeNull();
        expect(result!.cost_usd).toBe(0);
    });

    it('uses current date when as_of_date is not provided', () => {
        const svc = make_service([CLAUDE_SONNET]);
        // Current date is well after 2025-05-14 so should find a match.
        const result = svc.resolve_cost('anthropic', 'claude-sonnet-4-20250514', 100_000, 10_000);
        expect(result).not.toBeNull();
    });

    it('rounds cost to 6 decimal places', () => {
        const svc = make_service([{
            provider: 'test',
            model: 'rounding',
            input_per_1m: 1.333333,
            output_per_1m: 2.666666,
            effective_from: '2020-01-01',
        }]);
        const result = svc.resolve_cost('test', 'rounding', 7, 3);
        expect(result).not.toBeNull();
        // Expect the cost to be a finite number with at most 6 decimal places.
        const dp = result!.cost_usd.toString().split('.')[1]?.length ?? 0;
        expect(dp).toBeLessThanOrEqual(6);
    });

    it('selects exact effective_from match on boundary date', () => {
        const svc = make_service([GPT_4O, GPT_4O_DISCOUNT]);
        const on_boundary = svc.resolve_cost('openai', 'gpt-4o', 1_000_000, 0, new Date('2025-06-01'));
        expect(on_boundary).not.toBeNull();
        expect(on_boundary!.effective_from).toBe('2025-06-01');
        expect(on_boundary!.input_per_1m).toBe(2.0);
    });
});

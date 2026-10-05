/**
 * Run cost: the seeded price list, model/provider matching, and the usage
 * snapshot Core stores (the shape the BFF reads: by_model[].cost_usd at run
 * and per phase, total null when nothing could be priced).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const queries: Array<{ sql: string; replacements?: Record<string, unknown> }> = [];
vi.mock('../../../src/lib/sequelize.js', () => ({
    get_sequelize: () => ({
        query: vi.fn(async (sql: string, opts?: { replacements?: Record<string, unknown> }) => {
            queries.push({ sql, replacements: opts?.replacements });
            return [[], 0];
        }),
    }),
}));

import { ModelPricingService, normalize_model_ref } from '../../../src/services/model_pricing.service.js';
import { MODEL_PRICES, seed_model_pricing } from '../../../src/services/model_pricing_seed.js';
import { RunService } from '../../../src/services/run.service.js';

/** A pricing service whose cache is the seeded price list. */
function priced(): ModelPricingService {
    const svc = new ModelPricingService(null as never);
    (svc as unknown as { _cache: unknown[] })._cache = MODEL_PRICES.map((r) => ({ ...r }));
    return svc;
}

beforeEach(() => { queries.length = 0; });

describe('the seeded price list', () => {
    it('prices the default model of every built-in LLM agent', () => {
        const svc = priced();
        const defaults: Array<[string, string]> = [
            ['anthropic', 'claude-sonnet-4-20250514'], // claude-code, claude-api, cursor default
            ['openai', 'gpt-4.1'],                     // codex
            ['openai', 'gpt-4o'],                      // openai-api
            ['google', 'gemini-2.5-pro'],              // gemini
        ];
        for (const [provider, model] of defaults) {
            expect(svc.resolve_cost(provider, model, 1_000_000, 0), `${provider}/${model}`).not.toBeNull();
        }
    });

    it('has no duplicate (provider, model, effective_from) rows', () => {
        const keys = MODEL_PRICES.map((r) => `${r.provider}|${r.model}|${r.effective_from}`);
        expect(new Set(keys).size).toBe(keys.length);
    });

    it('is upserted on (provider, model, effective_from)', async () => {
        const sq = { query: vi.fn(async () => [[], 0]) };
        const n = await seed_model_pricing(sq as never, [MODEL_PRICES[0]!]);
        expect(n).toBe(1);
        const [sql, opts] = sq.query.mock.calls[0] as unknown as [string, { replacements: Record<string, unknown> }];
        expect(sql).toContain('ON CONFLICT ("provider", "model", "effective_from")');
        expect(opts.replacements).toEqual(MODEL_PRICES[0]);
    });
});

describe('normalize_model_ref', () => {
    it('drops dates and vendor prefixes, and treats . and - alike', () => {
        expect(normalize_model_ref('anthropic', 'claude-sonnet-4-20250514')).toEqual({ provider: 'anthropic', model: 'claude-sonnet-4' });
        expect(normalize_model_ref('OpenAI', 'openai/GPT-4.1')).toEqual({ provider: 'openai', model: 'gpt-4-1' });
        expect(normalize_model_ref('google', 'gemini-2.5-pro')).toEqual({ provider: 'google', model: 'gemini-2-5-pro' });
    });

    it('maps Cursor (a reseller) to the vendor its model id names', () => {
        expect(normalize_model_ref('cursor', 'claude-4.5-sonnet')).toEqual({ provider: 'anthropic', model: 'claude-sonnet-4-5' });
        expect(normalize_model_ref('cursor', 'claude-4-sonnet-thinking')).toEqual({ provider: 'anthropic', model: 'claude-sonnet-4' });
        expect(normalize_model_ref('cursor', 'sonnet-4.5')).toEqual({ provider: 'anthropic', model: 'claude-sonnet-4-5' });
        expect(normalize_model_ref('cursor', 'gpt-5')).toEqual({ provider: 'openai', model: 'gpt-5' });
        expect(normalize_model_ref('cursor', 'auto')).toEqual({ provider: 'cursor', model: 'auto' });
    });

    it('prices Cursor runs, and leaves an unknowable model (auto) unpriced', () => {
        const svc = priced();
        expect(svc.resolve_cost('cursor', 'claude-4.5-sonnet', 1_000_000, 1_000_000)?.cost_usd).toBe(18);
        expect(svc.resolve_cost('cursor', 'auto', 1_000_000, 0)).toBeNull();
    });
});

describe('RunService.ingest_usage_snapshot', () => {
    const usage = (model: string, provider = 'anthropic') => ({ provider, model, tokens_in: 1_000_000, tokens_out: 100_000, llm_calls: 3 });
    const base = { kind: 'usage', run_id: 'r1', total_tokens_in: 0, total_tokens_out: 0, total_duration_ms: 0, total_llm_calls: 0, total_invocations: 0 };

    it('prices the run and each phase (what the BFF reads), per model', async () => {
        await RunService.ingest_usage_snapshot({
            ...base,
            snapshot_type: 'run',
            by_model: { a: usage('claude-sonnet-4-20250514'), b: usage('gpt-4o', 'openai') },
            by_phase: {
                plan: { tokens_in: 1, by_model: { a: usage('claude-sonnet-4-20250514') }, by_agent: {} },
                build: { tokens_in: 1, by_model: { b: usage('gpt-4o', 'openai') }, by_agent: {} },
            },
        } as never, priced());
        const stored = JSON.parse(String(queries[0]!.replacements!.snapshot));
        expect(stored.by_model.a.cost_usd).toBe(4.5);   // 1M in × $3 + 0.1M out × $15
        expect(stored.by_model.b.cost_usd).toBe(3.5);   // 1M × $2.5 + 0.1M × $10
        expect(stored.total_cost_usd).toBe(8);
        expect(stored.by_phase.plan.by_model.a.cost_usd).toBe(4.5);
        expect(stored.by_phase.plan.cost_usd).toBe(4.5);
        expect(stored.by_phase.build.cost_usd).toBe(3.5);
        expect(stored.by_phase.plan.tokens_in).toBe(1);
    });

    it('nothing priceable: the total is null, not $0', async () => {
        await RunService.ingest_usage_snapshot({
            ...base, snapshot_type: 'run', by_model: { x: usage('auto', 'cursor') },
        } as never, priced());
        const stored = JSON.parse(String(queries[0]!.replacements!.snapshot));
        expect(stored.by_model.x.cost_usd).toBeNull();
        expect(stored.total_cost_usd).toBeNull();
    });
});

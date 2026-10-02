import { describe, it, expect } from 'vitest';
import { col, fn } from 'sequelize';
import { equals_first, list_order, nulls_last, sort_by_field, SortDirField, type SortColumns } from '../../../src/lib/list_sort.js';

type Key = 'name' | 'seen';
const COLUMNS: SortColumns<Key> = {
    name: (d) => [[fn('LOWER', col('name')), d]],
    seen: (d) => [['seen_at', nulls_last(d)]],
};

describe('list_order', () => {
    it('uses the whitelisted columns in the asked direction, then id ASC', () => {
        expect(list_order(COLUMNS, { sort_by: 'seen', sort_dir: 'desc' }, [['created_at', 'DESC']])).toEqual([['seen_at', 'DESC NULLS LAST'], ['id', 'ASC']]);
        expect(list_order(COLUMNS, { sort_by: 'seen' }, [])).toEqual([['seen_at', 'ASC NULLS LAST'], ['id', 'ASC']]);
    });

    it('keeps the default order without sort_by (sort_dir alone changes nothing)', () => {
        expect(list_order(COLUMNS, {}, [['created_at', 'DESC']])).toEqual([['created_at', 'DESC'], ['id', 'ASC']]);
        expect(list_order(COLUMNS, { sort_dir: 'asc' }, [['created_at', 'DESC']])).toEqual([['created_at', 'DESC'], ['id', 'ASC']]);
        expect(list_order(COLUMNS, {}, [], ['run_id', 'ASC'])).toEqual([['run_id', 'ASC']]);
    });
});

describe('request fields', () => {
    it('sort_by is a closed enum; sort_dir is asc | desc', () => {
        const by = sort_by_field(['name', 'seen'], 'newest first');
        expect(by.safeParse('name').success).toBe(true);
        expect(by.safeParse('password_hash').success).toBe(false);
        expect(by.safeParse(undefined).success).toBe(true);
        expect(SortDirField.safeParse('desc').success).toBe(true);
        expect(SortDirField.safeParse('DESC').success).toBe(false);
        expect(by.description).toContain('newest first');
    });

    it('equals_first keeps the value out of SQL text (a Sequelize value, escaped)', () => {
        const [expr, dir] = equals_first('slug', "x'); DROP TABLE orgs; --") as [{ fn: string; args: Array<{ logic?: unknown }> }, string];
        expect(dir).toBe('DESC');
        expect(expr.fn).toBe('COALESCE');
        expect(expr.args[0].logic).toBe("x'); DROP TABLE orgs; --");
    });
});

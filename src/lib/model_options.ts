/**
 * ModelConfig — Sequelize model init-options factory.
 *
 * `ModelConfig.table_options(sequelize, tableName, extras?)` builds the
 * `InitOptions` object required by every `Model.init()` call, pinning the
 * schema to `cliq`, disabling auto-timestamps, and merging any extra options
 * (e.g. `paranoid`, custom indexes) passed by the caller.
 */

import type { InitOptions, Model, ModelOptions, Sequelize } from 'sequelize';

export class ModelConfig {
    /**
     * Build Sequelize `InitOptions` for a `cliq`-schema table.
     *
     * Pins `schema` to `'cliq'` on Postgres, disables auto-timestamps, and
     * merges any caller-supplied extras (indexes, paranoid, hooks, etc.).
     *
     * @param sequelize - Connected Sequelize instance.
     * @param table_name - Unqualified table name (e.g. `'runs'`).
     * @param extra - Additional `ModelOptions` to merge (optional).
     * @returns A complete `InitOptions` object ready for `Model.init()`.
     */
    static table_options(
        sequelize: Sequelize,
        table_name: string,
        extra: Omit<ModelOptions, 'sequelize' | 'tableName' | 'timestamps' | 'schema'> = {},
    ): InitOptions<Model> {
        const base = { sequelize, tableName: table_name, timestamps: false, ...extra };
        if (sequelize.getDialect() !== 'postgres') return base;
        return { ...base, schema: 'cliq' };
    }
}

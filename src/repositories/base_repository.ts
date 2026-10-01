/**
 * Abstract base class for all repository classes.
 *
 * Every repository extends this with `protected readonly model = SomeModel`
 * and inherits standard CRUD instance methods that mirror the `BaseModel`
 * static helpers. Domain-specific queries are added as additional methods in
 * each concrete subclass.
 *
 * Instance style is intentional: concrete repos are easy to mock in unit tests
 * (`new RunRepository()` vs static calls), and domain methods can accumulate
 * on the class without polluting the model.
 *
 * Usage:
 * ```ts
 * export class RunRepository extends BaseRepository<Run> {
 *     protected readonly model = Run;
 *     async find_active(daemon_id: string) {
 *         return this.model.findAll({ where: { daemon_id, state: 'running' } });
 *     }
 * }
 * ```
 */

import {
    Model,
    type ModelStatic,
    type WhereOptions,
    type FindOptions,
    type CreateOptions,
    type BulkCreateOptions,
    type FindOrCreateOptions,
    type Attributes,
    type CreationAttributes,
} from 'sequelize';

export abstract class BaseRepository<M extends Model> {
    /** The Sequelize model class this repository manages. */
    protected abstract readonly model: ModelStatic<M>;

    /** Find a row by primary key. Returns null when not found. */
    async find_by_id(
        id: string | number,
        options?: Omit<FindOptions<Attributes<M>>, 'where'>,
    ): Promise<M | null> {
        return options ? this.model.findByPk(id, options) : this.model.findByPk(id);
    }

    /** Find the first row matching `where`. Returns null when not found. */
    async find_one(
        where: WhereOptions<Attributes<M>>,
        options?: Omit<FindOptions<Attributes<M>>, 'where'>,
    ): Promise<M | null> {
        return this.model.findOne({ where, ...options });
    }

    /**
     * Return all rows matching `where`.
     * Omit `where` to return all rows.
     */
    async find_all(
        where?: WhereOptions<Attributes<M>>,
        options?: Omit<FindOptions<Attributes<M>>, 'where'>,
    ): Promise<M[]> {
        return this.model.findAll({ where, ...options });
    }

    /**
     * Pass-through that accepts the full Sequelize `FindOptions` object
     * (with `where` nested inside). Useful when the call site already
     * constructs a complete options object.
     */
    async find_all_q(options?: FindOptions<Attributes<M>>): Promise<M[]> {
        return this.model.findAll(options);
    }

    /** Same as find_one but accepts a full Sequelize FindOptions object. */
    async find_one_q(options?: FindOptions<Attributes<M>>): Promise<M | null> {
        return this.model.findOne(options);
    }

    /** Paginated find with total count — useful for list endpoints. */
    async find_and_count(
        where?: WhereOptions<Attributes<M>>,
        options?: Omit<FindOptions<Attributes<M>>, 'where'>,
    ): Promise<{ rows: M[]; count: number }> {
        return this.model.findAndCountAll({ where, ...options });
    }

    /** Pass-through accepting a full Sequelize FindOptions for paginated queries. */
    async find_and_count_q(
        options?: FindOptions<Attributes<M>>,
    ): Promise<{ rows: M[]; count: number }> {
        return this.model.findAndCountAll(options);
    }

    /** Count rows matching `where`. Omit to count all rows. */
    async find_count(where?: WhereOptions<Attributes<M>>): Promise<number> {
        return this.model.count({ where });
    }

    /** Count rows using a full Sequelize CountOptions object. */
    async find_count_q(options?: { where?: WhereOptions<Attributes<M>>; [key: string]: any }): Promise<number> {
        const result = await this.model.count(options as any);
        return typeof result === 'number' ? result : (result as any).length ?? 0;
    }

    /** Insert a single row and return the created instance. */
    async create_one(
        values: CreationAttributes<M>,
        options?: CreateOptions<Attributes<M>>,
    ): Promise<M> {
        return this.model.create(values, options);
    }

    /** Insert multiple rows at once. */
    async bulk_create(
        records: CreationAttributes<M>[],
        options?: BulkCreateOptions<Attributes<M>>,
    ): Promise<M[]> {
        return this.model.bulkCreate(records, options);
    }

    /**
     * Update the row with the given primary key.
     * Returns the number of affected rows (0 or 1).
     */
    async update_by_id(
        id: string,
        values: Partial<Attributes<M>>,
    ): Promise<number> {
        const [count] = await this.model.update(values, {
            where: { id } as unknown as WhereOptions<Attributes<M>>,
        });
        return count;
    }

    /**
     * Update all rows matching `where`.
     * Returns `[count]` tuple (compatible with Sequelize's Model.update signature).
     */
    async update_where(
        where: WhereOptions<Attributes<M>>,
        values: Partial<Attributes<M>>,
    ): Promise<[number]> {
        const [count] = await this.model.update(values, { where });
        return [count];
    }

    /**
     * Delete the row with the given primary key.
     * Returns the number of deleted rows (0 or 1).
     */
    async delete_by_id(id: string): Promise<number> {
        return this.model.destroy({
            where: { id } as unknown as WhereOptions<Attributes<M>>,
        });
    }

    /**
     * Delete all rows matching `where`.
     * Returns the number of deleted rows.
     */
    async delete_where(where: WhereOptions<Attributes<M>>): Promise<number> {
        return this.model.destroy({ where });
    }

    /**
     * Delete all rows matching `where` with extra Sequelize options (e.g. transaction).
     */
    async delete_where_q(options: { where: WhereOptions<Attributes<M>>; [key: string]: any }): Promise<number> {
        return this.model.destroy(options as any);
    }

    /**
     * Insert or update a single row.
     * Returns [instance, created] where `created` is true for new rows.
     */
    async upsert_one(
        values: CreationAttributes<M>,
    ): Promise<[M, boolean | null]> {
        return this.model.upsert(values);
    }

    /**
     * Find or create a row matching `where`.
     * Returns [instance, created] where `created` is true for new rows.
     */
    async find_or_create(
        options: FindOrCreateOptions<Attributes<M>>,
    ): Promise<[M, boolean]> {
        return this.model.findOrCreate(options);
    }
}

/**
 * Base Sequelize model — provides snake_case CRUD methods as static helpers so
 * every subclass gets `find_by_id`, `find_one`, `find_all`, `find_count`,
 * `create_one`, `update_by_id`, `update_where`, `delete_by_id`, `delete_where`,
 * and `upsert_one` for free, without boilerplate in individual model files.
 *
 * Each concrete model must implement a `static register(sequelize: Sequelize): void`
 * method that calls `Model.init(columns, options)` — called by `init_models` or
 * `init_store_models` at application boot.
 *
 * Static methods use the `this: ModelStatic<M>` pattern so that TypeScript infers
 * the correct return type from the calling class — e.g. `Scope.find_by_id(id)`
 * returns `Promise<Scope | null>`, not `Promise<Model | null>`.
 */

import {
    Model,
    type ModelStatic,
    type WhereOptions,
    type FindOptions,
    type Attributes,
    type CreationAttributes,
} from 'sequelize';

export abstract class BaseModel<
    TAttrs extends object = Record<string, unknown>,
    TCreate extends object = TAttrs,
> extends Model<TAttrs, TCreate> {
    /**
     * Find a row by primary key. Returns null when not found or when `id` is
     * falsy / not a valid PK for the model.
     */
    static async find_by_id<M extends Model>(
        this: ModelStatic<M>,
        id: string,
    ): Promise<M | null> {
        return this.findByPk(id);
    }

    /** Find the first row matching `where`. Returns null when not found. */
    static async find_one<M extends Model>(
        this: ModelStatic<M>,
        where: WhereOptions<Attributes<M>>,
        options?: Omit<FindOptions<Attributes<M>>, 'where'>,
    ): Promise<M | null> {
        return this.findOne({ where, ...options });
    }

    /**
     * Return all rows matching `where`.
     * Omit `where` to return all rows (use `find_count` first if the table
     * may be large).
     */
    static async find_all<M extends Model>(
        this: ModelStatic<M>,
        where?: WhereOptions<Attributes<M>>,
        options?: Omit<FindOptions<Attributes<M>>, 'where'>,
    ): Promise<M[]> {
        return this.findAll({ where, ...options });
    }

    /** Count rows matching `where`. Omit to count all rows. */
    static async find_count<M extends Model>(
        this: ModelStatic<M>,
        where?: WhereOptions<Attributes<M>>,
    ): Promise<number> {
        return this.count({ where });
    }

    /** Insert a single row and return the created instance. */
    static async create_one<M extends Model>(
        this: ModelStatic<M>,
        values: CreationAttributes<M>,
    ): Promise<M> {
        return this.create(values);
    }

    /**
     * Update the row with the given primary key.
     * Returns the number of affected rows (0 or 1).
     */
    static async update_by_id<M extends Model>(
        this: ModelStatic<M>,
        id: string,
        values: Partial<Attributes<M>>,
    ): Promise<number> {
        const [count] = await this.update(values, { where: { id } as unknown as WhereOptions<Attributes<M>> });
        return count;
    }

    /**
     * Update all rows matching `where`.
     * Returns the number of affected rows.
     */
    static async update_where<M extends Model>(
        this: ModelStatic<M>,
        where: WhereOptions<Attributes<M>>,
        values: Partial<Attributes<M>>,
    ): Promise<number> {
        const [count] = await this.update(values, { where });
        return count;
    }

    /**
     * Delete the row with the given primary key.
     * Returns the number of deleted rows (0 or 1).
     */
    static async delete_by_id<M extends Model>(
        this: ModelStatic<M>,
        id: string,
    ): Promise<number> {
        return this.destroy({ where: { id } as unknown as WhereOptions<Attributes<M>> });
    }

    /**
     * Delete all rows matching `where`.
     * Returns the number of deleted rows.
     */
    static async delete_where<M extends Model>(
        this: ModelStatic<M>,
        where: WhereOptions<Attributes<M>>,
    ): Promise<number> {
        return this.destroy({ where });
    }

    /**
     * Insert or update a row.
     * Returns [instance, created] where `created` is true when a new row
     * was inserted (false on update; null when the DB cannot determine it).
     */
    static async upsert_one<M extends Model>(
        this: ModelStatic<M>,
        values: CreationAttributes<M>,
    ): Promise<[M, boolean | null]> {
        return this.upsert(values);
    }
}

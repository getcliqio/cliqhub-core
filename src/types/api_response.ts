/**
 * Platform API response envelopes.
 *
 * Every success path is `{ ok: true, data: T }`.
 * Errors are `{ ok: false, error: { code, message } }` (error_handler).
 *
 * Types are PascalCase; variables stay snake_case.
 */

import type { Request, Response } from 'express';
import type { ParamsDictionary } from 'express-serve-static-core';

/** Yes/no mutation payload (apply, delete, toggle, clear). Reuse platform-wide. */
export type BooleanData = boolean;

export type OkResponse<T> = {
    ok: true;
    data: T;
};

export type ErrResponse = {
    ok: false;
    error: {
        code: string;
        message: string;
    };
};

export type ApiResponse<T> = OkResponse<T> | ErrResponse;

/**
 * Entity-or-boolean wire union helper.
 * List/detail endpoints use `T | T[]`; mutations with no entity use `BooleanData`.
 */
export type EntityOrBooleanData<T> = T | T[] | BooleanData;

/** Paginated list payload — reuse instead of inventing `*ListData` per resource. */
export type PagedData<T> = {
    items: T[];
    total: number;
    offset: number;
    limit: number;
};

/**
 * Express `Request` with Hub body + success envelope.
 * (Express order is Params, ResBody, ReqBody — this alias puts body first.)
 */
export type ApiRequest<TBody, TData = unknown> = Request<
    ParamsDictionary,
    OkResponse<TData>,
    TBody
>;

/** Express `Response` typed to `{ ok: true, data: TData }`. */
export type ApiOkResponse<TData> = Response<OkResponse<TData>>;

/**
 * Flat success shape used by resources not yet on `{ ok, data }` (e.g. Realms until RM-ENV).
 * Prefer {@link OkResponse} / {@link ApiOkResponse} for new work.
 */
export type FlatOkResponse<TFields extends Record<string, unknown>> = {
    ok: true;
} & TFields;

/** Express `Request` with typed body + flat success ResBody. */
export type FlatApiRequest<
    TBody,
    TFields extends Record<string, unknown> = Record<string, unknown>,
> = Request<ParamsDictionary, FlatOkResponse<TFields>, TBody>;

/** Express `Response` typed to a flat `{ ok: true, …fields }` envelope. */
export type FlatApiOkResponse<TFields extends Record<string, unknown> = Record<string, unknown>> = Response<
    FlatOkResponse<TFields>
>;

/**
 * Filter operators by field kind (CB-451): a closed list, checked
 * against each condition's field. A kind without a row here can't be
 * filtered on (`blob`).
 */
import type { FieldKind } from './kinds.js';

export const FILTER_OPS = [
    'is',
    'is_not',
    'contains',
    'not_contains',
    'starts_with',
    'ends_with',
    'eq',
    'neq',
    'lt',
    'lte',
    'gt',
    'gte',
    'between',
    'before',
    'after',
    'on_or_before',
    'on_or_after',
    'within',
    'is_any_of',
    'is_none_of',
    'has_any_of',
    'has_all_of',
    'has_none_of',
    'is_empty',
    'is_not_empty',
] as const;
export type FilterOp = (typeof FILTER_OPS)[number];

const TEXT_OPS = [
    'is',
    'is_not',
    'contains',
    'not_contains',
    'starts_with',
    'ends_with',
    'is_empty',
    'is_not_empty',
] as const;
const NUMBER_OPS = ['eq', 'neq', 'lt', 'lte', 'gt', 'gte', 'between', 'is_empty', 'is_not_empty'] as const;
const DATE_OPS = [
    'is',
    'before',
    'after',
    'on_or_before',
    'on_or_after',
    'between',
    'within',
    'is_empty',
    'is_not_empty',
] as const;
const ONE_OF_OPS = ['is', 'is_not', 'is_any_of', 'is_none_of', 'is_empty', 'is_not_empty'] as const;
const MANY_OPS = ['has_any_of', 'has_all_of', 'has_none_of', 'is_empty', 'is_not_empty'] as const;
const EMPTY_OPS = ['is_empty', 'is_not_empty'] as const;

/**
 * The operators of each kind. `id` takes the operators of the type it is
 * stored as (see `filterKind`); `json` and `file` only test for empty.
 */
export const OPERATORS_BY_KIND: Record<Exclude<FieldKind, 'id'>, readonly FilterOp[]> = {
    text: TEXT_OPS,
    long_text: TEXT_OPS,
    url: TEXT_OPS,
    email: TEXT_OPS,
    phone: TEXT_OPS,
    number: NUMBER_OPS,
    currency: NUMBER_OPS,
    percent: NUMBER_OPS,
    checkbox: ['is'],
    date: DATE_OPS,
    datetime: DATE_OPS,
    select: ONE_OF_OPS,
    person: ONE_OF_OPS,
    multi_select: MANY_OPS,
    people: MANY_OPS,
    file: EMPTY_OPS,
    json: EMPTY_OPS,
    blob: [],
};

/** What value an operator takes. */
export type OpValueShape = 'none' | 'one' | 'pair' | 'list' | 'range';
export const OP_VALUE_SHAPE: Record<FilterOp, OpValueShape> = {
    is: 'one',
    is_not: 'one',
    contains: 'one',
    not_contains: 'one',
    starts_with: 'one',
    ends_with: 'one',
    eq: 'one',
    neq: 'one',
    lt: 'one',
    lte: 'one',
    gt: 'one',
    gte: 'one',
    before: 'one',
    after: 'one',
    on_or_before: 'one',
    on_or_after: 'one',
    between: 'pair',
    within: 'range',
    is_any_of: 'list',
    is_none_of: 'list',
    has_any_of: 'list',
    has_all_of: 'list',
    has_none_of: 'list',
    is_empty: 'none',
    is_not_empty: 'none',
};

/** The operators a field of this kind takes; `id` uses the kind of its stored type. */
export function operatorsFor(kind: FieldKind, idBaseKind: FieldKind = 'text'): readonly FilterOp[] {
    if (kind === 'id') {
        return idBaseKind === 'id' ? TEXT_OPS : operatorsFor(idBaseKind);
    }
    return OPERATORS_BY_KIND[kind];
}

import { z } from 'zod';

import { DATA_OPERATION_TIERS, type ActionTier, type DataOperation } from '../actor-scopes.js';

/**
 * Moved from `src/server/dataspace/operations.ts`, which re-exports it,
 * so other features read the table without importing the data space.
 *
 * The data API's operations as an app's token reaches them (CB-232):
 * each one's fixed tier, and for the consequential ones the
 * parameters an approval of that exact call is bound to. One table, read
 * by the data API's gate (`obo.ts`) and by the approvals request
 * (`actors/approvals.ts`), so both compute the same intent digest.
 */

/**
 * File operations of the data API, with the tiers of their dataset
 * counterparts. `DATA_OPERATION_TIERS` names dataset operations only; a
 * development app's token also reaches its own folder.
 */
const FILE_OPERATION_TIERS = {
    'files.read': 'read',
    'files.write': 'write',
    'files.delete': 'consequential',
} as const satisfies Record<string, ActionTier>;

const TIERS = { ...DATA_OPERATION_TIERS, ...FILE_OPERATION_TIERS };

export type DataApiOperation = DataOperation | keyof typeof FILE_OPERATION_TIERS;

/** An operation's fixed tier: the platform's, never the app's. */
export function operationTier(op: DataApiOperation): ActionTier {
    return TIERS[op];
}

export const isDataApiOperation = (op: string): op is DataApiOperation => Object.hasOwn(TIERS, op);

/** The data operations that need a consumed approval through a socio. */
export type ConsequentialDataOperation = {
    [K in DataApiOperation]: (typeof TIERS)[K] extends 'consequential' ? K : never;
}[DataApiOperation];

/**
 * An approval of a data operation is an `app_action` approval whose action
 * is this prefix and the operation's name (`data:files.delete`). The
 * manifest validator refuses app actions with it, so the tier is always
 * the platform's.
 */
export const DATA_ACTION_PREFIX = 'data:';

export const dataAction = (op: DataApiOperation) => `${DATA_ACTION_PREFIX}${op}`;

/**
 * The operation a reserved `data:<op>` action names: undefined for an
 * app's own action, `null` for a `data:` name the data API doesn't have.
 */
export function dataActionOperation(action: string): DataApiOperation | null | undefined {
    if (!action.startsWith(DATA_ACTION_PREFIX)) {
        return undefined;
    }
    const op = action.slice(DATA_ACTION_PREFIX.length);
    return isDataApiOperation(op) ? op : null;
}

const datasetRef = z.string().min(1).max(100);
const tableName = z.string().min(1).max(63);

/**
 * Each consequential operation's parameters, canonical and platform
 * defined: derived from the request the data API receives, so the app
 * computes the same digest before the call and the data API recomputes
 * it at the call. Strict: nothing the app adds reaches a card.
 *
 * - `files.delete`: `{ path }`, the exact `path` query value.
 * - `deleteRows`: `{ dataset, table, rowids }`, the dataset as the route
 *   names it (id or manifest ref).
 * - `dropTable`: `{ dataset, table }`.
 * - `deleteDataset`: `{ dataset }`.
 *
 * Only `files.delete` has a route an app's token reaches today; the
 * others are the person's own routes, defined here so a later app route
 * can't invent its own shape.
 */
const DATA_APPROVAL_PARAMS = {
    'files.delete': z.object({ path: z.string().min(1).max(512) }).strict(),
    deleteRows: z
        .object({
            dataset: datasetRef,
            table: tableName,
            rowids: z.array(z.number().int().safe()).min(1).max(1000),
        })
        .strict(),
    dropTable: z.object({ dataset: datasetRef, table: tableName }).strict(),
    deleteDataset: z.object({ dataset: datasetRef }).strict(),
} as const satisfies Record<ConsequentialDataOperation, z.ZodType>;

/** What a data operation's approval card says it does, in Socio's words. */
export const DATA_APPROVAL_WORDS: Record<ConsequentialDataOperation, string> = {
    'files.delete': 'delete a file from the app’s files',
    deleteRows: 'delete rows from a table of the app’s data',
    dropTable: 'delete a table of the app’s data, with its rows',
    deleteDataset: 'delete a dataset of the app’s data, with all its tables',
};

export const isConsequentialOperation = (op: DataApiOperation): op is ConsequentialDataOperation =>
    operationTier(op) === 'consequential';

/**
 * The canonical parameters of one consequential operation's call, or
 * undefined when `input` isn't exactly that shape (or `op` needs none).
 */
export function dataApprovalParams(op: DataApiOperation, input: unknown): Record<string, unknown> | undefined {
    if (!isConsequentialOperation(op)) {
        return undefined;
    }
    const parsed = DATA_APPROVAL_PARAMS[op].safeParse(input);
    return parsed.success ? parsed.data : undefined;
}

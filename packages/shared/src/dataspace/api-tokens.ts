import { z } from 'zod';

/**
 * Data API tokens: credentials a workspace admin makes in Settings, for
 * a script of theirs (an import from another tool) to use the data API on
 * the company's datasets. Shown once, kept as a SHA-256 hash. Each one has
 * scopes, an expiry and its own per-minute budget. It reaches only
 * company-owned datasets that no plugin is bound to: never a person's, a
 * socio's or a plugin's. Writes are recorded as the token (`token:<id>`)
 * and attributed to the admin who made it.
 */
export const DATA_API_SCOPES = ['data:read', 'data:write', 'data:admin'] as const;
export type DataApiScope = (typeof DATA_API_SCOPES)[number];

export const DATA_API_SCOPE_LABELS: Record<DataApiScope, string> = {
    'data:read': 'List and read the company’s datasets: tables, queries, field settings',
    'data:write': 'Add, change and remove rows, in single writes or batches',
    'data:admin':
        'Create company datasets, declare tables and columns, set field settings and place datasets in a Space',
};

/** Days a token lives: 7 unless the admin picks another, at most 30. */
export const DATA_API_TOKEN_DAYS_DEFAULT = 7;
export const DATA_API_TOKEN_DAYS_MAX = 30;
/** A token's data operations a minute unless the admin sets its own (at most the plugin budget's ceiling). */
export const DATA_API_TOKEN_STATEMENTS_PER_MINUTE = 600;
/** Where admins list, make and revoke them. */
export const DATA_API_TOKENS_PATH = '/api/data/api-tokens';
/** What a token's value starts with after the data token prefix (`cbdt_api_…`). */
export const DATA_API_TOKEN_INFIX = 'api_';
/** Who a token's writes are recorded as: in row history, field settings and the data audit. */
export const dataApiTokenActor = (id: string) => `token:${id}`;

/** `POST /api/data/api-tokens`. */
export const dataApiTokenCreateBody = z
    .object({
        name: z.string().trim().min(1).max(60),
        scopes: z.array(z.enum(DATA_API_SCOPES)).min(1).max(DATA_API_SCOPES.length),
        days: z.number().int().min(1).max(DATA_API_TOKEN_DAYS_MAX).optional(),
        /** Operations a minute; the default when left out. */
        statementsPerMinute: z.number().int().min(1).optional(),
    })
    .strict();
export type DataApiTokenCreate = z.input<typeof dataApiTokenCreateBody>;

export interface DataApiTokenView {
    id: string;
    name: string;
    /** The value's first characters after `cbdt_api_`, to tell tokens apart. */
    hint: string;
    scopes: DataApiScope[];
    statementsPerMinute: number;
    createdAt: number;
    /** The admin who made it: its writes are attributed to them. */
    createdBy: string;
    /** Their name as the workspace knows it now; null when unknown. */
    createdByName: string | null;
    expiresAt: number;
    lastUsedAt: number | null;
    /** Requests it made. */
    uses: number;
    revokedAt: number | null;
    /** An admin's id, or `system` (its maker stopped being an admin). */
    revokedBy: string | null;
}

/** `GET /api/data/api-tokens`: every token, newest first, revoked and expired ones too. */
export interface DataApiTokenList {
    tokens: DataApiTokenView[];
    scopes: readonly DataApiScope[];
    daysDefault: number;
    daysMax: number;
    statementsPerMinuteDefault: number;
    statementsPerMinuteMax: number;
}

/** `POST /api/data/api-tokens`: the token, whose value is shown this once. */
export interface CreatedDataApiToken {
    apiToken: DataApiTokenView;
    token: string;
}

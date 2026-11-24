import { COMPONENT_KINDS, isComponentRef, type IssueComponentOptions } from '@socio/shared/issues/issue-components';

import type { SqlConnection } from '../data';
import type { AuthedFetch } from '../net/authed-fetch';

import { type BoundedKindDefinition, type BoundedStore, createBoundedStore } from './bounded-kind';
import { SnapshotShapeError } from './errors';

// The plugins and apps a person may tag an issue with (CB-442): `GET
// /api/issues/components`, the reader's options (wildcards, then plugins,
// then apps), a bounded kind (bounded-kind.ts) with one item under
// OPTIONS_KEY, kept in cache.db so the picker shows the last list offline,
// with its age, and a filing written offline can still name them (the server
// checks each again as it files). It is read only while the picker shows
// (`use()`), never polled, as the web reads it when its picker mounts. A
// refusal or no answer keeps the last list; nothing here is ever "gone". No
// React Native: tests/sync runs it under Node.

export const ISSUE_COMPONENT_OPTIONS_KIND = 'issue-component-options';
/** The one key the options are kept under. */
export const OPTIONS_KEY = 'all';

function checkOptions(path: string, body: unknown): IssueComponentOptions {
    const value = body as Partial<IssueComponentOptions> | null;
    if (!value || typeof value !== 'object' || !Array.isArray(value.options)) {
        throw new SnapshotShapeError(path, 'no options.');
    }
    for (const option of value.options as unknown[]) {
        const o = option as Record<string, unknown> | null;
        if (
            !o ||
            typeof o.ref !== 'string' ||
            !isComponentRef(o.ref) ||
            typeof o.label !== 'string' ||
            !(COMPONENT_KINDS as readonly unknown[]).includes(o.kind) ||
            (o.state !== undefined && o.state !== 'live' && o.state !== 'disabled') ||
            (o.ownerName !== undefined && typeof o.ownerName !== 'string')
        ) {
            throw new SnapshotShapeError(path, 'an option that isn’t a component.');
        }
    }
    return { options: value.options };
}

export const ISSUE_COMPONENT_OPTIONS: BoundedKindDefinition<IssueComponentOptions> = {
    name: ISSUE_COMPONENT_OPTIONS_KIND,
    format: 1,
    bounds: { items: 1, chars: 2_000_000 },
    path: () => '/api/issues/components',
    parse: checkOptions,
};

export type IssueComponentOptionList = BoundedStore<IssueComponentOptions>;

export interface IssueComponentOptionsOptions {
    readonly db: SqlConnection;
    readonly fetch: AuthedFetch;
    readonly signal?: AbortSignal;
    readonly onError?: (error: unknown) => void;
    readonly now?: () => number;
}

/** Opens the scope's component options on its cache.db. */
export function createIssueComponentOptions(options: IssueComponentOptionsOptions): IssueComponentOptionList {
    return createBoundedStore<IssueComponentOptions>({
        definition: ISSUE_COMPONENT_OPTIONS,
        ...options,
        // The list is never gone: a refusal keeps the last one, with its age.
        isGone: () => false,
    });
}

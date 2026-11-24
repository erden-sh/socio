import type { Context as HonoContext } from 'hono';

import type { AccessSubjectKind } from '@socio/shared/operations/operations-access';

import type { AppEnv } from '../http/app-env.js';

/*
 * The access log's route options (CB-188), as the routes that are audited
 * pass them to Operations' `AccessAudit.audit`. Plain types, moved here from
 * `server/operations/contract.ts` (which re-exports them) so that the
 * features below Operations in the folder order (rooms, runs) can name them.
 */

/** What a view was about; no id for the whole workspace's rows. */
export type AccessSubject =
    | { kind: Exclude<AccessSubjectKind, 'workspace'>; id: string }
    | { kind: 'workspace'; id: null };

export interface AuditOptions {
    /** The endpoint, as the log names it (`ACCESS_SURFACE_LABELS`). */
    surface: string;
    /** What the request opens; undefined: nothing to log (it is refused). */
    subject: (c: HonoContext<AppEnv>) => AccessSubject | undefined;
    /** It answers content (messages), not only who did what when. */
    content: boolean;
    /** The range and filters it was opened with (`via` is added). */
    filters?: (c: HonoContext<AppEnv>) => Record<string, string>;
    /**
     * `always`: every request is an entry (opening a transcript or a trace).
     * `list`: once per viewer, surface, subject and filters in
     * `ACCESS_LOG_DEDUPE_MS`, so the next pages of a list add nothing.
     */
    once: 'always' | 'list';
}

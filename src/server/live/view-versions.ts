import type { User } from '@socio/shared/types';

import type { CountersShape } from './contract.js';

/**
 * The versions of the polled views live still serves, for `conditionalJson`
 * (@socio/foundation/http/conditional).
 * Each names every change counter its view reads for this user
 * (change-counters.ts), and anything else it depends on; the boot id, path
 * and query are added there. A version that misses something leaves a tab
 * stale, so each row of the dependency tables has a test
 * (tests/live-versions.test.ts), and the audit mode checks every `304` in
 * tests and the smoke.
 *
 * The other views' versions moved with their views, behind their tags:
 * the workspace's (`WorkspaceViews.workspaceVersion`),
 * the issue list's (`IssuesViews.listVersion`) and a Space's pages'
 * (`PagesViews.spacePagesVersion`).
 */

/** `GET /api/state`: settings, the user's tasks, memories and in-app notices. */
export const stateVersion = (store: { readonly counters: CountersShape }, user: User) =>
    `${user.id}|${store.counters.read(['settings', `tasks:${user.id}`, `memories:${user.id}`, `notices:${user.id}`])}`;

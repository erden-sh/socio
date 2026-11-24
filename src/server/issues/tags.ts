/**
 * The issue tracker's Board and auto-triage, whole, by tag: what its module
 * and routes use (other features use the contract's tags: `Board`,
 * `AutoTriageControl`). Moved from `layer.ts` so the module can read them
 * from the app's services: only entry files import a `layer.ts`, and
 * `contract.ts` can't name the classes. `layer.ts` builds them.
 */
import { Context } from 'effect';

import type { AutoTriage } from './auto-triage.js';
import type { SqliteBoard } from './services.js';

/**
 * The Board as `sqliteBoard` builds it, with every method its own feature
 * uses: what the root (`main.ts`, `BoardLive`) offers. Other features see the `Board` tag,
 * typed by the contract.
 */
export class SqliteBoardService extends Context.Service<SqliteBoardService, SqliteBoard>()(
    'socio/issues/SqliteBoardService',
) {}

/**
 * Auto-triage (CB-30) as the class, for what still holds it whole:
 * the issues module's routes and hooks (the composition's
 * `LegacyAutoTriage`).
 */
export class AutoTriageInstance extends Context.Service<AutoTriageInstance, AutoTriage>()(
    'socio/issues/AutoTriageInstance',
) {}

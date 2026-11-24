import type { ServerModule } from '../modules/contract.js';
import { People, Socios } from '../workspace/contract.js';

import { Souls } from './contract.js';
import { soulTools } from './tools.js';

/**
 * Socios' Souls (CB-179, CB-330): the Soul's table and the human edit path
 * (`soul-routes.ts`, mounted with the workspace routes) predate this
 * module; it adds the socio's own edit tool — `edit_own_soul` — that a
 * socio gets in its turn to rewrite its own persona, reusing the same
 * versioning (`SoulStore.saveSelf`). It owns no tables of its own.
 *
 * `dotTools` stays synchronous (its caller uses the value at once): it
 * reads the Souls the workspace holds (`Souls`), the socios and the
 * people from the app's services.
 */
export const soulsModule: ServerModule = {
    id: 'souls',
    dotTools: ({ services }, turn) =>
        soulTools({ souls: services.get(Souls), socios: services.get(Socios), people: services.get(People) }, turn),
};

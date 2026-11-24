/**
 * What `souls/` reads, by slice (it replaced `platform-needs.ts`): the Souls
 * (`Souls`), a socio (`Socios.dot`) and the people (`People.users`, for an
 * editor's name and role). `layer.ts` builds it from the tags; the workspace's
 * routes and the module's tool hook, which still get the platform, build it
 * from the workspace (`soulServicesOf`): the same objects either way.
 */
import type { PeopleShape, SociosShape } from '../workspace/contract.js';

import type { SoulsShape } from './contract.js';

/** The slices the Soul routes and the socio's own Soul tool read. */
export interface SoulServices {
    readonly souls: SoulsShape;
    readonly socios: Pick<SociosShape, 'dot'>;
    readonly people: Pick<PeopleShape, 'users'>;
}

/**
 * A workspace that holds its Souls (`WorkspaceStore`, which holds the
 * `SoulStore` built by the factory from `composition/workspace-parts.ts`).
 */
export type SoulsWorkspace = Pick<SociosShape, 'dot'> & Pick<PeopleShape, 'users'> & { readonly souls: SoulsShape };

/** The services over a workspace that holds its Souls; each read goes to it at the moment of use. */
export const soulServicesOf = (workspace: SoulsWorkspace): SoulServices => ({
    souls: workspace.souls,
    socios: workspace,
    people: workspace,
});

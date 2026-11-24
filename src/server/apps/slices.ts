/**
 * What `apps/` reads of other features, as their contracts' slices, so it
 * imports no other feature's classes:
 *
 * - `AppsWorkspace`: the workspace (`Socios`, `People`, `Spaces`, `Audit`,
 *   `Conversations`), Space access (spaces' `Access`) and the computers'
 *   records (`ComputerRecords`). `WorkspaceStore` satisfies it, and
 *   `layer.ts` builds it from the tags.
 * - `AppsPlugins`: the installed plugins, which share the apps host
 *   (`Plugins`), with the apps' settings the plugin service reads.
 */
import type { AppsSettings } from '@socio/foundation/apps/settings';

import type { ComputerRecordsShape } from '../computers/contract.js';
import type { PluginsShape } from '../plugins/contract.js';
import type { SpaceAccessShape } from '../spaces/contract.js';
import type { AuditShape, ConversationsShape, PeopleShape, SociosShape, SpacesShape } from '../workspace/contract.js';

export type AppsWorkspace = Pick<SociosShape, 'dot' | 'dots'> &
    Pick<PeopleShape, 'users'> &
    Pick<SpacesShape, 'spaces'> &
    Pick<AuditShape, 'audit'> &
    Pick<ConversationsShape, 'thread' | 'socioReader'> & {
        readonly spaceAccess: Pick<SpaceAccessShape, 'canRead' | 'canEdit' | 'reads' | 'readable'>;
        readonly computers: Pick<ComputerRecordsShape, 'permissions'>;
    };

/** The plugin service as the apps proxy and listener call it (`plugins/service.ts`'s `PluginService`). */
export type AppsPlugins = PluginsShape & {
    /** The apps host's settings, which plugins' origins share; unset while mini apps are off. */
    readonly appsSettings: AppsSettings | undefined;
};

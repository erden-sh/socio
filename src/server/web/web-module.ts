import { Media } from '../media/contract.js';
import type { ServerModule } from '../modules/contract.js';
import { WorkspaceSettings } from '../settings/contract.js';
import { UnfurlTools } from '../skills/contract.js';

import { WebConfig } from './contract.js';
import { webTools } from './web-tools.js';

/**
 * Web: declared-agent reads of public URLs (`http_get`, `http_json`, and
 * `/unfurl`'s `unfurl_link`, CB-230, and `unfurl_recursive`, CB-328), under
 * the same research permission as search, with the Dot's web identity and
 * audit tables. `/unfurl`'s tools are the skills' (`UnfurlTools`), read
 * from the app's services.
 */
export const webModule: Omit<ServerModule, 'id' | 'migrations'> = {
    // The workspace's settings, web's own `WebConfig` and where `/unfurl`
    // copies a card's media (`Media`), from the app's services; the reads
    // are on the modules' connection.
    dotTools: ({ db, services }, turn) => {
        if (!turn.dot.researchAllowed || !services.get(WorkspaceSettings).settings().researchAllowed) {
            return [];
        }
        const reads = services.get(WebConfig).readerOn(db);
        const unfurl = services.get(UnfurlTools);
        const unfurlOpts = { reads, media: services.get(Media), turn };
        return [
            ...webTools(reads, turn.dot.id, turn.check, turn.signal, turn.userId),
            ...unfurl.unfurlTools(unfurlOpts),
            ...unfurl.unfurlRecursiveTools(unfurlOpts),
        ];
    },
};

import { pluginUpdateAck } from '@socio/shared/plugins/plugin-update';

import type { PluginService } from '../../src/server/plugins/service.js';

/**
 * An update from the catalog as an admin confirms it (CB-531): with the
 * acknowledgment of the review this runtime computes now, when it adds anything.
 */
export function updateAcked(plugins: PluginService, id: string, by = 'system') {
    const review = plugins.updateReview(id);
    return plugins.updateFromCatalog(id, by, review?.additions.length ? { acknowledged: pluginUpdateAck(review) } : {});
}

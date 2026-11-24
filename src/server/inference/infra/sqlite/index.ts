import type { SqliteData } from '@socio/data/open';

import type { InferenceRepositories } from '../../domain/repositories.js';

import { SqliteInferenceBackends } from './backends.js';
import { SqliteByoConnections } from './connections.js';
import { SqliteInferenceSettings } from './settings.js';
import { SqliteInferenceTimings } from './timings.js';

/**
 * The Inference repositories on a migrated connection (CB-110): the only
 * code that reads or writes its tables. The turn path's reads (the default
 * backend, settings, a person's connection, response times) are prepared
 * once here.
 */
export function sqliteInferenceRepositories(data: SqliteData): InferenceRepositories {
    return {
        backends: new SqliteInferenceBackends(data),
        settings: new SqliteInferenceSettings(data),
        connections: new SqliteByoConnections(data),
        timings: new SqliteInferenceTimings(data),
    };
}

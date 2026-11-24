import { DataError } from '@socio/foundation/dataspace/data-error';
import type { DatasetDetail, DataSpaceState } from '@socio/shared/data-types';
import { isAdmin } from '@socio/shared/roles';
import type { User } from '@socio/shared/types';

import type { DataSpaceShape, DataspaceViewsShape } from './contract.js';

/**
 * The data views (`DataspaceViews`), moved here from `live/views/dataspace.ts`.
 * The pages read them through the tag; live no longer has its own copy.
 */

/**
 * `GET /api/data`: this user's datasets (their own and those shared with
 * their Spaces), their grants and usage; admins also get everyone's
 * usage. `files: false` leaves the file list out (`?files=false`).
 */
export function dataView(data: DataSpaceShape, user: User, { files = true }: { files?: boolean } = {}): DataSpaceState {
    return {
        datasets: data.datasetsFor(user.id),
        shared: data.sharedAreas(user.id),
        grants: data.grants(user.id),
        ...(files ? { files: data.listFiles({ kind: 'user', userId: user.id }) } : {}),
        usage: {
            limits: data.limits,
            own: data.usage(user.id),
            ...(isAdmin(user) ? { all: data.usageAll() } : {}),
        },
    };
}

/** `GET /api/data/datasets/:id`: one dataset this user may see; else null. */
export function datasetView(data: DataSpaceShape, userId: string, id: string): DatasetDetail | null {
    try {
        return data.detailFor(userId, id);
    } catch (error) {
        if (error instanceof DataError && error.status === 404) {
            return null;
        }
        throw error;
    }
}

/** Both views over one data space: what the `DataspaceViews` tag offers. */
export function dataspaceViews(data: DataSpaceShape): DataspaceViewsShape {
    return {
        dataView: (user, options) => dataView(data, user, options),
        datasetView: (userId, id) => datasetView(data, userId, id),
    };
}

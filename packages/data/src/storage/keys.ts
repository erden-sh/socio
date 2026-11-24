import { createHash } from 'node:crypto';

import type { StorageDriver } from '../object-store.js';

/** A user's directory name: their id when it is a safe name, else a hash. */
export function userDirName(userId: string) {
    return /^[A-Za-z0-9_-]{1,64}$/.test(userId)
        ? userId
        : `u-${createHash('sha256').update(userId).digest('hex').slice(0, 24)}`;
}

/** Everything of one tenant (the one workspace today) in the bucket. */
export const tenantPrefix = (tenantId: string) => `tenants/${tenantId}/`;

/**
 * Where a data space file's sealed bytes are: under the tenant, then the
 * user, by file id (never its name). Locally it is the pre-CB-54 layout
 * under USER_DATA_DIR, `<user>/files/<id>.bin`.
 */
export function objectKey(driver: StorageDriver, tenantId: string, userId: string, fileId: string) {
    return driver === 's3'
        ? `${tenantPrefix(tenantId)}users/${userDirName(userId)}/files/${fileId}`
        : `${userDirName(userId)}/files/${fileId}.bin`;
}

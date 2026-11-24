import { createHash } from 'node:crypto';

/**
 * A plugin task's revision (CB-370): a digest of what its container runs,
 * the image, the environment, the secrets and the mounts, so a task started
 * before a service update (a new image, or the same image with new settings)
 * never counts as one of the update's. The socket proxy computes it before it
 * removes `Env`, `Secrets` and `Configs` from a response (`SocioRevision`), so
 * the runtime compares revisions without ever seeing those values; on a
 * direct socket (development) the runtime computes it itself.
 */
export const REVISION_FIELD = 'SocioRevision';

const sorted = (list: unknown) => (Array.isArray(list) ? list.map((item) => JSON.stringify(item)).sort() : []);

/** The revision of a Swarm `ContainerSpec`: its `SocioRevision` when the socket proxy set one. */
export function containerRevision(container: Record<string, unknown> | undefined): string | undefined {
    if (!container) {
        return undefined;
    }
    const given = container[REVISION_FIELD];
    if (typeof given === 'string') {
        return given;
    }
    return createHash('sha256')
        .update(
            JSON.stringify({
                image: typeof container.Image === 'string' ? container.Image : '',
                env: sorted(container.Env),
                secrets: sorted(container.Secrets),
                configs: sorted(container.Configs),
                mounts: sorted(container.Mounts),
            }),
        )
        .digest('hex');
}

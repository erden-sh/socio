// Only the supervisor imports this module (POST /computers/:botId/destroy, harden-supervisor.mjs).
//
// Removes one socio's computer for good: its container and all three named
// volumes (profile, workspace, private). OpenBot's own `reset` keeps the
// workspace and private volumes on purpose; this is for a socio that is gone
// (Socio's operator purge, purge-cli.ts). Each object is removed only when its
// labels say this supervisor, in this namespace, made it for this Bot, so a
// same-named container or volume of anyone else is left alone. Removing what
// is already gone is fine, so a retried purge finishes.

const missing = (error) => error?.statusCode === 404;

/**
 * `ours(labels)`: the supervisor's own ownership check (owner label and
 * namespace); `botLabel`: the label naming the Bot. Returns what was removed.
 */
export async function destroyComputer(docker, names, ours, botLabel) {
    const mine = (labels) => ours(labels) && labels?.[botLabel] === names.botId;
    let container = false;
    try {
        const info = await docker.getContainer(names.container).inspect();
        if (!mine(info.Config?.Labels)) {
            throw Object.assign(new Error('The container with that name is not this computer.'), { refused: true });
        }
        await docker.getContainer(names.container).remove({ force: true, v: false });
        container = true;
    } catch (error) {
        if (error?.refused || !missing(error)) {
            throw error;
        }
    }
    const volumes = [];
    for (const name of [names.profileVolume, names.workspaceVolume, names.privateVolume]) {
        try {
            const info = await docker.getVolume(name).inspect();
            if (!mine(info.Labels)) {
                continue;
            }
            await docker.getVolume(name).remove();
            volumes.push(name);
        } catch (error) {
            if (!missing(error)) {
                throw error;
            }
        }
    }
    return { botId: names.botId, container, volumes };
}

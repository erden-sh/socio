// Only the supervisor imports this module; it never runs inside a socio's shell.
const cpuHistory = new Map();
const finite = (value) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null);
const empty = () => ({
    cpuPercent: null,
    memoryBytes: null,
    memoryLimitBytes: null,
    volumeBytes: null,
});
async function bounded(work, milliseconds = 4000) {
    let timer;
    const controller = new globalThis.AbortController();
    try {
        return await Promise.race([
            Promise.resolve().then(() => work(controller.signal)),
            new Promise((_, reject) => {
                timer = globalThis.setTimeout(() => {
                    controller.abort();
                    reject(Error('Resource measurement timed out'));
                }, milliseconds);
                timer.unref?.();
            }),
        ]);
    } finally {
        globalThis.clearTimeout(timer);
    }
}

/** Docker CLI CPU/working-set calculations; absent counters remain unavailable. */
export function resourceValues(stats, limit, previous) {
    const current = stats.cpu_stats ?? {};
    const prior = stats.precpu_stats?.system_cpu_usage ? stats.precpu_stats : previous;
    const cpu = finite(current.cpu_usage?.total_usage),
        oldCpu = finite(prior?.cpu_usage?.total_usage);
    const system = finite(current.system_cpu_usage),
        oldSystem = finite(prior?.system_cpu_usage);
    const cores =
        finite(current.online_cpus) ||
        (Array.isArray(current.cpu_usage?.percpu_usage) ? current.cpu_usage.percpu_usage.length : null);
    const values = empty();
    if (
        cpu !== null &&
        oldCpu !== null &&
        system !== null &&
        oldSystem !== null &&
        system > oldSystem &&
        cpu >= oldCpu &&
        cores > 0
    )
        values.cpuPercent = ((cpu - oldCpu) / (system - oldSystem)) * cores * 100;
    const memory = stats.memory_stats ?? {};
    const usage = finite(memory.usage);
    const cache =
        finite(memory.stats?.total_inactive_file) ??
        finite(memory.stats?.inactive_file) ??
        finite(memory.stats?.cache) ??
        0;
    if (usage !== null) values.memoryBytes = cache < usage ? usage - cache : usage;
    if (finite(limit) !== null) values.memoryLimitBytes = limit;
    return values;
}

/**
 * Read only the derived, owned container. Volume sizes are not read here:
 * Docker's df walks every volume on the host and takes minutes, so the
 * disk usage proxy (disk-usage-proxy.mjs) reads it every 15 minutes
 * instead (CB-197). `volumeBytes` stays in the answer, always null, for
 * apps that expect it.
 */
export async function readComputerStats(docker, names, ours, botLabel) {
    const container = docker.getContainer(names.container);
    let info;
    try {
        info = await bounded((abortSignal) => container.inspect({ abortSignal }));
    } catch (error) {
        if (error?.statusCode === 404) return null;
        throw error;
    }
    const owned = (state) =>
        state &&
        ours(state.Config?.Labels) &&
        state.Config?.Labels?.[botLabel] === names.botId &&
        state.Name?.replace(/^\//, '') === names.container;
    if (!owned(info)) return null;
    if (typeof info.Id !== 'string' || !info.Id || typeof info.State?.StartedAt !== 'string' || !info.State.StartedAt)
        return null;
    const instance = String(info.Id ?? '') + ':' + String(info.State?.StartedAt ?? '');
    if (!info.State?.Running)
        return {
            botId: names.botId,
            container: names.container,
            instance,
            running: false,
            values: empty(),
        };
    const stats = await bounded((abortSignal) => container.stats({ stream: false, 'one-shot': true, abortSignal }));
    const after = await bounded((abortSignal) => container.inspect({ abortSignal }));
    if (
        !owned(after) ||
        !after.State?.Running ||
        after.Id !== info.Id ||
        after.State?.StartedAt !== info.State?.StartedAt
    )
        return null;
    const values = resourceValues(stats, info.HostConfig?.Memory, cpuHistory.get(instance));
    cpuHistory.delete(instance);
    cpuHistory.set(instance, stats.cpu_stats);
    if (cpuHistory.size > 1024) cpuHistory.delete(cpuHistory.keys().next().value);
    return {
        botId: names.botId,
        container: names.container,
        instance,
        running: true,
        values,
    };
}

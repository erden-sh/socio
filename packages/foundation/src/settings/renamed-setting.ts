/**
 * A setting by its name, else by the name it had before a rename (CB-325
 * renamed the `DISPATCH_*` settings that outlived dispatch), with a
 * one-line deprecation warning that names only the setting, never its
 * value. Each old name is read for one release, then removed.
 */
export function renamedSetting(
    env: Record<string, string | undefined>,
    name: string,
    old: string,
    warn: (line: string) => void,
) {
    const value = env[name]?.trim();
    if (value) {
        return value;
    }
    const legacy = env[old]?.trim();
    if (legacy) {
        warn(`${old} is deprecated: rename it ${name}. The old name is read for one more release.`);
        return legacy;
    }
    return undefined;
}

/**
 * A setting that is going away with nothing to rename it to (Socio
 * Secrets phase 2 retired `PLUGIN_SERVICE_TOKEN`): its value while it is
 * still set, with the same kind of one-line warning, naming the setting
 * and what replaces it, never its value. Read for one release, then removed.
 */
export function retiredSetting(
    env: Record<string, string | undefined>,
    name: string,
    instead: string,
    warn: (line: string) => void,
) {
    const value = env[name]?.trim();
    if (value) {
        warn(`${name} is deprecated: ${instead} It is read for one more release; then remove it.`);
        return value;
    }
    return undefined;
}

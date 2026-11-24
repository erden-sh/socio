// Build-time patches of the pinned OpenBot source fail closed: each one names
// the exact upstream text it replaces, and refuses to build when that text is
// missing or appears more than once.
export function replaceOnce(source, before, after, contract) {
    if (source.split(before).length !== 2) {
        throw new Error(`Pinned OpenBot ${contract} contract changed; review before building.`);
    }

    return source.replace(before, () => after);
}

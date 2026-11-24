import { PALETTE_GROUP_LIMIT } from '@socio/shared/search/rank';

import type { PaletteCommand, PaletteSearchAnswer } from '../modules/types';

// The ranking (`searchCommands`) is shared with the app: @socio/shared/search/rank.

/** Results grouped for display, groups in the order of their best result. */
export function groupResults(results: readonly PaletteCommand[]) {
    const groups = new Map<string, PaletteCommand[]>();
    for (const command of results) {
        const list = groups.get(command.group) ?? [];
        list.push(command);
        groups.set(command.group, list);
    }
    return [...groups].map(([heading, items]) => ({ heading, items }));
}

/**
 * The instant results with the server's added: rows already listed keep
 * their place and take the server's line (snippet and freshness); the
 * server's other hits follow in their groups, at most
 * `PALETTE_GROUP_LIMIT` per group. `corrected` says where the correction
 * row goes: before the first added hit of its group.
 */
export function mergeSearchResults(local: readonly PaletteCommand[], answers: readonly PaletteSearchAnswer[]) {
    const found = answers.flatMap((answer) => answer.commands);
    const byId = new Map(found.map((command) => [command.id, command]));
    const listed = new Set(local.map((command) => command.id));
    const perGroup = new Map<string, number>();
    const added = found.filter((command) => {
        if (listed.has(command.id)) {
            return false;
        }
        listed.add(command.id);
        const count = perGroup.get(command.group) ?? 0;
        perGroup.set(command.group, count + 1);
        return count < PALETTE_GROUP_LIMIT;
    });
    const fixed = answers.find((answer) => answer.corrected);
    const first = fixed && added.find((command) => fixed.commands.includes(command));
    return {
        results: [
            ...local.map((command) => {
                const server = byId.get(command.id);
                return server
                    ? {
                          ...command,
                          note: server.note ?? command.note,
                          detail: server.detail ?? command.detail,
                      }
                    : command;
            }),
            ...added,
        ],
        corrected: fixed?.corrected && first ? { words: fixed.corrected, group: first.group, before: first.id } : null,
    };
}

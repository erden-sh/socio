// The purge CLI's input and output (purge-cli.ts): the list and protect
// files, read and checked, and the plan as the operator reads it.
import { readFileSync } from 'node:fs';

import { PURGE_KINDS, type PurgeList, type PurgePlan } from './purge.js';

export const stamp = (now: Date) => now.toISOString().replaceAll(/[-:]/g, '').replace('T', '-').slice(0, 15);

/** The list file, checked: only the known kinds, each a list of ids. */
export function readPurgeList(path: string): PurgeList {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    const list: PurgeList = {};
    for (const [key, value] of Object.entries(raw)) {
        if (key === 'cascade') {
            if (
                typeof value !== 'boolean' &&
                !(Array.isArray(value) && value.every((kind) => (PURGE_KINDS as readonly string[]).includes(kind)))
            ) {
                throw new Error(`cascade must be true, false or a list of ${PURGE_KINDS.join(', ')}.`);
            }
            list.cascade = value as PurgeList['cascade'];
        } else if ((PURGE_KINDS as readonly string[]).includes(key)) {
            if (!Array.isArray(value) || !value.every((id) => typeof id === 'string')) {
                throw new Error(`${key} must be a list of ids.`);
            }
            list[key as (typeof PURGE_KINDS)[number]] = value as string[];
        } else if (!key.startsWith('$')) {
            throw new Error(`Unknown key ${key}: use ${PURGE_KINDS.join(', ')} and cascade.`);
        }
    }
    return list;
}

export function readProtectFile(path: string) {
    return readFileSync(path, 'utf8')
        .split('\n')
        .map((line) => line.replace(/#.*/, '').trim())
        .filter(Boolean);
}

/** The plan as the operator reads it. */
export function planLines(plan: PurgePlan, applying: boolean) {
    const lines: string[] = [];
    const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
    lines.push(
        applying ? 'Purge plan (applying):' : 'Purge plan (dry run: nothing changes; add --apply to remove it):',
    );
    lines.push(
        `Records: ${PURGE_KINDS.map((kind) => `${kind} ${plan.targets[kind].length}${plan.cascaded[kind].length ? ` (${plan.cascaded[kind].length} cascaded)` : ''}`).join(', ')}`,
    );
    for (const kind of PURGE_KINDS) {
        if (plan.cascaded[kind].length) {
            lines.push(`Cascaded ${kind}: ${plan.cascaded[kind].join(' ')}`);
        }
    }
    lines.push('Rows deleted, by table:');
    for (const entry of plan.tables) {
        lines.push(`  ${entry.table}\t${entry.rows}`);
    }
    lines.push(`  total\t${sum(plan.tables.map((entry) => entry.rows))}`);
    lines.push(
        `Files deleted: ${plan.files.length}, ${sum(plan.files.map((file) => file.bytes))} bytes (local); ${plan.objects.length} object(s), ${sum(plan.objects.map((object) => object.bytes))} bytes (stored).`,
    );
    for (const file of plan.files) {
        lines.push(`  file\t${file.path}\t${file.bytes}`);
    }
    for (const object of plan.objects) {
        lines.push(`  object\t${object.key}\t${object.bytes}`);
    }
    if (plan.kept.length) {
        lines.push('Kept (history that will name an id that no longer resolves):');
        for (const entry of plan.kept) {
            lines.push(`  ${entry.table}.${entry.column}\t${entry.rows}`);
        }
    }
    if (plan.refusals.length) {
        lines.push('Refused:');
        lines.push(...plan.refusals.map((refusal) => `  ${refusal}`));
    }
    return lines;
}

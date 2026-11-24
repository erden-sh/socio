import { Directory, File, Paths } from 'expo-file-system';
import { useEffect } from 'react';
import { Platform } from 'react-native';

import { processStartTime, reportFullyDrawn, wasPrewarmed } from '../../modules/socio-device';
import { registryFile, workspaceLayout } from '../data/layout';
import { type ColdStartMarks, coldStartLine, coldStartRecord } from '../perf/cold-start';
import type { ScopeOpenTimings } from '../sync/scope';

import { BUILD_VARIANT } from './variant';

// The cold-start marks on the phone (src/perf/cold-start.ts): the
// process's start (socio-device), the store's open (device-store.ts), the
// first scope's opens and rows (active-scope.ts), and the first frame with data,
// which the chat list and Home mark with `useFirstFrameWithData`. Once per
// process, after that frame: on Android, reportFullyDrawn() for the system's
// cross-check (all variants); in development and preview, the record goes to
// one log line and is appended to `<documents>/perf/cold-start.jsonl`, which
// apps/mobile/perf/ reads back. It holds timings, row counts and file sizes,
// nothing of the person, and is outside `socio/`. Production writes nothing.

const RECORDS = Platform.OS !== 'web' && BUILD_VARIANT !== 'production';

/** The marks file, under the documents directory. */
export const COLD_START_FILE = 'perf/cold-start.jsonl';

const marks: ColdStartMarks = (() => {
    const jsAt = Date.now();
    try {
        return { processStartAt: processStartTime(), prewarmed: wasPrewarmed(), jsAt };
    } catch {
        // A development client built before socio-device: no marks.
        return { processStartAt: Number.NaN, prewarmed: false, jsAt };
    }
})();
let workspaceId: string | null = null;
let framed = false;

/** The store opened (launch.ts's openMs). */
export function markStoreOpened(ms: number): void {
    marks.storeMs ??= ms;
}

/** The first scope opened, with its timings. Later scopes (a switch) don't count. */
export function markScopeOpened(id: string, timings: ScopeOpenTimings): void {
    if (marks.scope === undefined) {
        marks.scope = timings;
        workspaceId = id;
    }
}

/** Bytes of a database file and its -wal, 0 for what isn't there. */
function fileBytes(directory: string, name: string): number {
    let total = 0;
    for (const suffix of ['', '-wal']) {
        const file = new File(`${directory.replace(/\/$/, '')}/${name}${suffix}`);
        total += file.exists ? (file.size ?? 0) : 0;
    }
    return total;
}

function write(screen: string, at: number): void {
    if (!RECORDS || workspaceId === null) {
        return;
    }
    marks.firstFrame = { at, screen };
    const root = Paths.document.uri;
    const layout = workspaceLayout(root, workspaceId);
    const registry = registryFile(root);
    const record = coldStartRecord(
        marks,
        {
            platform: Platform.OS,
            os: Platform.OS === 'android' ? String(Platform.constants.Release) : String(Platform.Version),
            variant: BUILD_VARIANT,
        },
        {
            cache: fileBytes(layout.directory, layout.cache.name),
            user: fileBytes(layout.directory, layout.user.name),
            registry: fileBytes(registry.directory, registry.name),
        },
    );
    if (record === null || Number.isNaN(record.at)) {
        return;
    }
    const line = coldStartLine(record);
    console.log(line);
    const folder = new Directory(Paths.document, 'perf');
    folder.create({ intermediates: true, idempotent: true });
    const file = new File(Paths.document, COLD_START_FILE);
    if (!file.exists) {
        file.create();
    }
    file.write(`${line.slice(line.indexOf('{'))}\n`, { append: true });
}

/** The first frame with data, once per process: the next frame after the commit that drew it. */
function markFirstFrame(screen: string): void {
    if (framed) {
        return;
    }
    framed = true;
    requestAnimationFrame(() => {
        const at = Date.now();
        reportFullyDrawn().catch(() => {});
        try {
            write(screen, at);
        } catch (error) {
            console.warn('[cold-start] the marks were not written', error);
        }
    });
}

/**
 * Marks the first frame with data for the cold-start timing: call it from a
 * screen the shell can open on (the chat list, Home), with whether the rows it
 * draws are in. The first screen to draw its data wins.
 */
export function useFirstFrameWithData(screen: string, hasData: boolean): void {
    useEffect(() => {
        if (hasData) {
            markFirstFrame(screen);
        }
    }, [screen, hasData]);
}

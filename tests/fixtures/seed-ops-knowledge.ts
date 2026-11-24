import type { DatabaseSync } from 'node:sqlite';

import type { OpsRequestRow } from '@socio/shared/operations/operations-knowledge';

import type {
    DataAccessFact,
    DatasetDayFact,
    DatasetFact,
    LifetimeFact,
    OwnerFilesFact,
    PageEditFact,
    PageFact,
    PageUseFact,
    SearchDayFact,
    SpaceFact,
} from '../../src/server/operations/domain/knowledge.js';
import type { KnowledgeFacts } from '../../src/server/operations/infra/memory/knowledge.js';

import { PEOPLE, random, SOCIOS } from './seed-ops-runs.js';

// Space pages, their edits, use and searches; datasets with their sizes
// per day and access; files, attachments and app versions; capability
// requests: what the Knowledge and Capabilities ETL reads (CB-191),
// written into a database `openAppDatabase` made. It returns the facts it
// meant, in MemoryOpsReader's shape, made from what it wrote rather than
// by reading the rows back.

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const hour = (at: number) => Math.floor(at / HOUR) * HOUR;

export interface SeededKnowledge {
    facts: Required<
        Pick<
            KnowledgeFacts,
            | 'pages'
            | 'use'
            | 'edits'
            | 'searchDays'
            | 'access'
            | 'datasets'
            | 'datasetDays'
            | 'lifetimes'
            | 'owners'
            | 'requests'
        >
    >;
    /** Every Space in the database, as the dimensions hold them. */
    spaces(): SpaceFact[];
}

export function seedKnowledge(
    db: DatabaseSync,
    { now, pages: pageCount = 1200, seed = 11 }: { now: number; pages?: number; seed?: number },
): SeededKnowledge {
    const rand = random(seed);
    const pick = <T>(list: readonly T[]) => list[Math.floor(rand() * list.length)]!;
    const between = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo));
    // Before the ETL's commit lag, so every row is copied at once.
    const latest = now - 5 * 60_000;
    db.exec('BEGIN');

    db.prepare(
        "INSERT OR IGNORE INTO spaces (id, name, description, createdAt) VALUES ('space-3', 'Empty', '', ?)",
    ).run(now - 300 * DAY);
    db.prepare(
        "INSERT OR IGNORE INTO spaces (id, name, description, createdAt, deletedAt) VALUES ('space-gone', 'Gone', '', ?, ?)",
    ).run(now - 300 * DAY, now - 10 * DAY);

    // Pages: live, edited, used, deleted; text of every length.
    const pages: PageFact[] = [];
    const use: PageUseFact[] = [];
    const page = db.prepare(
        'INSERT INTO pages (id, spaceId, parentId, title, content, revision, createdAt, updatedAt, sourceThreadId, createdBy, deletedAt) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, NULL, ?, ?)',
    );
    const useRow = db.prepare('INSERT INTO page_use (pageId, score, scoredAt, usedAt) VALUES (?, 1, ?, ?)');
    for (let index = 0; index < pageCount; index++) {
        const id = `page-${String(index).padStart(5, '0')}`;
        const spaceId = pick(['space-1', 'space-1', 'space-2', 'space-gone']);
        const createdAt = latest - between(0, 400) * DAY - between(0, DAY);
        const updatedAt = Math.min(latest, createdAt + between(0, 200) * DAY);
        const content = 'x'.repeat(between(0, 3000));
        const deleted = rand() < 0.1 ? updatedAt + 1000 : null;
        const revision = between(1, 9);
        const title = `Page ${index}`;
        page.run(id, spaceId, title, content, revision, createdAt, updatedAt, pick([...PEOPLE, null]), deleted);
        if (rand() < 0.4) {
            const usedAt = Math.min(latest, updatedAt + between(0, 100) * DAY);
            useRow.run(id, usedAt, usedAt);
            use.push({ pageId: id, usedAt });
        }
        if (deleted === null) {
            pages.push({
                pageId: id,
                spaceId,
                title,
                chars: content.length,
                revision,
                createdAt,
                updatedAt,
            });
        }
    }

    // Edits: people's, socios' (`dot:<id>`) and unknown ones.
    const edits: PageEditFact[] = [];
    const edit = db.prepare(
        "INSERT INTO page_revisions (id, pageId, spaceId, revision, title, body, encoding, authorId, createdAt, replacedAt) VALUES (?, ?, ?, 1, 'Old', X'00', 'utf8', ?, ?, ?)",
    );
    for (let id = 1; id <= 1300; id++) {
        const pageId = `page-${String(between(0, pageCount)).padStart(5, '0')}`;
        const spaceId = pick(['space-1', 'space-2', 'space-gone']);
        const author = pick([...PEOPLE, ...SOCIOS.map((socio) => `dot:${socio.id}`), null]);
        const at = latest - between(0, 120 * DAY);
        edit.run(id, pageId, spaceId, author, at - DAY, at);
        edits.push({
            revisionId: id,
            pageId,
            spaceId,
            authorKind: !author ? 'unknown' : author.startsWith('dot:') ? 'socio' : 'person',
            authorId: author?.startsWith('dot:') ? author.slice(4) : author,
            at,
        });
    }

    // Search timings per UTC day.
    const searchDays: SearchDayFact[] = [];
    const search = db.prepare(
        'INSERT INTO page_search_daily (day, queries, empty, corrected, trigram, maxMs, histogram, sizes) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)',
    );
    for (let back = 0; back < 40; back++) {
        if (rand() < 0.2) {
            continue;
        }
        const at = Math.floor(latest / DAY) * DAY - back * DAY;
        const histogram: Record<number, number> = {};
        let queries = 0;
        for (let b = 0; b < 4; b++) {
            const bucket = between(10, 40);
            const n = between(1, 30);
            histogram[bucket] = (histogram[bucket] ?? 0) + n;
            queries += n;
        }
        const day = {
            at,
            queries,
            empty: between(0, queries),
            corrected: between(0, 5),
            trigram: between(0, 5),
            maxMs: between(1, 900) + 0.123456,
            histogram,
        };
        search.run(
            new Date(at).toISOString().slice(0, 10),
            day.queries,
            day.empty,
            day.corrected,
            day.trigram,
            day.maxMs,
            JSON.stringify(histogram),
        );
        searchDays.push(day);
    }

    // Datasets, their sizes per day, and their access.
    const datasets: DatasetFact[] = [];
    const datasetDays: DatasetDayFact[] = [];
    const dataset = db.prepare(
        'INSERT INTO data_datasets (id, ownerUserId, name, scratchForDotId, sizeBytes, historyBytes, tableCount, createdAt, updatedAt, deletedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    const day = db.prepare(
        'INSERT INTO data_dataset_days (datasetId, day, sizeBytes, historyBytes, tableCount, measuredAt) VALUES (?, ?, ?, ?, ?, ?)',
    );
    for (let index = 0; index < 40; index++) {
        const id = `ds-${String(index).padStart(3, '0')}`;
        const ownerId = pick(PEOPLE);
        const createdAt = latest - between(5, 200) * DAY;
        const deletedAt = rand() < 0.15 ? createdAt + between(1, 4) * DAY : null;
        let size = 0;
        let history = 0;
        let measuredAt = createdAt;
        for (let n = 0; n < between(1, 6); n++) {
            // One measurement a day at most: a day's row is updated in place.
            const next = measuredAt + between(1, 30) * DAY;
            if (next >= latest) {
                break;
            }
            measuredAt = next;
            size += between(0, 30) * 1024 * 1024;
            history += between(0, 3) * 1024 * 1024;
            day.run(id, Math.floor(measuredAt / DAY), size, history, 2, measuredAt);
            datasetDays.push({
                datasetId: id,
                sizeBytes: size,
                historyBytes: history,
                measuredAt,
            });
        }
        const fact: DatasetFact = {
            id,
            ownerId,
            name: `Dataset ${index}`,
            scratch: index % 7 === 0,
            sizeBytes: size,
            historyBytes: history,
            tables: 2,
            createdAt,
            updatedAt: measuredAt,
            deletedAt,
        };
        dataset.run(
            id,
            ownerId,
            fact.name,
            fact.scratch ? `socio-${index}` : null,
            size,
            history,
            2,
            createdAt,
            measuredAt,
            deletedAt,
        );
        datasets.push(fact);
    }
    const access: DataAccessFact[] = [];
    const audit = db.prepare(
        "INSERT INTO data_audit (id, ownerUserId, actorKind, actorId, dotId, datasetId, target, action, outcome, detail, createdAt) VALUES (?, ?, ?, ?, ?, ?, 'secret target', ?, ?, 'secret detail', ?)",
    );
    for (let index = 0; index < 1100; index++) {
        // Not in time order, and several in one millisecond.
        const id = `${between(0, 1e9).toString(36)}-${index}`;
        const kind = pick(['user', 'dot', 'dot', 'token', 'system']);
        const ownerId = pick(PEOPLE);
        const row: DataAccessFact = {
            id,
            at: latest - between(0, 90 * DAY),
            ownerId,
            actorKind: kind,
            actorId: kind === 'user' ? ownerId : kind === 'dot' ? pick(SOCIOS).id : null,
            socioId: kind === 'dot' ? pick(SOCIOS).id : null,
            datasetId: rand() < 0.9 ? pick(datasets).id : null,
            action: pick(['query', 'describe', 'files_get', 'create_dataset']),
            outcome: pick(['ok', 'ok', 'ok', 'denied', 'error']),
        };
        if (index % 10 === 0 && access.length) {
            row.at = access.at(-1)!.at;
        }
        audit.run(
            row.id,
            row.ownerId,
            row.actorKind,
            row.actorId,
            row.socioId,
            row.datasetId,
            row.action,
            row.outcome,
            row.at,
        );
        access.push(row);
    }

    // Files (with kept versions), chat attachments and app versions.
    const lifetimes = new Map<string, LifetimeFact>();
    const lifetime = (kind: LifetimeFact['kind'], createdAt: number, deletedAt: number | null, bytes: number) => {
        const key = `${kind} ${hour(createdAt)} ${deletedAt === null ? '' : hour(deletedAt)}`;
        const found = lifetimes.get(key) ?? {
            kind,
            createdAt: hour(createdAt),
            deletedAt: deletedAt === null ? null : hour(deletedAt),
            items: 0,
            bytes: 0,
        };
        found.items++;
        found.bytes += bytes;
        lifetimes.set(key, found);
    };
    for (const row of datasets) {
        lifetime('datasets', row.createdAt, row.deletedAt, 0);
    }
    const owners = new Map<string, OwnerFilesFact>();
    const file = db.prepare(
        "INSERT INTO data_files (id, ownerUserId, path, size, storedSize, mediaType, createdAt, updatedAt, deletedAt) VALUES (?, ?, ?, ?, ?, 'text/plain', ?, ?, ?)",
    );
    for (let index = 0; index < 300; index++) {
        const ownerId = pick(PEOPLE);
        const size = between(10, 5_000_000);
        const createdAt = latest - between(0, 300 * DAY);
        const deletedAt = rand() < 0.2 ? Math.min(latest, createdAt + between(1, 50 * DAY)) : null;
        file.run(`file-${index}`, ownerId, `notes/${index}.txt`, size, size + 32, createdAt, createdAt, deletedAt);
        lifetime('files', createdAt, deletedAt, size + 32);
        if (deletedAt === null) {
            const found = owners.get(ownerId) ?? {
                ownerId,
                files: 0,
                bytes: 0,
                largest: 0,
            };
            found.files++;
            found.bytes += size + 32;
            found.largest = Math.max(found.largest, size);
            owners.set(ownerId, found);
        }
    }
    const attachment = db.prepare(
        "INSERT INTO media_attachments (id, fileId, ownerUserId, name, mediaType, kind, size, source, createdAt, deletedAt) VALUES (?, ?, ?, 'a.png', 'image/png', 'image', ?, 'web', ?, ?)",
    );
    for (let index = 0; index < 120; index++) {
        const size = between(1000, 2_000_000);
        const createdAt = latest - between(0, 200 * DAY);
        const deletedAt = rand() < 0.1 ? Math.min(latest, createdAt + DAY) : null;
        attachment.run(`att-${index}`, `file-${index}`, pick(PEOPLE), size, createdAt, deletedAt);
        lifetime('attachments', createdAt, deletedAt, size);
    }
    const app = db.prepare(
        "INSERT INTO apps (id, slug, name, dotId, ownerUserId, port, status, createdAt, updatedAt, deletedAt) VALUES (?, ?, 'App', 'socio-a', 'alice', ?, 'promoted', ?, ?, ?)",
    );
    const version = db.prepare(
        "INSERT INTO app_versions (appId, version, manifest, bundlePath, sha256, sizeBytes, files, createdAt) VALUES (?, ?, '{}', 'b', 'h', ?, 3, ?)",
    );
    for (let index = 0; index < 6; index++) {
        const createdAt = latest - between(10, 200) * DAY;
        const deletedAt = index === 5 ? latest - DAY : null;
        app.run(`app-${index}`, `app-${index}`, 4000 + index, createdAt, createdAt, deletedAt);
        for (let v = 1; v <= 3; v++) {
            const size = between(10_000, 900_000);
            const at = createdAt + v * DAY;
            version.run(`app-${index}`, v, size, at);
            lifetime('apps', at, deletedAt, size);
        }
    }

    // Capability requests, with their board items and who asked.
    const requests: OpsRequestRow[] = [];
    const issue = db.prepare(
        "INSERT INTO issues (id, number, title, body, status, priority, kind, reporterId, createdAt, updatedAt, deletedAt) VALUES (?, ?, ?, 'secret body', ?, 'medium', 'request', 'alice', ?, ?, ?)",
    );
    const request = db.prepare('INSERT INTO dot_requests (issueId, key, capability, createdAt) VALUES (?, ?, ?, ?)');
    const asker = db.prepare(
        "INSERT INTO dot_request_requesters (id, issueId, dotId, userId, why, example, createdAt) VALUES (?, ?, ?, ?, 'secret why', 'secret example', ?)",
    );
    for (let index = 0; index < 70; index++) {
        const id = `issue-${String(index).padStart(3, '0')}`;
        const createdAt = latest - between(1, 100) * DAY;
        const status = pick(['triage', 'open', 'done', 'wont_fix']);
        const gone = index === 69;
        issue.run(id, index + 1, `Send email ${index}`, status, createdAt, createdAt, gone ? latest : null);
        request.run(id, `send-email-${index}`, `Send email ${index}`, createdAt);
        const pairs = new Set<string>();
        let lastAt = createdAt;
        for (let n = 0; n < between(0, 5); n++) {
            const socio = pick(SOCIOS).id;
            const person = pick(PEOPLE);
            if (pairs.has(`${socio} ${person}`)) {
                continue;
            }
            pairs.add(`${socio} ${person}`);
            // Two askers at once, now and then: the list's keyset breaks the tie.
            const at = index % 9 === 0 ? createdAt : createdAt + between(0, DAY);
            lastAt = Math.max(lastAt, at);
            asker.run(`${id}-${n}`, id, socio, person, at);
        }
        if (gone) {
            continue;
        }
        requests.push({
            issueId: id,
            number: index + 1,
            title: `Send email ${index}`,
            status,
            capability: `Send email ${index}`,
            createdAt,
            requesters: pairs.size,
            socios: new Set([...pairs].map((pair) => pair.split(' ')[0])).size,
            people: new Set([...pairs].map((pair) => pair.split(' ')[1])).size,
            lastAt,
        });
    }
    db.exec('COMMIT');

    return {
        facts: {
            pages,
            use,
            edits,
            searchDays,
            access,
            datasets,
            datasetDays,
            lifetimes: [...lifetimes.values()],
            owners: [...owners.values()],
            requests,
        },
        spaces: () =>
            (db.prepare('SELECT id, name, deletedAt FROM spaces ORDER BY id').all() as unknown as SpaceFact[]).map(
                (space) => ({ ...space }),
            ),
    };
}

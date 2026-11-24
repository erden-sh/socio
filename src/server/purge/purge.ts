// The purge: removes people, socios, Spaces, pages, datasets, apps, jobs,
// rooms and conversations for good, with everything that belongs to them
// (references.ts says what that is). Whoever runs the server runs it with
// an explicit id list (purge-cli.ts); the app itself never calls it.
//
// It plans first, always: what each table loses, the files and objects that
// go, and the history rows that stay naming ids that no longer resolve. It
// refuses rather than guess: an id it can't find, a protected id, an active
// admin, a row the purge doesn't remove (a schedule), or a
// record under a listed one (a person's socio, a Space's page) that the
// list neither names nor cascades to.
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';

import type { ObjectStore } from '@socio/data/object-store';
import { objectKey, userDirName } from '@socio/data/storage/keys';

import { ENTITIES, NESTED, PURGE_KINDS, REFERENCES, type PurgeKind, type Reference } from './references.js';

export { PURGE_KINDS, type PurgeKind } from './references.js';

/** The ids to purge, by kind; `cascade`: kinds the purge may add on its own (`true`: all). */
export type PurgeList = Partial<Record<PurgeKind, string[]>> & { cascade?: boolean | PurgeKind[] };

export interface PurgeFile {
    path: string;
    bytes: number;
}
export interface PurgeObject {
    key: string;
    bytes: number;
}

export interface PurgePlan {
    /** Every record that goes, by kind, the listed ones and the cascaded ones. */
    targets: Record<PurgeKind, string[]>;
    /** The ones the list didn't name, which `cascade` added. */
    cascaded: Record<PurgeKind, string[]>;
    /** Why it won't run; empty when it may. */
    refusals: string[];
    /** Rows each table loses. */
    tables: { table: string; rows: number }[];
    /** Rows that stay, naming a purged id (attribution and audit). */
    kept: { table: string; column: string; rows: number }[];
    /** Local files that go: datasets and the data space folders of purged owners. */
    files: PurgeFile[];
    /** Stored objects that go (S3 data space files). */
    objects: PurgeObject[];
}

export interface PurgeOptions {
    /** Ids that must never go, of any kind. */
    protect?: Iterable<string>;
    /** USER_DATA_DIR: where data spaces are on disk. */
    userDataDir: string;
    /** The storage tenant (S3_TENANT_ID), for object keys. */
    tenantId: string;
    /**
     * `blocks` and `child` columns (`table.column`) the caller refuses on
     * itself: a person's removal names what they still own, which a
     * transfer moves (CB-360), so their rows aren't refused a second time.
     * Never cascaded either.
     */
    ownedElsewhere?: ReadonlySet<string>;
}

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
const SET_TABLE = 'temp.purge_ids';
const inSet = (set: string) => `(SELECT id FROM ${SET_TABLE} WHERE kind='${set}')`;

/** The columns of each table, read once per plan; a table an older database lacks is skipped. */
function schemaOf(db: DatabaseSync) {
    const tables = new Map<string, Set<string>>();
    const names = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
        .all() as { name: string }[];
    for (const { name } of names) {
        const columns = db.prepare(`PRAGMA table_info(${quote(name)})`).all() as { name: string }[];
        tables.set(name, new Set(columns.map((column) => column.name)));
    }
    return {
        has: (table: string, column?: string) => {
            const columns = tables.get(table);
            return !!columns && (column === undefined || columns.has(column));
        },
    };
}

const emptyByKind = () =>
    Object.fromEntries(PURGE_KINDS.map((kind) => [kind, [] as string[]])) as Record<PurgeKind, string[]>;

function count(db: DatabaseSync, sql: string, ...params: SQLInputValue[]) {
    return Number((db.prepare(sql).get(...params) as { n: number }).n);
}

/** Every file under `dir` (none when it's missing), with its size; links aren't followed. */
/** A dataset's analytical parts live beside it, in `<id>.parts/`. */
const PARTS_SUFFIX = '.parts';

function filesUnder(dir: string): PurgeFile[] {
    if (!existsSync(dir)) {
        return [];
    }
    const out: PurgeFile[] = [];
    const walk = (path: string) => {
        const info = lstatSync(path);
        if (info.isDirectory()) {
            for (const entry of readdirSync(path)) {
                walk(join(path, entry));
            }
        } else {
            out.push({ path, bytes: info.size });
        }
    };
    walk(dir);
    return out;
}

/**
 * Plans the purge of `list`. Run it in a transaction: it fills a temporary
 * table with the id sets the deletes use (`applyPurge` deletes by them in
 * the same transaction). Changes nothing else.
 */
export function planPurge(db: DatabaseSync, list: PurgeList, options: PurgeOptions): PurgePlan {
    const schema = schemaOf(db);
    const refusals: string[] = [];
    const cascadeTo = (kind: PurgeKind) =>
        list.cascade === true || (Array.isArray(list.cascade) && list.cascade.includes(kind));

    db.exec(
        'CREATE TEMP TABLE IF NOT EXISTS purge_ids(kind TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY(kind, id)) WITHOUT ROWID',
    );
    db.exec(`DELETE FROM ${SET_TABLE}`);
    const add = db.prepare(`INSERT OR IGNORE INTO ${SET_TABLE}(kind, id) VALUES (?, ?)`);

    // ---- the listed records: each must exist ----------------------------------
    const targets = emptyByKind();
    const cascaded = emptyByKind();
    const listed = new Set<string>();
    for (const kind of PURGE_KINDS) {
        for (const raw of list[kind] ?? []) {
            const id = String(raw).trim();
            if (!id || targets[kind].includes(id)) {
                continue;
            }
            const entity = ENTITIES[kind];
            const found =
                count(
                    db,
                    `SELECT COUNT(*) AS n FROM ${quote(entity.table)} WHERE id=?${entity.where ? ` AND ${entity.where}` : ''}`,
                    id,
                ) > 0 ||
                // A sign-in account whose app user was never made.
                (kind === 'users' && count(db, 'SELECT COUNT(*) AS n FROM auth_user WHERE appUserId=?', id) > 0);
            if (!found) {
                refusals.push(`No ${kind} ${id} here.`);
                continue;
            }
            targets[kind].push(id);
            listed.add(`${kind}:${id}`);
            add.run(kind, id);
        }
    }

    // The derived sets, refreshed as the targets grow.
    const derive = () => {
        db.exec(`DELETE FROM ${SET_TABLE} WHERE kind IN ('auth','owners','threads')`);
        db.exec(
            `INSERT OR IGNORE INTO ${SET_TABLE}(kind, id) SELECT 'auth', id FROM auth_user WHERE appUserId IN ${inSet('users')}`,
        );
        db.exec(
            `INSERT OR IGNORE INTO ${SET_TABLE}(kind, id) SELECT 'owners', id FROM ${SET_TABLE} WHERE kind='users'`,
        );
        db.exec(
            `INSERT OR IGNORE INTO ${SET_TABLE}(kind, id) SELECT 'owners', 'socio:' || id FROM ${SET_TABLE} WHERE kind='socios'`,
        );
        db.exec(
            `INSERT OR IGNORE INTO ${SET_TABLE}(kind, id) SELECT 'threads', id FROM ${SET_TABLE} WHERE kind IN ('rooms','conversations')`,
        );
    };
    derive();

    const present = (ref: Pick<Reference, 'table' | 'column'>) => schema.has(ref.table, ref.column);
    const matches = (ref: Reference) =>
        `${quote(ref.column)} IN ${inSet(ref.ids)}${ref.where ? ` AND (${ref.where})` : ''}`;

    // ---- records under the listed ones: listed too, cascaded, or refused --------
    const elsewhere = options.ownedElsewhere ?? new Set<string>();
    const refusedElsewhere = (ref: Reference) => elsewhere.has(`${ref.table}.${ref.column}`);
    const children = REFERENCES.filter((ref) => ref.how === 'child' && present(ref));
    const outside = new Map<string, string>();
    for (let grew = true; grew;) {
        grew = false;
        for (const ref of children) {
            const kind = ref.child!;
            const rows = db
                .prepare(
                    `SELECT DISTINCT id FROM ${quote(ref.table)} WHERE ${matches(ref)} AND id NOT IN ${inSet(kind)}`,
                )
                .all() as { id: string }[];
            for (const { id } of rows) {
                if (refusedElsewhere(ref)) {
                    continue;
                }
                if (cascadeTo(kind)) {
                    targets[kind].push(id);
                    cascaded[kind].push(id);
                    add.run(kind, id);
                    grew = true;
                } else {
                    outside.set(
                        `${kind}:${id}`,
                        `${kind} ${id} is under a listed ${ref.ids === 'owners' ? 'owner' : ref.ids} (${ref.table}.${ref.column}): list it, or cascade to ${kind}.`,
                    );
                }
            }
        }
        if (grew) {
            derive();
        }
    }
    refusals.push(...outside.values());

    // ---- protected ids and active admins (a retired `operator` row is one) ----
    const protect = new Set([...(options.protect ?? [])].map((id) => id.trim()).filter(Boolean));
    for (const id of protect) {
        add.run('protect', id);
        add.run('protect', `socio:${id}`);
    }
    for (const kind of PURGE_KINDS) {
        for (const id of targets[kind]) {
            if (protect.has(id)) {
                refusals.push(`${kind} ${id} is protected.`);
            }
        }
    }
    const privileged = db
        .prepare(
            `SELECT u.id, u.role FROM users u WHERE u.id IN ${inSet('users')} AND u.role IN ('operator','admin')
               AND (EXISTS (SELECT 1 FROM auth_user a WHERE a.appUserId=u.id AND a.banned IS NOT 1)
                    OR NOT EXISTS (SELECT 1 FROM auth_user a WHERE a.appUserId=u.id))
             UNION
             SELECT a.appUserId AS id, a.role FROM auth_user a WHERE a.appUserId IN ${inSet('users')}
               AND a.role IN ('operator','admin') AND a.banned IS NOT 1`,
        )
        .all() as { id: string; role: string }[];
    for (const { id } of privileged) {
        refusals.push(`users ${id} is an active admin: deactivate the account first (auth deactivate).`);
    }

    // ---- rows the purge doesn't remove ------------------------------------------
    for (const ref of REFERENCES.filter((ref) => ref.how === 'blocks' && present(ref) && !refusedElsewhere(ref))) {
        const n = count(db, `SELECT COUNT(*) AS n FROM ${quote(ref.table)} WHERE ${matches(ref)}`);
        if (n) {
            refusals.push(
                `${n} row(s) of ${ref.table}.${ref.column} name a listed ${ref.ids}: the purge doesn't remove those; end them in the app first.`,
            );
        }
    }

    // ---- what each table loses ---------------------------------------------------
    const predicates = buildPredicates(db, schema, { materialize: true });
    const predicateOf = (table: string) => predicates.get(table);

    const tables: PurgePlan['tables'] = [];
    for (const table of [...predicates.keys()].sort()) {
        const rows = count(db, `SELECT COUNT(*) AS n FROM ${quote(table)} WHERE ${predicateOf(table)}`);
        if (rows) {
            tables.push({ table, rows });
        }
    }

    // ---- no row that goes may belong to a protected record ----------------------
    if (protect.size) {
        for (const ref of REFERENCES.filter((ref) => (ref.how === 'owns' || ref.how === 'child') && present(ref))) {
            const predicate = predicateOf(ref.table);
            if (!predicate) {
                continue;
            }
            const n = count(
                db,
                `SELECT COUNT(*) AS n FROM ${quote(ref.table)} WHERE (${predicate}) AND ${quote(ref.column)} IN ${inSet('protect')}`,
            );
            if (n) {
                refusals.push(`${n} row(s) of ${ref.table} that would go belong to a protected id (${ref.column}).`);
            }
        }
    }

    // ---- history that stays -------------------------------------------------------
    const kept: PurgePlan['kept'] = [];
    for (const ref of REFERENCES.filter((ref) => ref.how === 'history' && present(ref))) {
        const predicate = predicateOf(ref.table);
        const rows = count(
            db,
            `SELECT COUNT(*) AS n FROM ${quote(ref.table)} WHERE ${matches(ref)}${predicate ? ` AND NOT (${predicate})` : ''}`,
        );
        if (rows) {
            kept.push({ table: ref.table, column: ref.column, rows });
        }
    }

    // ---- files and objects ------------------------------------------------------------
    const owners = (
        db.prepare(`SELECT id FROM ${SET_TABLE} WHERE kind='owners' ORDER BY id`).all() as { id: string }[]
    ).map((row) => row.id);
    const ownerDirs = new Set(owners.map((owner) => join(options.userDataDir, userDirName(owner))));
    const files: PurgeFile[] = owners.flatMap((owner) => filesUnder(join(options.userDataDir, userDirName(owner))));
    const insideOwnerDir = (path: string) => [...ownerDirs].some((dir) => path.startsWith(`${dir}/`));
    const objects: PurgeObject[] = [];
    const filesPredicate = predicateOf('data_files');
    if (filesPredicate) {
        const rows = db
            .prepare(
                `SELECT id, ownerUserId, storage, size, storedSize FROM data_files WHERE ${filesPredicate} ORDER BY id`,
            )
            .all() as {
            id: string;
            ownerUserId: string;
            storage: string | null;
            size: number;
            storedSize: number | null;
        }[];
        for (const row of rows) {
            if (row.storage === 's3') {
                objects.push({
                    key: objectKey('s3', options.tenantId, row.ownerUserId, row.id),
                    bytes: Number(row.storedSize ?? row.size ?? 0),
                });
            } else {
                const path = join(options.userDataDir, objectKey('local', options.tenantId, row.ownerUserId, row.id));
                if (!insideOwnerDir(path)) {
                    files.push(...filesUnder(path));
                }
            }
        }
    }
    const datasetsPredicate = predicateOf('data_datasets');
    if (datasetsPredicate) {
        const rows = db
            .prepare(`SELECT id, ownerUserId FROM data_datasets WHERE ${datasetsPredicate} ORDER BY id`)
            .all() as { id: string; ownerUserId: string }[];
        for (const row of rows) {
            const base = join(options.userDataDir, userDirName(row.ownerUserId), 'datasets', `${row.id}.sqlite`);
            if (insideOwnerDir(base)) {
                continue;
            }
            for (const suffix of ['', '-journal', '-wal', '-shm']) {
                files.push(...filesUnder(`${base}${suffix}`));
            }
            // Its analytical tables' Parquet parts (CB-369), staging included.
            files.push(...filesUnder(base.replace(/\.sqlite$/, PARTS_SUFFIX)));
        }
    }

    return { targets, cascaded, refusals, tables, kept, files, objects };
}

/** The part of a plan that must not change between the dry run and the apply. */
export function planDigest(plan: PurgePlan) {
    return JSON.stringify({
        targets: plan.targets,
        tables: plan.tables,
        files: plan.files.map((file) => file.path),
        objects: plan.objects.map((object) => object.key),
    });
}

/**
 * Deletes the rows `plan` lists, in the transaction `planPurge` ran in (the
 * caller commits). Each table must lose exactly the rows planned, or it
 * throws and the caller rolls back.
 */
export function applyPurgeRows(
    db: DatabaseSync,
    list: PurgeList,
    plan: PurgePlan,
    options: PurgeOptions & {
        /** `contentDigest` of the rows as they were backed up: any edit since stops the purge. */
        content?: string;
    },
) {
    if (plan.refusals.length) {
        throw new Error(`Refused: ${plan.refusals.join(' ')}`);
    }
    const fresh = planPurge(db, list, options);
    if (planDigest(fresh) !== planDigest(plan) || fresh.refusals.length) {
        throw new Error('The data changed since the plan was made: run it again and check the new plan.');
    }
    if (options.content !== undefined && contentDigest(db) !== options.content) {
        throw new Error('A row that would go changed since the backup: run it again.');
    }
    // Recompute the predicates the plan counted with, and delete by them.
    // Everything they name is in the temporary sets, so the order of the
    // deletes doesn't change what goes; dependents first all the same, so
    // a foreign key never cascades on its own.
    const predicates = buildPredicates(db, schemaOf(db), { materialize: false });
    const entityTables = new Set(Object.values(ENTITIES).map((entity) => entity.table));
    const order = plan.tables
        .map((entry) => entry.table)
        .sort(
            (a, b) =>
                Number(entityTables.has(a) || a === 'auth_user') - Number(entityTables.has(b) || b === 'auth_user'),
        );
    const deleted: { table: string; rows: number }[] = [];
    for (const table of order) {
        const expected = plan.tables.find((entry) => entry.table === table)!.rows;
        const { changes } = db.prepare(`DELETE FROM ${quote(table)} WHERE ${predicates.get(table)}`).run();
        if (Number(changes) !== expected) {
            throw new Error(`${table}: ${changes} row(s) deleted, ${expected} planned. Nothing was changed.`);
        }
        deleted.push({ table, rows: Number(changes) });
    }
    return deleted;
}

/**
 * A digest of every row the plan made in this transaction would delete,
 * contents included: equal on the backup copy and under the write lock
 * means the backup holds exactly what goes.
 */
export function contentDigest(db: DatabaseSync) {
    const hash = createHash('sha256');
    const predicates = buildPredicates(db, schemaOf(db), { materialize: false });
    for (const table of [...predicates.keys()].sort()) {
        const rows = (db.prepare(`SELECT * FROM ${quote(table)} WHERE ${predicates.get(table)}`).all() as object[]).map(
            (row) =>
                JSON.stringify(row, (_key, value: unknown) =>
                    value instanceof Uint8Array
                        ? Buffer.from(value).toString('hex')
                        : typeof value === 'bigint'
                          ? value.toString()
                          : value,
                ),
        );
        hash.update(`${table}\n${rows.sort().join('\n')}\n`);
    }
    return hash.digest('hex');
}

/** A file's sha256, or `missing`. */
export function fileDigest(path: string) {
    return existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : 'missing';
}

/**
 * Each table's delete predicate. With `materialize`, first fills the sets
 * the predicates read that come from other tables (an app's bundles, the
 * rows under a row that goes), so deleting in any order removes the same
 * rows; without it, uses the sets a plan in this transaction left.
 */
function buildPredicates(db: DatabaseSync, schema: ReturnType<typeof schemaOf>, options: { materialize: boolean }) {
    const predicates = new Map<string, string[]>();
    const where = (table: string, predicate: string) => {
        const list = predicates.get(table) ?? [];
        list.push(`(${predicate})`);
        predicates.set(table, list);
    };
    const joined = (table: string) => predicates.get(table)?.join(' OR ');
    for (const kind of PURGE_KINDS) {
        const entity = ENTITIES[kind];
        if (schema.has(entity.table)) {
            where(entity.table, `id IN ${inSet(kind)}${entity.where ? ` AND ${entity.where}` : ''}`);
        }
    }
    for (const ref of REFERENCES.filter((ref) => ref.how === 'owns' && schema.has(ref.table, ref.column))) {
        where(ref.table, `${quote(ref.column)} IN ${inSet(ref.ids)}${ref.where ? ` AND (${ref.where})` : ''}`);
    }
    // An app's packaged versions are files in its owner's data space.
    if (schema.has('app_versions', 'bundlePath') && schema.has('data_files', 'path')) {
        if (options.materialize) {
            db.exec(
                `INSERT OR IGNORE INTO ${SET_TABLE}(kind, id)
                 SELECT 'bundles', f.id FROM data_files f JOIN app_versions v ON f.path=v.bundlePath
                   JOIN apps a ON a.id=v.appId AND f.ownerUserId=a.ownerUserId WHERE a.id IN ${inSet('apps')}`,
            );
        }
        where('data_files', `id IN ${inSet('bundles')}`);
    }
    for (const nested of NESTED) {
        const parent = joined(nested.parent);
        if (!parent || !schema.has(nested.table, nested.column) || !schema.has(nested.parent, nested.key)) {
            continue;
        }
        const set = `nested:${nested.parent}.${nested.key}`;
        if (options.materialize) {
            db.exec(
                `INSERT OR IGNORE INTO ${SET_TABLE}(kind, id) SELECT '${set}', ${quote(nested.key)} FROM ${quote(nested.parent)} WHERE ${parent}`,
            );
        }
        where(nested.table, `${quote(nested.column)} IN ${inSet(set)}`);
    }
    return new Map([...predicates.keys()].map((table) => [table, joined(table)!]));
}

/**
 * What goes after the rows are committed: written to the backup folder
 * before the commit, so a cleanup that fails part way can be finished
 * (`finishCleanup`, `purge --resume`).
 */
export interface PurgeCleanup {
    files: PurgeFile[];
    objects: PurgeObject[];
    /** The purged owners' data space folders, removed once empty. */
    dirs: string[];
    /**
     * The purged socios, whose computers (container and its three volumes)
     * the supervisor destroys; one that has none is fine. Empty without a
     * supervisor (COMPUTER_SUPERVISOR_URL): a deployment without computers.
     */
    computers: string[];
}

/** The supervisor's `POST /computers/:id/destroy` (computer-destroy.mjs). */
export interface ComputerDestroyer {
    destroy(socioId: string): Promise<{ container: boolean; volumes: string[] }>;
}

export function cleanupOf(plan: PurgePlan, userDataDir: string, options: { computers?: boolean } = {}): PurgeCleanup {
    return {
        computers: options.computers === false ? [] : [...plan.targets.socios],
        files: plan.files,
        objects: plan.objects,
        dirs: [...plan.targets.users, ...plan.targets.socios.map((socio) => `socio:${socio}`)].map((id) =>
            join(userDataDir, userDirName(id)),
        ),
    };
}

/**
 * Removes the files, objects and empty folders of a committed purge. Safe
 * to repeat: what is gone already counts as done.
 */
export async function finishCleanup(
    cleanup: PurgeCleanup,
    store?: Pick<ObjectStore, 'delete'>,
    computers?: ComputerDestroyer,
) {
    let bytes = 0;
    // Computers first: a container still running holds its volumes.
    const destroyed = { containers: 0, volumes: 0 };
    if (cleanup.computers?.length && !computers) {
        throw new Error('The purge removes socios’ computers: set COMPUTER_SUPERVISOR_URL and its token.');
    }
    for (const id of cleanup.computers ?? []) {
        const result = await computers!.destroy(id);
        destroyed.containers += result.container ? 1 : 0;
        destroyed.volumes += result.volumes.length;
    }
    for (const file of cleanup.files) {
        if (existsSync(file.path)) {
            rmSync(file.path, { force: true });
            bytes += file.bytes;
        }
    }
    if (cleanup.objects.length && !store) {
        throw new Error('The purge deleted stored objects: set S3_ENDPOINT and the other S3_* settings.');
    }
    for (const object of cleanup.objects) {
        await store!.delete(object.key);
    }
    // A purged dataset's parts folder, once its parts are gone.
    const partsDirs = new Set(
        cleanup.files.flatMap((file) => {
            const at = file.path.indexOf(`${PARTS_SUFFIX}/`);
            return at < 0 ? [] : [file.path.slice(0, at + PARTS_SUFFIX.length)];
        }),
    );
    for (const dir of [...partsDirs, ...cleanup.dirs]) {
        if (existsSync(dir) && filesUnder(dir).length === 0) {
            rmSync(dir, { recursive: true, force: true });
        }
    }
    return { files: cleanup.files.length, bytes, objects: cleanup.objects.length, ...destroyed };
}

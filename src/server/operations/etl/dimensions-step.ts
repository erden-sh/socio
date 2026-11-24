import { createHash } from 'node:crypto';

import { runSource, runSources } from '@socio/shared/runs/run-sources';

import type { EtlStep } from '../infra/duckdb/etl.js';
import { rows } from '../infra/duckdb/open.js';
import { sqliteSourceReader } from '../infra/sqlite/source-reader.js';

import { append } from './append.js';
import { DIMENSION_DDL } from './schema.js';

/**
 * People, socios, Spaces, chats and sources (CB-187): small tables, read
 * whole each cycle (which also catches deletes) and written only when
 * they changed. The watermark is a hash of what was read. `d_source` is
 * the source registry plus every key the turns hold, an unregistered one
 * as itself with kind `unknown`.
 */
export const dimensionsStep: EtlStep = {
    source: 'dimensions',
    ddl: DIMENSION_DDL,
    async batch({ sqlite, duck, watermark }) {
        const reader = sqliteSourceReader(sqlite);
        if (!reader.ready()) {
            return { caughtUp: true };
        }
        sqlite.exec('BEGIN');
        let read;
        try {
            read = {
                people: reader.people(),
                socios: reader.socios(),
                spaces: reader.spaces(),
                chats: reader.chats(),
            };
        } finally {
            sqlite.exec('COMMIT');
        }
        const people = new Set(read.people.map((person) => person.id));
        const keys = await rows<{ source: string }>(duck, 'SELECT DISTINCT source FROM f_turn ORDER BY source');
        const sources = [
            ...runSources(),
            ...keys.map(({ source }) => runSource(source)).filter((source) => source.kind === 'unknown'),
        ];
        const hash = createHash('sha256')
            .update(JSON.stringify([read, sources]))
            .digest('base64url')
            .slice(0, 22);
        if (hash === watermark) {
            return { caughtUp: true };
        }
        for (const table of ['d_person', 'd_socio', 'd_space', 'd_chat', 'd_source']) {
            await duck.run(`DELETE FROM ${table}`);
        }
        await append(
            duck,
            'd_person',
            read.people.map((person) => [person.id, person.name, person.role, person.createdAt]),
        );
        await append(
            duck,
            'd_socio',
            read.socios.map((socio) => [
                socio.id,
                socio.name,
                socio.spaceId,
                socio.ownerId,
                socio.createdAt,
                socio.archivedAt,
                socio.deletedAt,
            ]),
        );
        await append(
            duck,
            'd_space',
            read.spaces.map((space) => [space.id, space.name, space.createdAt, space.deletedAt]),
        );
        await append(
            duck,
            'd_chat',
            read.chats.map((chat) => [
                chat.id,
                chat.socioId,
                chat.ownerId,
                // A room is its own owner (CB-218); a chat no person owns is a
                // team's (a shared Telegram topic).
                chat.kind === 'room' ? 'room' : people.has(chat.ownerId) ? 'person' : 'team',
                chat.kind === 'room' ? chat.title : null,
                chat.createdAt,
                chat.archivedAt,
                chat.deletedAt,
            ]),
        );
        await append(
            duck,
            'd_source',
            sources.map((source) => [source.key, source.label, source.kind, source.channel]),
        );
        return { watermark: hash, caughtUp: true };
    },
};

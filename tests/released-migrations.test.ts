import { readFileSync } from 'node:fs';

import { expect, it } from 'vitest';

// @ts-expect-error: a plain .mjs script, without declarations.
import { checksums, LOCK, problems, record } from '../scripts/released-migrations.mjs';
import { schemas } from '../src/server/modules/index.js';

const lock = JSON.parse(readFileSync(LOCK, 'utf8')) as { release: string; checksums: Record<string, string> };

it('records the release package.json names, and only migrations that exist', () => {
    const { version } = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };
    expect(lock.release).toBe(`v${version}`);
    const current = checksums(schemas, () => 'x');
    expect(Object.keys(lock.checksums).filter((key) => !(key in current))).toEqual([]);
});

it('fails on a changed or removed released migration and another release, never on a new one', () => {
    const released = { release: 'v1.2.0', checksums: { 'a 1': 'aaa', 'a 2': 'bbb' } };
    expect(problems(released, { 'a 1': 'aaa', 'a 2': 'bbb', 'a 3': 'new' }, '1.2.0')).toEqual([]);
    expect(problems(released, { 'a 1': 'aaa', 'a 3': 'new' }, '1.2.0')).toEqual([
        'Migration a 2 was released in v1.2.0 and is gone.',
    ]);
    const changed = problems(released, { 'a 1': 'zzz', 'a 2': 'bbb' }, '1.3.0');
    expect(changed).toHaveLength(2);
    expect(changed[0]).toMatch(/is for v1\.2\.0, but package\.json is 1\.3\.0/);
    expect(changed[1]).toMatch(/Migration a 1 was released in v1\.2\.0 and changed \(checksum aaa, now zzz\)/);
});

it('records new migrations for the new release and keeps the released ones', () => {
    const released = { release: 'v1.2.0', checksums: { 'b 1': 'b1', 'a 10': 'a10' } };
    const next = record(released, { 'a 2': 'a2', 'a 10': 'other', 'b 1': 'b1' }, '1.3.0');
    expect(next).toEqual({ release: 'v1.3.0', checksums: { 'a 2': 'a2', 'a 10': 'a10', 'b 1': 'b1' } });
    expect(Object.keys(next.checksums)).toEqual(['a 2', 'a 10', 'b 1']);
});

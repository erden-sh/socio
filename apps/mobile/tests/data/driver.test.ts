import { describe, expect, it } from 'vitest';

import { isBusy, resultCode, SqlError, SQLITE_BUSY, SQLITE_LOCKED, SQLITE_NOTADB } from '../../src/data';

// The driver's error contract (src/data/driver.ts): every driver rejects with
// a SqlError carrying SQLite's primary result code, which open.ts and
// migrate.ts read to tell a wrong key from a lock or a damaged file.

describe('SqlError', () => {
    it('keeps the primary result code of an extended one', () => {
        expect(new SqlError('database is locked', 517).resultCode).toBe(SQLITE_BUSY); // SQLITE_BUSY_SNAPSHOT
        expect(new SqlError('file is not a database', SQLITE_NOTADB)).toMatchObject({
            name: 'SqlError',
            message: 'file is not a database',
            resultCode: 26,
        });
        const cause = new Error('from the driver');
        expect(new SqlError('x', 1, cause).cause).toBe(cause);
    });

    it('is the only error with a result code', () => {
        expect(resultCode(new SqlError('x', SQLITE_NOTADB))).toBe(26);
        expect(resultCode(Object.assign(new Error('file is not a database'), { errcode: 26 }))).toBeUndefined();
        expect(resultCode('Error code 26: file is not a database')).toBeUndefined();
    });

    it('calls SQLITE_BUSY and SQLITE_LOCKED busy, and nothing else', () => {
        expect(isBusy(new SqlError('database is locked', SQLITE_BUSY))).toBe(true);
        expect(isBusy(new SqlError('database table is locked', SQLITE_LOCKED))).toBe(true);
        expect(isBusy(new SqlError('database table is locked', 262))).toBe(true); // SQLITE_LOCKED_SHAREDCACHE
        expect(isBusy(new SqlError('file is not a database', SQLITE_NOTADB))).toBe(false);
        expect(isBusy(new Error('database is locked'))).toBe(false);
    });
});

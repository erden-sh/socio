import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { gunzipSync, gzipSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { egressProblem, manifestChanges, parseAppManifest, type AppManifest } from '@socio/shared/apps/app-manifest';

import {
    BundleError,
    bundlePathProblem,
    decodeBundle,
    encodeBundle,
    fileChanges,
    globMatch,
    readTarGz,
} from '../src/apps/bundle.js';

const manifest = (extra: Partial<AppManifest> = {}): AppManifest => ({
    name: 'Tracker',
    description: '',
    entry: 'server.ts',
    runtime: 'bun',
    datasets: [],
    egress: [],
    ...extra,
});

describe('manifest validation', () => {
    it('accepts a full manifest and normalises egress', () => {
        const parsed = parseAppManifest({
            name: 'Tracker',
            description: 'Tracks prices',
            entry: 'src/server.ts',
            runtime: 'bun',
            routes: ['/', '/api/'],
            datasets: [
                { id: 'scratch', access: 'write', tables: ['prices'] },
                { id: 'ds-1', access: 'read' },
            ],
            egress: ['API.example.com:443', 'api.example.com:443'],
            env: { CURRENCY: 'The currency to show' },
        });
        expect(parsed).toMatchObject({
            ok: true,
            manifest: { egress: ['api.example.com:443'], runtime: 'bun' },
        });
    });

    it('defaults the runtime, datasets and egress', () => {
        expect(parseAppManifest({ name: 'X', entry: 'index.js' })).toMatchObject({
            ok: true,
            manifest: { runtime: 'bun', datasets: [], egress: [] },
        });
    });

    it.each([
        [{ name: '', entry: 'a.ts' }, 'name'],
        [{ name: 'X', entry: '/abs.ts' }, 'entry'],
        [{ name: 'X', entry: '../up.ts' }, 'entry'],
        [{ name: 'X', entry: 'a/./b.ts' }, 'entry'],
        [{ name: 'X', entry: 'readme.md' }, 'entry'],
        [{ name: 'X', entry: 'a.ts', runtime: 'node' }, 'runtime'],
        [{ name: 'X', entry: 'a.ts', egress: ['10.0.0.10:4310'] }, 'address'],
        [{ name: 'X', entry: 'a.ts', egress: ['localhost:80'] }, 'host:port'],
        [{ name: 'X', entry: 'a.ts', egress: ['brain.example.local:443'] }, 'public'],
        [{ name: 'X', entry: 'a.ts', egress: ['example.com'] }, 'host:port'],
        [{ name: 'X', entry: 'a.ts', egress: ['example.com:99999'] }, 'port'],
        [{ name: 'X', entry: 'a.ts', env: { PATH: 'x' } }, 'env'],
        [{ name: 'X', entry: 'a.ts', env: { CB_DATA_TOKEN: 'x' } }, 'env'],
        [{ name: 'X', entry: 'a.ts', env: { lower: 'x' } }, 'env'],
        [{ name: 'X', entry: 'a.ts', extra: 1 }, 'extra'],
        [
            {
                name: 'X',
                entry: 'a.ts',
                datasets: [
                    { id: 'a', access: 'read' },
                    { id: 'A', access: 'write' },
                ],
            },
            'once',
        ],
        [{ name: 'X', entry: 'a.ts', datasets: [{ id: 'a', access: 'admin' }] }, 'access'],
    ])('refuses %j', (input, problem) => {
        const parsed = parseAppManifest(input);
        expect(parsed.ok).toBe(false);
        expect(parsed.ok ? '' : parsed.error).toMatch(new RegExp(problem, 'i'));
    });

    it('names egress problems', () => {
        expect(egressProblem('api.example.com:443')).toBeUndefined();
        expect(egressProblem('printer.internal:443')).toMatch(/public/);
    });

    it('lists manifest changes for an update', () => {
        const before = manifest({
            datasets: [{ id: 'scratch', access: 'read' }],
            egress: ['a.example.com:443'],
            env: { A: 'a' },
        });
        const after = manifest({
            entry: 'main.ts',
            datasets: [
                { id: 'scratch', access: 'write' },
                { id: 'ds', access: 'read' },
            ],
            egress: ['b.example.com:443'],
            env: { B: 'b' },
        });
        expect(manifestChanges(undefined, after)).toEqual(['First version.']);
        expect(manifestChanges(before, after)).toEqual([
            'Entry: server.ts → main.ts',
            'Dataset scratch: read → write',
            'New dataset: ds (read)',
            'New egress: b.example.com:443',
            'Egress removed: a.example.com:443',
            'New setting: B',
            'Setting removed: A',
        ]);
    });
});

describe('bundles', () => {
    const files = [
        { path: 'server.ts', data: Buffer.from('Bun.serve({})') },
        { path: 'package.json', data: Buffer.from('{}') },
        { path: 'bun.lock', data: Buffer.from('{"lockfileVersion":1}') },
    ];

    it('round-trips files and the manifest with checksums', () => {
        const packed = encodeBundle({ manifest: manifest(), files });
        expect(packed.entries.map((entry) => entry.path)).toEqual(['bun.lock', 'package.json', 'server.ts']);
        expect(packed.sha256).toMatch(/^[0-9a-f]{64}$/);
        const back = decodeBundle(packed.bytes);
        expect(back.manifest.entry).toBe('server.ts');
        expect(back.files.find((file) => file.path === 'server.ts')!.data.toString()).toBe('Bun.serve({})');
    });

    it('enforces the caps and the entry', () => {
        const limits = { maxFiles: 2, maxFileBytes: 20, maxBytes: 30 };
        expect(() => encodeBundle({ manifest: manifest(), files }, limits)).toThrow(/At most 2 files/);
        expect(() =>
            encodeBundle(
                {
                    manifest: manifest(),
                    files: [{ path: 'server.ts', data: Buffer.alloc(21) }],
                },
                limits,
            ),
        ).toThrow(/at most 20/);
        expect(() =>
            encodeBundle(
                {
                    manifest: manifest(),
                    files: [
                        { path: 'server.ts', data: Buffer.alloc(20) },
                        { path: 'b.ts', data: Buffer.alloc(20) },
                    ],
                },
                limits,
            ),
        ).toThrow(/at most 30/);
        expect(() =>
            encodeBundle({
                manifest: manifest({ entry: 'main.ts' }),
                files,
            }),
        ).toThrow(/entry main.ts/);
    });

    it('refuses secrets, dependencies, history and traversal', () => {
        for (const path of [
            '.env',
            'config/.env.local',
            '.npmrc',
            'keys/server.pem',
            'node_modules/x/index.js',
            '.git/config',
            'a/.git/HEAD',
            '.socio/apps/tracker.env',
            '../up.ts',
            '/abs.ts',
            'a//b.ts',
            'a/./b.ts',
        ]) {
            expect(bundlePathProblem(path), path).toBeTruthy();
        }
        expect(bundlePathProblem('src/app.tsx')).toBeUndefined();
        expect(bundlePathProblem('.gitignore')).toBeUndefined();
    });

    it('refuses a tampered or foreign bundle', () => {
        const packed = encodeBundle({ manifest: manifest(), files });
        const doc = JSON.parse(gunzipSync(packed.bytes).toString());
        doc.files[0].data = Buffer.from('evil').toString('base64');
        expect(() => decodeBundle(gzipSync(JSON.stringify(doc)))).toThrow(/checksum/);
        expect(() => decodeBundle(gzipSync(JSON.stringify({ format: 'zip', files: [] })))).toThrow(BundleError);
        expect(() => decodeBundle(Buffer.from('not gzip'))).toThrow(/readable/);
        // A gzip bomb stops at the output cap.
        expect(() =>
            decodeBundle(gzipSync(Buffer.alloc(30 * 1048576)), {
                maxFiles: 10,
                maxFileBytes: 1024,
                maxBytes: 1024,
            }),
        ).toThrow(/readable|large/);
    });

    it('reads the ustar archive the packaging command writes', () => {
        const dir = mkdtempSync(join(tmpdir(), 'cb-tar-'));
        try {
            mkdirSync(join(dir, 'src', 'd'.repeat(60)), { recursive: true });
            writeFileSync(join(dir, 'server.ts'), 'serve()');
            writeFileSync(join(dir, 'src', 'd'.repeat(60), `${'n'.repeat(60)}.ts`), 'x');
            writeFileSync(join(dir, 'run.sh'), '#!/bin/sh\n', { mode: 0o755 });
            const tgz = execFileSync('tar', [
                '--format=ustar',
                '-czf',
                '-',
                '-C',
                dir,
                'server.ts',
                `src/${'d'.repeat(60)}/${'n'.repeat(60)}.ts`,
                'run.sh',
            ]);
            const read = readTarGz(tgz);
            expect(read.map((file) => file.path)).toEqual([
                'server.ts',
                `src/${'d'.repeat(60)}/${'n'.repeat(60)}.ts`,
                'run.sh',
            ]);
            expect(read[0].data.toString()).toBe('serve()');
            expect(read[2].executable).toBe(true);
            // A symlink is refused.
            execFileSync('ln', ['-s', '/etc/passwd', join(dir, 'link')]);
            const linked = execFileSync('tar', ['--format=ustar', '-czf', '-', '-C', dir, 'link']);
            expect(() => readTarGz(linked)).toThrow(/regular file/);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('matches globs and lists file changes', () => {
        expect(globMatch('src/**', 'src/a/b.ts')).toBe(true);
        expect(globMatch('src/', 'src/a.ts')).toBe(true);
        expect(globMatch('src', 'src/a.ts')).toBe(true);
        expect(globMatch('*.ts', 'server.ts')).toBe(true);
        expect(globMatch('*.ts', 'src/server.ts')).toBe(false);
        expect(globMatch('**/*.ts', 'src/server.ts')).toBe(true);
        expect(globMatch('**/*.ts', 'server.ts')).toBe(true);
        expect(globMatch('package.json', 'package.json')).toBe(true);
        expect(globMatch('a?.ts', 'ab.ts')).toBe(true);
        expect(globMatch('a.ts', 'aXts')).toBe(false);
        const a = [
            { path: 'a', size: 1, sha256: '1' },
            { path: 'b', size: 1, sha256: '2' },
        ];
        const b = [
            { path: 'a', size: 1, sha256: '9' },
            { path: 'c', size: 1, sha256: '3' },
        ];
        expect(fileChanges(undefined, b)).toEqual(['2 file(s).']);
        expect(fileChanges(a, b)).toEqual(['Changed: a', 'Added: c', 'Removed: b']);
        expect(fileChanges(a, a)).toEqual(['No file changes.']);
    });
});

// The server's locale is fixed when Node starts (from LANG), so each locale
// needs its own process. Danish sorts "aa" after "z" and capitals first,
// which en-US doesn't: with localeCompare the two bundles differed.
describe('bundle order', () => {
    const run = promisify(execFile);
    const tsxUrl = import.meta.resolve('tsx');
    const optOutUrl = new URL('../src/no-vendor-telemetry.ts', import.meta.url).href;
    const bundleUrl = new URL('../src/apps/bundle.ts', import.meta.url).href;
    const paths = ['b.ts', 'aa.ts', 'B.ts', 'server.ts', 'a-b.ts', 'a_b.ts'];
    const probe = `
await import(${JSON.stringify(optOutUrl)});
const { encodeBundle } = await import(${JSON.stringify(bundleUrl)});
const paths = ${JSON.stringify(paths)};
const packed = encodeBundle({
  manifest: { name: 'X', description: '', entry: 'server.ts', runtime: 'bun', datasets: [], egress: [] },
  files: paths.map((path) => ({ path, data: Buffer.from(path) })),
});
console.log(JSON.stringify({
  locale: new Intl.Collator().resolvedOptions().locale,
  sha256: packed.sha256,
  order: packed.entries.map((entry) => entry.path),
}));
`;
    const packIn = async (lang: string) => {
        const { stdout } = await run(process.execPath, ['--import', tsxUrl, '--input-type=module', '--eval', probe], {
            env: { PATH: process.env.PATH, LANG: lang, LC_ALL: lang },
            timeout: 15000,
        });
        return JSON.parse(stdout.trim().split('\n').at(-1) ?? '{}') as {
            locale: string;
            sha256: string;
            order: string[];
        };
    };

    it('is code-unit order, the same bytes whatever the default locale', async () => {
        const [en, da, c] = await Promise.all(['en_US.UTF-8', 'da_DK.UTF-8', 'C'].map(packIn));
        // The probe really ran under different locales.
        expect(en.locale).toBe('en-US');
        expect(da.locale).toBe('da-DK');
        expect(en.order).toEqual(['B.ts', 'a-b.ts', 'a_b.ts', 'aa.ts', 'b.ts', 'server.ts']);
        expect(da.order).toEqual(en.order);
        expect(c.order).toEqual(en.order);
        expect(da.sha256).toBe(en.sha256);
        expect(c.sha256).toBe(en.sha256);
    });
});

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { importsOf, packageBoundaryProblems } from '../../scripts/check-package-boundary.mjs';

const root = join(import.meta.dirname, '../..');
const json = (path: string) => JSON.parse(readFileSync(join(root, path), 'utf8'));

const made: string[] = [];
afterEach(() => {
    for (const dir of made.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

/** A package at <dir>/packages/shared with these source files. */
const fixture = (files: Record<string, string>) => {
    const dir = mkdtempSync(join(tmpdir(), 'shared-boundary-'));
    made.push(dir);
    const pkg = join(dir, 'packages/shared');
    mkdirSync(join(pkg, 'src'), { recursive: true });
    writeFileSync(
        join(pkg, 'package.json'),
        JSON.stringify({ dependencies: { zod: '1' }, devDependencies: { '@types/hast': '1', '@ag-ui/core': '1' } }),
    );
    for (const [name, text] of Object.entries(files)) {
        mkdirSync(dirname(join(pkg, 'src', name)), { recursive: true });
        writeFileSync(join(pkg, 'src', name), text);
    }
    return packageBoundaryProblems(pkg);
};

describe('the @socio/shared boundary', () => {
    it('holds on the real package', () => {
        expect(packageBoundaryProblems(join(root, 'packages/shared'))).toEqual([]);
    });

    it('declares exactly the third-party packages the source names', () => {
        const manifest = json('packages/shared/package.json');
        expect(Object.keys({ ...manifest.dependencies, ...manifest.devDependencies }).sort()).toEqual([
            '@ag-ui/core',
            '@types/hast',
            'zod',
        ]);
    });

    it('allows the package itself, Node built-ins and what it declares', () => {
        expect(
            fixture({
                'a.ts': "import { z } from 'zod';\nimport { b } from './rooms/b.js';\nexport { b, z };\n",
                'rooms/b.ts':
                    "import type { Root } from 'hast';\nexport { c } from '../c.js';\nexport type R = Root;\n",
                'c.ts': "import type { Run } from '@ag-ui/core';\nimport 'node:fs';\nexport type C = Run;\n",
                'd.ts': "import { z } from 'zod/v4';\nexport const d = z;\n",
            }),
        ).toEqual([]);
    });

    it.each([
        ['a static import of the server', "import { x } from '../../../src/server/x.js';", 'leaves the package'],
        ['src/net', "import { x } from '../../../src/net/public-address.js';", 'leaves the package'],
        ['the package manifest', "import x from '../../package.json';", 'leaves the package'],
        ['a type-only import', "import type { X } from '../../../packages/client/src/x';", 'leaves the package'],
        ['a type position', "export type X = import('../../../src/server/x.js').X;", 'leaves the package'],
        ['a re-export', "export { x } from '../../../src/server/x.js';", 'leaves the package'],
        ['a star re-export', "export * from '../../plugin-ui/src/index.js';", 'leaves the package'],
        ['a side-effect import', "import '../../../src/server/no-vendor-telemetry.js';", 'leaves the package'],
        ['a dynamic import', "await import('../../../src/server/x.js');", 'leaves the package'],
        ['a require', "require('../../../src/server/x.js');", 'leaves the package'],
        ['a multi-line import', "import {\n    x,\n} from '../../../src/server/x.js';", 'leaves the package'],
        ['an undeclared package', "import x from 'lodash';", 'not declared'],
        ['an undeclared scoped package', "import x from '@copilotkit/core';", 'not declared'],
        ['another workspace package', "import x from '@socio/plugin-ui';", 'not declared'],
        ['the app alias', "import x from '@/lib/api';", 'not declared'],
        ['an absolute path', "import x from '/app/src/server/x.js';", 'not a package'],
        ['a URL', "import x from 'https://example.test/x.js';", 'not a package'],
    ])('catches %s', (_name, line, why) => {
        const problems = fixture({ 'deep/a.ts': `${line}\n` });
        expect(problems).toHaveLength(1);
        expect(problems[0]).toContain('src/deep/a.ts');
        expect(problems[0]).toContain(why);
    });

    it('reads .js, .tsx and .mjs sources too', () => {
        for (const name of ['a.js', 'a.tsx', 'a.mjs']) {
            expect(fixture({ [name]: "import x from 'lodash';\n" })).toHaveLength(1);
        }
    });

    it('does not take prose in a comment or a string for an import', () => {
        expect(importsOf("// from 'lodash'\n/* import('../x.js') */\nexport const a = 1;\n")).toEqual([]);
        expect(importsOf("const url = 'https://x.test'; // import 'lodash'\nimport 'zod';\n")).toEqual(['zod']);
        expect(importsOf("export const a = `moved from ' | ' here`;\nexport const b = 'from \\'x\\'';\n")).toEqual([]);
    });
});

describe('the @socio/shared wiring', () => {
    it('holds the package to Node semantics', () => {
        const { compilerOptions } = json('packages/shared/tsconfig.json');
        expect(compilerOptions.module).toBe('NodeNext');
        expect(compilerOptions.moduleResolution).toBe('NodeNext');
        expect(compilerOptions.target).toBeTruthy();
        expect(compilerOptions.allowImportingTsExtensions).toBeUndefined();
        expect(json('package.json').scripts.typecheck).toBe('node scripts/typecheck.mjs');
        expect(readFileSync(join(root, 'scripts/typecheck.mjs'), 'utf8')).toContain('packages/shared/tsconfig.json');
    });

    it('is private, ESM and gives built JavaScript to anything without a source mapping', () => {
        const manifest = json('packages/shared/package.json');
        expect(manifest.private).toBe(true);
        expect(manifest.type).toBe('module');
        expect(manifest.author).toBeUndefined();
        expect(manifest.exports).toEqual({ './*': { types: './dist/*.d.ts', default: './dist/*.js' } });
    });

    it('compiles the server against the build, not the source', () => {
        const config = json('tsconfig.server.json');
        expect(config.compilerOptions.paths).toEqual({});
        expect(json('tsconfig.json').compilerOptions.paths['@socio/shared/*']).toEqual(['./packages/shared/src/*.ts']);
        expect(json('package.json').scripts.build).toMatch(/build-packages\.mjs && tsc -p tsconfig\.server\.json/);
    });

    it('keeps the package under the lint rules it had as src/shared', () => {
        const { overrides } = json('.oxlintrc.json');
        const covering = (rule: string) =>
            overrides.filter((entry: { files: string[]; rules: Record<string, unknown> }) => rule in entry.rules);
        for (const rule of ['socio/locale', 'no-restricted-imports']) {
            expect(
                covering(rule).some((entry: { files: string[] }) =>
                    entry.files.includes('packages/shared/src/**/*.ts'),
                ),
                rule,
            ).toBe(true);
        }
    });
});

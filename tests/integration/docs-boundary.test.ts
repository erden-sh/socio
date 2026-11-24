import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { it, expect } from 'vitest';

it('the real build boundary blocks direct content imports, server docs imports and client loader paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'docs-boundary-'));
    const guard = resolve('scripts/check-docs-boundary.mjs');
    try {
        await mkdir(join(root, 'packages/client/src'), { recursive: true });
        await writeFile(join(root, 'package.json'), '{"dependencies":{}}');
        await writeFile(join(root, 'packages/client/package.json'), '{"dependencies":{}}');
        const file = join(root, 'packages/client/src/page.tsx');
        const run = () => spawnSync(process.execPath, [guard], { cwd: root, encoding: 'utf8' });
        await writeFile(
            file,
            "import type { DocsScreen } from '@socio/shared/docs';\nexport const page = '/docs/getting-started';",
        );
        expect(run().status).toBe(0);
        for (const source of [
            "import content from '../../content/docs/operate/secrets.md';",
            "import {getDocsCatalog} from '../server/docs/catalog';",
            "const content=import('../../content/docs/admin/settings.md');",
            'const data=useFumadocsLoader();',
        ]) {
            await writeFile(file, source);
            expect(run().status).not.toBe(0);
        }
        await writeFile(file, 'export const safe=true;');
        for (const manifest of ['package.json', 'packages/client/package.json']) {
            await writeFile(join(root, manifest), '{"dependencies":{"fumadocs-mdx":"1.0.0"}}');
            expect(run().status, manifest).not.toBe(0);
            await writeFile(join(root, manifest), '{"dependencies":{}}');
        }
        expect(run().status).toBe(0);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

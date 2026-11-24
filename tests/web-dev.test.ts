import { join } from 'node:path';

import { isFileLoadingAllowed, resolveConfig } from 'vite';
import { expect, it } from 'vitest';

import { devFsDeny } from '../src/server/web/dev.js';

// Development's Vite serves files under the project, but never the apps'
// files: future relay secrets live under apps/. Checked with Vite's own
// rule (`server.fs.deny`), as its dev server applies it.
it('never serves files under apps/, the data folder or local state in development', async () => {
    const root = process.cwd();
    const config = await resolveConfig(
        { configFile: false, root, logLevel: 'silent', server: { fs: { deny: devFsDeny(root) } } },
        'serve',
    );
    for (const denied of [
        'apps/relay/secrets.json',
        'apps/relay/keys/relay.json',
        'data/socio.sqlite',
        '.local/notes/note.md',
        '.env',
    ]) {
        expect(isFileLoadingAllowed(config, join(root, denied)), denied).toBe(false);
    }
    expect(isFileLoadingAllowed(config, join(root, 'src/server/index.ts'))).toBe(true);
    expect(devFsDeny(root)).toContain(join(root, 'apps/**'));
});

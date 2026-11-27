import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from 'vitest';

const root = join(import.meta.dirname, '../..');

it('ships compiled React components, declarations, themes and the license to an independent consumer', () => {
    const consumer = mkdtempSync(join(tmpdir(), 'socio-ui-'));
    try {
        const archive = join(consumer, 'ui.tgz');
        const pkg = join(consumer, 'node_modules/@socio/ui');
        execFileSync('pnpm', ['--dir', 'packages/ui', 'pack', '--out', archive], { cwd: root });
        mkdirSync(pkg, { recursive: true });
        execFileSync('tar', ['-xzf', archive, '--strip-components=1', '-C', pkg]);
        const manifest = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8'));
        expect(manifest.name).toBe('@socio/ui');
        expect(manifest.exports['.']).toEqual({ types: './dist/index.d.ts', import: './dist/index.js' });
        expect(existsSync(join(pkg, 'dist/LICENSE'))).toBe(true);
        expect(existsSync(join(pkg, 'dist/THIRD_PARTY_NOTICES'))).toBe(true);
        expect(existsSync(join(pkg, 'src'))).toBe(false);
        const css = readFileSync(join(pkg, 'dist/styles.css'), 'utf8');
        expect(css).not.toMatch(/@(?:import|apply|source|theme)\b/);
        for (const id of ['indigo', 'erden', 'erden-glass', 'cobalt', 'plum', 'clay']) {
            expect(css).toMatch(new RegExp(`data-theme=["']?${id}["']?\\]`));
        }
        expect(css).toContain('backdrop-filter');
        expect(css).toContain('prefers-reduced-motion');

        // Use existing third-party dependencies so the consumer can run offline.
        // Everything imported from @socio/ui comes from the archive above.
        const modules = join(consumer, 'node_modules');
        for (const name of Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies })) {
            symlinkSync(join(root, 'node_modules', name), join(modules, name), 'dir');
        }
        mkdirSync(join(modules, '@types'));
        symlinkSync(join(root, 'node_modules/@types/react'), join(modules, '@types/react'), 'dir');
        writeFileSync(join(consumer, 'package.json'), '{"type":"module"}\n');
        writeFileSync(
            join(consumer, 'example.tsx'),
            `
            import { AccessReview, QuickActions, Card } from '@socio/ui';
            import { Button } from '@socio/ui/components/button';
            export const Example = () => (
                <Card>
                    <QuickActions trigger={<Button>Open commands</Button>} title="Commands" description="Actions"
                        searchLabel="Search" emptyMessage="No commands">Content</QuickActions>
                    <AccessReview trigger={<Button>Review</Button>} title="Review" description="Check access"
                        state="partial" stateMessage="Some roles are missing">Loaded roles</AccessReview>
                </Card>
            );
        `,
        );
        execFileSync(
            join(root, 'node_modules/.bin/tsc'),
            ['--noEmit', '--strict', '--skipLibCheck', '--jsx', 'react-jsx', '--module', 'NodeNext', 'example.tsx'],
            { cwd: consumer },
        );
        const markup = execFileSync(
            process.execPath,
            [
                '--input-type=module',
                '-e',
                `
            import { createElement } from 'react';
            import { renderToStaticMarkup } from 'react-dom/server';
            import { Button, Card } from '@socio/ui';
            import { Button as FamilyButton } from '@socio/ui/components/button';
            if (Button !== FamilyButton) throw new Error('Component exports do not match');
            console.log(renderToStaticMarkup(createElement(Card, null, createElement(Button, null, 'Invite'))));
        `,
            ],
            { cwd: consumer, encoding: 'utf8' },
        );
        expect(markup).toContain('data-slot="card"');
        expect(markup).toContain('>Invite</button>');
    } finally {
        rmSync(consumer, { recursive: true, force: true });
    }
}, 45_000);

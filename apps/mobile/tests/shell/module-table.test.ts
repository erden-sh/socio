import { existsSync, globSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { MODULE_IDS } from '@socio/shared/modules';

import { MODULES } from '../../src/shell/modules';
import { theme } from '../../src/theme/theme';
import { SYMBOLS } from '../../src/ui/symbols';

// The module table (src/shell/modules.ts) against the web's modules: each
// client module file (packages/client/src/modules/*/module.ts*, an input of
// the app's test task) read as text, its ClientModule's
// own id, title, memberTitle, navLabel, icon and tone. Every icon must exist in
// lucide-react-native 1.80.0, the app's, and src/screens/module-icons.ts must
// map it to the app's name for it (src/ui/symbols.ts), lucide's file name.

const app = join(import.meta.dirname, '../..');
const modules = join(app, '../../packages/client/src/modules');
const lucide = join(app, 'node_modules/lucide-react-native');

interface WebModule {
    file: string;
    id: string;
    title: string;
    memberTitle?: string;
    navLabel?: string;
    icon: string;
    tone: string;
}

/** A ClientModule's own fields: the object after `: ClientModule = {`, at its first indent. */
function readModule(file: string): WebModule {
    const text = readFileSync(join(modules, file), 'utf8');
    const start = text.indexOf(': ClientModule = {');
    expect(start, `${file} declares no ClientModule`).toBeGreaterThan(-1);
    const body = text.slice(start);
    const field = (name: string) => body.match(new RegExp(`\\n    ${name}: ([^\\n]+),\\n`))?.[1];
    const string = (name: string) => {
        const value = field(name);
        if (value === undefined) {
            return undefined;
        }
        const quoted = value.match(/^'([^']*)'$/);
        expect(quoted, `${file}: ${name} isn't a plain string (${value})`).not.toBeNull();
        return quoted![1];
    };
    const id = field('id')?.match(/^MODULE_IDS\.(\w+)$/)?.[1];
    expect(id, `${file}: its id isn't MODULE_IDS.<name>`).toBeDefined();
    const icon = field('icon');
    expect(icon, `${file}: its icon isn't a lucide import`).toMatch(/^[A-Z]\w*$/);
    return {
        file,
        id: MODULE_IDS[id as keyof typeof MODULE_IDS],
        title: string('title')!,
        memberTitle: string('memberTitle'),
        navLabel: string('navLabel'),
        icon: icon!,
        tone: string('tone')!,
    };
}

/** lucide's file name for an export: `Clock3` is `clock-3`, `ListTodo` is `list-todo`. */
const kebab = (name: string) =>
    name
        .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
        .replace(/([a-zA-Z])([0-9])/g, '$1-$2')
        .toLowerCase();

const web = globSync('*/module.{ts,tsx}', { cwd: modules })
    .sort()
    .map((file) => readModule(file));

describe('the module table', () => {
    it('has every web module and no other, with its title, member title, nav label, icon and tone', () => {
        expect(web.length).toBeGreaterThan(10);
        const fromWeb = web.map(({ file: _, ...entry }) => entry).sort((a, b) => a.id.localeCompare(b.id));
        const ours = MODULES.map((entry) => ({ memberTitle: undefined, navLabel: undefined, ...entry })).sort((a, b) =>
            a.id.localeCompare(b.id),
        );
        expect(ours).toEqual(fromWeb);
        expect(new Set(MODULES.map((entry) => entry.id)).size).toBe(MODULES.length);
    });

    it('uses only tones the theme carries', () => {
        for (const entry of MODULES) {
            expect(Object.keys(theme.light.tones)).toContain(entry.tone);
        }
    });

    it('names icons lucide-react-native 1.80.0 has, each mapped to the app’s symbol of that name', () => {
        expect(JSON.parse(readFileSync(join(lucide, 'package.json'), 'utf8')).version).toBe('1.80.0');
        const icons = readFileSync(join(app, 'src/screens/module-icons.ts'), 'utf8');
        for (const name of new Set(MODULES.map((entry) => entry.icon))) {
            expect(existsSync(join(lucide, 'dist/esm/icons', `${kebab(name)}.mjs`)), `${name}`).toBe(true);
            expect(icons).toContain(`${name}: '${kebab(name)}',`);
            expect(Object.keys(SYMBOLS)).toContain(kebab(name));
        }
    });

    it('reads the kebab names lucide uses', () => {
        expect(kebab('Clock3')).toBe('clock-3');
        expect(kebab('ListTodo')).toBe('list-todo');
        expect(kebab('MessageCircleQuestion')).toBe('message-circle-question');
        expect(kebab('Settings2')).toBe('settings-2');
    });
});

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import { classNamesIn } from '../helpers/class-names';
import { compileUniwind, type UniwindCompile } from '../helpers/uniwind';

// Every class name the app writes compiles to a style. uniwind types className
// as a plain string and, at run time, skips a name its stylesheet lacks, so a
// typo, or a token the web renames before theme.css is regenerated, would
// leave a screen without its background or a banner without its surface, in
// both schemes, with the typecheck and the lint green. So this reads each name
// from the source (helpers/class-names.ts) and looks it up in the stylesheet
// uniwind compiles from global.css for each platform (helpers/uniwind.ts),
// the one the bundle carries.

const src = join(import.meta.dirname, '../../src');
const sources = readdirSync(src, { recursive: true, encoding: 'utf8' })
    .filter((file) => /\.tsx?$/.test(file))
    .sort();
const uses = sources.flatMap((file) => classNamesIn(readFileSync(join(src, file), 'utf8'), `src/${file}`));

const compiled: Partial<Record<'android' | 'ios', UniwindCompile>> = {};
beforeAll(async () => {
    compiled.android = await compileUniwind('android');
    compiled.ios = await compileUniwind('ios');
}, 60_000);

describe('the app’s class names', () => {
    it('are read from every place the primitives and screens write them', () => {
        const names = new Set(uses.map(({ name }) => name));
        // From a plain className, a cx() call, a conditional, a const, the
        // looks' maps (TONES[tone], look.box, style.box) and a *ClassName prop.
        for (const name of [
            'bg-screen',
            'text-center',
            'border-destructive',
            'opacity-50',
            'grow',
            'text-muted-foreground',
            'border-paused-banner-border',
            'bg-paused-banner',
            'active:bg-primary-hover',
            'dark:active:bg-accent/50',
            'accent-muted-foreground',
        ]) {
            expect(names, name).toContain(name);
        }
    });

    it.each(['android', 'ios'] as const)('each compile to a style on %s', (platform) => {
        const { stylesheet } = compiled[platform]!;
        const missing = uses
            .filter(({ name }) => !stylesheet[name]?.every((style) => style.entries.length > 0))
            .map(({ name, file, line }) => `${file}:${line}: ${name}`);
        expect(missing).toEqual([]);
    });

    it('would catch a class name that compiles to nothing', () => {
        // The typos and the renamed tokens this test exists for.
        const { stylesheet } = compiled.android!;
        for (const name of ['bg-sreen', 'bg-pause-banner', 'border-paused-banner-bordr', 'text-foregrund']) {
            expect(stylesheet[name], name).toBeUndefined();
        }
        expect(stylesheet['bg-screen']?.[0]?.entries.length).toBeGreaterThan(0);
    });
});

describe('reading class names from source', () => {
    const read = (source: string) => classNamesIn(source, 'fixture.tsx').map(({ name, line }) => `${line} ${name}`);

    it('follows a look map through a const, an entry’s key, cx(), conditionals and a *ClassName prop', () => {
        const source = [
            "const LOOKS = { on: { box: 'bg-primary', tone: 'not-a-class' }, off: { box: 'bg-muted' } } as const;",
            "const TONES = { a: 'text-foreground', b: 'text-primary' } as const;",
            'export function Thing({ look, on, className }: Props) {',
            '    const style = LOOKS[look];',
            "    const frame = cx('flex-1', on && 'opacity-50');",
            '    return (',
            "        <View className={cx(style.box, on ? 'border-ring' : 'border-input', className)}>",
            '            <Text className={TONES[look]} placeholderTextColorClassName="accent-primary" />',
            '            <ScrollView contentContainerClassName={frame} />',
            '        </View>',
            '    );',
            '}',
        ].join('\n');
        expect(read(source).sort()).toEqual(
            [
                '1 bg-primary',
                '1 bg-muted',
                '2 text-foreground',
                '2 text-primary',
                '5 flex-1',
                '5 opacity-50',
                '7 border-ring',
                '7 border-input',
                '8 accent-primary',
            ].sort(),
        );
    });

    it('refuses class names it can’t read, rather than leave them unchecked', () => {
        expect(() => read('const c = (x: string) => <View className={`bg-${x}`} />;')).toThrow(
            /fixture.tsx:1: can't read the class names in this TemplateLiteral/,
        );
        expect(() => read("import { BOX } from './box';\nconst c = () => <View className={BOX} />;")).toThrow(
            /fixture.tsx:2: can't read the class names in this Identifier/,
        );
        expect(() => read('const c = () => <View className={names()} />;')).toThrow(/in this CallExpression/);
    });
});

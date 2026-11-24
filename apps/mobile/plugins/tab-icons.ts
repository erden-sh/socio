import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

import type { ExpoConfig } from 'expo/config';
import { withDangerousMod } from 'expo/config-plugins';

// The native tab bar's icons on Android (src/navigation/tabs.ts):
// react-native-screens' Material bottom navigation takes an image or a
// drawable, not an SVG component, so each tab's lucide icon is written as a
// vector drawable at prebuild, `res/drawable/tab_<icon>.xml`, which the tab
// table names (`{ uri: 'tab_house' }`). The drawable is lucide's own outline
// (24 × 24, stroke 2, round caps and joins), read from lucide-react-native's
// icon file, white and tinted by the tab bar. iOS uses SF Symbols, which the
// system tab bar draws in its glass. A dangerous mod, so introspection skips
// it: tests/native-config.test.ts runs the builder.

type Attrs = Readonly<Record<string, string | number>>;
type IconNode = readonly (readonly [string, Attrs])[];

const n = (value: string | number | undefined) => Number(value ?? 0);

/** One lucide element as path data: path, circle, ellipse, rect, line, polyline and polygon. */
export function elementPath(tag: string, a: Attrs): string {
    switch (tag) {
        case 'path':
            return String(a.d);
        case 'circle':
        case 'ellipse': {
            const cx = n(a.cx);
            const cy = n(a.cy);
            const rx = n(tag === 'circle' ? a.r : a.rx);
            const ry = n(tag === 'circle' ? a.r : a.ry);
            return `M${cx - rx} ${cy}a${rx} ${ry} 0 1 0 ${2 * rx} 0a${rx} ${ry} 0 1 0 ${-2 * rx} 0`;
        }
        case 'rect': {
            const x = n(a.x);
            const y = n(a.y);
            const w = n(a.width);
            const h = n(a.height);
            const rx = Math.min(n(a.rx ?? a.ry), w / 2);
            const ry = Math.min(n(a.ry ?? a.rx), h / 2);
            if (rx === 0 || ry === 0) {
                return `M${x} ${y}h${w}v${h}h${-w}z`;
            }
            return (
                `M${x + rx} ${y}h${w - 2 * rx}a${rx} ${ry} 0 0 1 ${rx} ${ry}v${h - 2 * ry}` +
                `a${rx} ${ry} 0 0 1 ${-rx} ${ry}h${-(w - 2 * rx)}a${rx} ${ry} 0 0 1 ${-rx} ${-ry}` +
                `v${-(h - 2 * ry)}a${rx} ${ry} 0 0 1 ${rx} ${-ry}z`
            );
        }
        case 'line':
            return `M${n(a.x1)} ${n(a.y1)}L${n(a.x2)} ${n(a.y2)}`;
        case 'polyline':
        case 'polygon': {
            const points = String(a.points)
                .trim()
                .split(/[\s,]+/);
            const pairs: string[] = [];
            for (let i = 0; i + 1 < points.length; i += 2) {
                pairs.push(`${points[i]} ${points[i + 1]}`);
            }
            return `M${pairs.join('L')}${tag === 'polygon' ? 'z' : ''}`;
        }
        default:
            throw new Error(`A lucide icon element the tab icons can't draw: <${tag}>.`);
    }
}

/** A lucide icon as an Android vector drawable, white, for the tab bar to tint. */
export function vectorDrawable(node: IconNode): string {
    const paths = node.map(
        ([tag, attrs]) =>
            `    <path android:pathData="${elementPath(tag, attrs)}" android:fillColor="#00000000" android:strokeColor="#FFFFFFFF" android:strokeWidth="2" android:strokeLineCap="round" android:strokeLineJoin="round" />`,
    );
    return [
        '<?xml version="1.0" encoding="utf-8"?>',
        '<vector xmlns:android="http://schemas.android.com/apk/res/android" android:width="24dp" android:height="24dp" android:viewportWidth="24" android:viewportHeight="24">',
        ...paths,
        '</vector>',
        '',
    ].join('\n');
}

/** lucide-react-native's data for icon `name` (kebab case), read from its file without loading React Native. */
export function lucideNode(projectRoot: string, name: string): IconNode {
    const file = path.join(projectRoot, 'node_modules', 'lucide-react-native', 'dist', 'esm', 'icons', `${name}.mjs`);
    const source = fs.readFileSync(file, 'utf8');
    const literal = /const __iconData = (\{[\s\S]*?\n\});/.exec(source)?.[1];
    if (literal === undefined) {
        throw new Error(`lucide-react-native's ${name} icon has no __iconData.`);
    }
    const data = vm.runInNewContext(`(${literal})`, {}, { timeout: 100 }) as { node: IconNode };
    return data.node;
}

/**
 * The tab table's lucide icons (src/navigation/tabs.ts, TAB_LUCIDE_ICONS, which
 * this file can't import: app.config.ts loads it without the app's aliases).
 * tests/native-config.test.ts compares the two.
 */
export const TAB_ICONS = ['house', 'message-circle', 'folder', 'ellipsis', 'search'] as const;

/** The drawable's resource name for lucide icon `name`. */
export const tabIconResource = (name: string) => `tab_${name.replace(/-/g, '_')}`;

export default function withTabIcons(config: ExpoConfig, icons: readonly string[] = TAB_ICONS): ExpoConfig {
    return withDangerousMod(config, [
        'android',
        (next) => {
            const dir = path.join(next.modRequest.platformProjectRoot, 'app', 'src', 'main', 'res', 'drawable');
            fs.mkdirSync(dir, { recursive: true });
            for (const icon of icons) {
                const xml = vectorDrawable(lucideNode(next.modRequest.projectRoot, icon));
                fs.writeFileSync(path.join(dir, `${tabIconResource(icon)}.xml`), xml);
            }
            return next;
        },
    ]);
}

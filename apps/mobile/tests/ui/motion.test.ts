import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { dampingRatio, systemSpring } from '../../src/ui/motion';

// The app's own motion uses each platform's springs, never a timed
// curve, and jumps to the end under Reduce Motion. No React Native renderer
// under Node, so the .tsx files are read as text.

const src = join(import.meta.dirname, '../../src');
const read = (file: string) => readFileSync(join(src, file), 'utf8');

describe('the platform springs', () => {
    it('are UIKit’s smooth springs on iOS: no bounce, a 0.4 s response, 0.3 s for small parts', () => {
        for (const kind of ['spatial', 'fast', 'effects'] as const) {
            expect(dampingRatio(systemSpring('ios', kind))).toBeCloseTo(1, 2);
        }
        // The response is the undamped period: 2π / √stiffness.
        expect((2 * Math.PI) / Math.sqrt(systemSpring('ios', 'spatial').stiffness)).toBeCloseTo(0.4, 2);
        expect((2 * Math.PI) / Math.sqrt(systemSpring('ios', 'fast').stiffness)).toBeCloseTo(0.3, 2);
    });

    it('are Material 3’s motion scheme on Android: 0.9 damped spatial springs, critically damped effects', () => {
        expect(systemSpring('android', 'spatial').stiffness).toBe(700);
        expect(systemSpring('android', 'fast').stiffness).toBe(1400);
        expect(dampingRatio(systemSpring('android', 'spatial'))).toBeCloseTo(0.9, 2);
        expect(dampingRatio(systemSpring('android', 'fast'))).toBeCloseTo(0.9, 2);
        expect(systemSpring('android', 'effects').stiffness).toBe(1600);
        expect(dampingRatio(systemSpring('android', 'effects'))).toBeCloseTo(1, 2);
    });

    it('can run on reanimated’s UI thread: every function is a worklet', () => {
        const motion = read('ui/motion.ts');
        const functions = motion.match(/^(export )?function \w+/gm) ?? [];
        expect(functions.length).toBeGreaterThan(2);
        expect(motion.match(/\{\n {4}'worklet';/g)?.length).toBe(functions.length);
    });

    it('replace the timed curves: no withTiming or Animated.timing for what the app moves itself', () => {
        for (const file of [
            'navigation/shell-drawer.tsx',
            'screens/turn-disclosure.tsx',
            'screens/page-editor-bar.tsx',
        ]) {
            const text = read(file);
            expect(text, file).not.toMatch(/withTiming|Animated\.timing|Easing/);
        }
        expect(read('screens/turn-disclosure.tsx')).toContain(
            'Animated.spring(turn, { toValue: open ? 1 : 0, ...TURN_SPRING, useNativeDriver: true })',
        );
        expect(read('screens/page-editor-bar.tsx')).toContain(
            'Animated.spring(collapsed, { toValue, ...TITLE_SPRING, useNativeDriver: true })',
        );
    });

    it('jump to the end under Reduce Motion', () => {
        expect(read('screens/turn-disclosure.tsx')).toContain('turn.setValue(open ? 1 : 0)');
        const bar = read('screens/page-editor-bar.tsx');
        expect(bar).toContain('const reduceMotion = useReducedMotion();');
        expect(bar).toMatch(/if \(reduceMotion\) \{\s+collapsed\.setValue\(toValue\);/);
    });
});

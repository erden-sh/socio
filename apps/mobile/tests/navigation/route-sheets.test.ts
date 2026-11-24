import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { onPlatform, pageSheet, pageSheetTopInset, sheet } from '../../src/navigation/presets';
import { createRouteSheets, newSheetId, SHEET_ROUTES, sheetRoute } from '../../src/navigation/route-sheets';
import { ROUTES } from '../../src/navigation/routes';

// CB-421: the in-place pickers are real native
// sheets, the Sheet and TallSheet routes with their grabber, detents and
// swipe down; File an issue and New Space are page sheets.

const SRC = join(import.meta.dirname, '../../src');
const read = (file: string) => readFileSync(join(SRC, file), 'utf8');

describe('the pickers’ sheet routes', () => {
    it('opens a short picker at the medium detent alone and a long one at medium, then large', () => {
        expect(sheetRoute(false)).toBe('Sheet');
        expect(sheetRoute(true)).toBe('TallSheet');
        expect(ROUTES[SHEET_ROUTES.short].preset).toMatchObject({
            presentation: 'formSheet',
            sheetGrabberVisible: true,
            gestureEnabled: true,
            sheetAllowedDetents: [0.5],
        });
        expect(ROUTES[SHEET_ROUTES.tall].preset).toMatchObject({ sheetAllowedDetents: [0.5, 1] });
        expect(sheet({ detent: 0.5, expands: false }).sheetAllowedDetents).toEqual([0.5]);
        expect(onPlatform(ROUTES.TallSheet.preset, 'android').sheetAllowedDetents).toEqual([0.5]);
        expect(ROUTES.Sheet).not.toHaveProperty('linking');
    });

    it('hands the screen’s content to the route, which pops itself once the screen closes it', () => {
        const sheets = createRouteSheets<string>();
        const heard = vi.fn();
        const dismiss = vi.fn();
        sheets.subscribe(heard);
        const id = newSheetId();
        expect(newSheetId()).not.toBe(id);
        sheets.present(id, 'filters', dismiss);
        expect(sheets.get(id)).toBe('filters');
        sheets.update(id, 'filters, one on');
        expect(sheets.get(id)).toBe('filters, one on');
        sheets.update(id, 'filters, one on');
        expect(heard).toHaveBeenCalledTimes(2);
        sheets.close(id);
        expect(sheets.get(id)).toBeNull();
        // The route then unmounts: the screen closed it, so it hears nothing.
        sheets.dismissed(id);
        expect(dismiss).not.toHaveBeenCalled();
    });

    it('tells the screen once when the sheet is swiped away', () => {
        const sheets = createRouteSheets<string>();
        const dismiss = vi.fn();
        sheets.present('a', 'move', dismiss);
        sheets.dismissed('a');
        sheets.dismissed('a');
        expect(dismiss).toHaveBeenCalledTimes(1);
        expect(sheets.get('a')).toBeNull();
        sheets.update('a', 'late');
        expect(sheets.get('a')).toBeNull();
    });

    it('leaves no picker in a React Native Modal', () => {
        for (const file of [
            'screens/board.tsx',
            'screens/board-select.tsx',
            'screens/issue-admin.tsx',
            'screens/page-menus.tsx',
            'screens/memories.tsx',
            'screens/page-conflict.tsx',
        ]) {
            const source = read(file);
            expect(source, file).not.toMatch(/<Modal\b/);
            expect(source, file).toMatch(/useRouteSheet\(|RouteSheetContent/);
        }
        const stack = read('navigation/root-stack.tsx');
        expect(stack).toContain('Sheet: RouteSheetScreen,');
        expect(stack).toContain('TallSheet: RouteSheetScreen,');
    });
});

describe('the compose page sheets', () => {
    it('are page sheets with the swipe down, not full-screen modals', () => {
        expect(pageSheet()).toMatchObject({ presentation: 'pageSheet', gestureEnabled: true, headerShown: false });
        expect(ROUTES.FileIssue.preset).toMatchObject({ presentation: 'pageSheet' });
        expect(ROUTES.NewSpace.preset).toMatchObject({ presentation: 'pageSheet' });
    });

    it('pad their own bar by the status bar only on Android, where the sheet is the whole window', () => {
        expect(pageSheetTopInset('ios', 59)).toBe(0);
        expect(pageSheetTopInset('android', 24)).toBe(24);
        for (const file of ['screens/file-issue.tsx', 'screens/new-space.tsx']) {
            expect(read(file), file).toContain('paddingTop: pageSheetTopInset(Platform.OS, insets.top)');
        }
    });
});

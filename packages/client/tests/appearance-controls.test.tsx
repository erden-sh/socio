// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, expect, it, vi } from 'vitest';

import { PersonalAppearance, WorkspaceAppearance } from '@/modules/settings/AppearanceSettings';

beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});

it('keeps the last saved personal theme after a rejected write and can restore inheritance', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const save = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const setValue = async (select: HTMLSelectElement, value: string) => {
        await act(async () => {
            select.value = value;
            select.dispatchEvent(new Event('change', { bubbles: true }));
        });
    };
    try {
        await act(async () =>
            root.render(<PersonalAppearance defaultThemeId="erden" themeId="plum" colorMode="system" mutate={save} />),
        );
        const [theme, mode] = [...host.querySelectorAll('select')];
        expect(theme!.value).toBe('plum');
        expect(theme!.options[0]!.text).toContain('Erden');
        await setValue(theme!, 'cobalt');
        expect(theme!.value).toBe('plum');
        expect(host.querySelector('[role="alert"]')).not.toBeNull();
        await setValue(theme!, '');
        expect(save).toHaveBeenLastCalledWith('/preferences', 'PATCH', { themeId: null });
        expect(theme!.value).toBe('');
        expect(mode!.value).toBe('system');
    } finally {
        await act(async () => root.unmount());
        host.remove();
    }
});

it('restores the product default independently from personal preferences', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const save = vi.fn().mockResolvedValue(true);
    try {
        await act(async () => root.render(<WorkspaceAppearance defaultThemeId="erden" mutate={save} />));
        const choice = host.querySelector('select')!;
        expect(choice.options[0]!.text).toContain('Erden Glass');
        await act(async () => {
            choice.value = '';
            choice.dispatchEvent(new Event('change', { bubbles: true }));
        });
        expect(save).toHaveBeenCalledWith('/settings', 'PATCH', { defaultThemeId: null });
    } finally {
        await act(async () => root.unmount());
        host.remove();
    }
});

// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';

import type { Conversation, Dot } from '@socio/shared/types';

import { chatDraft, newChatDraft } from '../src/modules/chat/chat-drafts';
import { UnsentDraftsWarning, draftPlaces } from '../src/modules/chat/UnsentDraftsWarning';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}

// CB-171: what signing out says about recent unsent drafts.
const chats = [{ id: 'c1', title: 'Trip plan' }] as Conversation[];
const dots = [{ id: 'd1', name: 'Mingo' }] as Dot[];

it('names the chats the drafts are in', () => {
    expect(draftPlaces([chatDraft('c1'), newChatDraft('d1'), chatDraft('gone')], chats, dots)).toEqual([
        'Trip plan',
        'a new chat with Mingo',
        'a chat',
    ]);
});

it('says how many and where, and offers Sign out anyway or Cancel', async () => {
    const onCancel = vi.fn();
    const onSignOut = vi.fn(async () => {});
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () =>
        root.render(
            <UnsentDraftsWarning
                places={['Trip plan', 'a new chat with Mingo']}
                onCancel={onCancel}
                onSignOut={onSignOut}
            />,
        ),
    );
    const dialog = document.querySelector('[data-slot="unsent-drafts-warning"]')!;
    expect(dialog.textContent).toContain('2 unsent drafts');
    expect(dialog.textContent).toContain('Trip plan, a new chat with Mingo');
    const button = (label: string) =>
        [...dialog.querySelectorAll('button')].find((item) => item.textContent === label)!;
    await act(async () => button('Cancel').click());
    expect(onCancel).toHaveBeenCalled();
    expect(onSignOut).not.toHaveBeenCalled();
    await act(async () => button('Sign out anyway').click());
    expect(onSignOut).toHaveBeenCalledOnce();
    await act(async () => root.unmount());
    host.remove();
});

it('names the first few places and counts the rest', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () =>
        root.render(
            <UnsentDraftsWarning places={['A', 'B', 'C', 'D', 'E']} onCancel={() => {}} onSignOut={async () => {}} />,
        ),
    );
    const text = document.querySelector('[data-slot="unsent-drafts-warning"]')!.textContent;
    expect(text).toContain('5 unsent drafts');
    expect(text).toContain('in A, B, C, and 2 more.');
    expect(text).not.toContain('D');
    await act(async () => root.unmount());
    host.remove();
});

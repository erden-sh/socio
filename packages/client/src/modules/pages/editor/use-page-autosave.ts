import { useEffect, useState, useSyncExternalStore } from 'react';

import type { Page } from '@socio/shared/pages/page-library';

import { api } from '../../../lib/api';

import { PageAutosave } from './autosave';

export function usePageAutosave(page: Page, onSaved: (page: Page) => void) {
    const [controller] = useState(() => {
        const instance = new PageAutosave(async (id, patch, signal) => {
            // A folder's body is kept but hidden (CB-426): its saves (a new title) never send it, so
            // nothing here can write over the kept text.
            const { content: _content, ...withoutBody } = patch;
            const body = instance.getSnapshot().page?.folder ? withoutBody : patch;
            const result = await api<Page>(`/spaces/${page.spaceId}/pages/${id}`, 'PATCH', body, signal);
            onSaved(result);
            return result;
        });
        instance.receive(page);
        return instance;
    });
    const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
    useEffect(() => controller.receive(page), [controller, page]);
    useEffect(() => () => controller.dispose(), [controller]);
    return { controller, state };
}

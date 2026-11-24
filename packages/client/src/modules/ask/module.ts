import { MessageCircleQuestion } from 'lucide-react';

import { MODULE_IDS } from '@socio/shared/modules';

import type { ClientModule } from '../types';

import { openAsk } from './ask-context';
import { AskButton, AskMenuItem } from './AskPanel';

/**
 * "Ask a socio" (CB-26): a panel on every screen, from the header, ⌘J or
 * Ctrl+J, or the palette, bound to the person's own conversation about the
 * screen's page, issue, dataset or schedule. No page of its own.
 */
export const askModule: ClientModule = {
    id: MODULE_IDS.ask,
    title: 'Ask a socio',
    description: 'Ask a socio about what is on your screen.',
    icon: MessageCircleQuestion,
    tone: 'mint',
    order: 98,
    opens: { path: '/' },
    launcher: false,
    goTo: false,
    slots: { 'header.actions': [AskButton], 'header.menu': [AskMenuItem] },
    commands: () => [
        {
            id: 'ask:open',
            label: 'Ask a socio about this screen',
            group: 'Actions',
            icon: MessageCircleQuestion,
            keywords: ['assistant', 'help', 'question', 'panel', 'socio'],
            run: () => openAsk(),
        },
    ],
};

import { Bot } from 'lucide-react';

import { CODING_CARD_TOOLS } from '@socio/shared/coding/coding-sessions';
import { MODULE_IDS } from '@socio/shared/modules';

import type { ClientModule } from '../types';

import { CodingSessionRenderer } from './CodingSessionRenderer';
import { COMPUTER_BROWSER_TOOLS, ComputerScreenRenderer } from './ComputerScreenRenderer';

/** Dots: every Dot, the company's and each person's own, with its audit, for admins. */
export const dotsModule: ClientModule = {
    id: MODULE_IDS.dots,
    title: 'Socios',
    description: 'Every socio, the company’s and each person’s own: settings, use and audit.',
    icon: Bot,
    tone: 'indigo',
    order: 72,
    access: 'admin',
    opens: { path: '/admin/dots' },
    sidebar: 'workspace',
    // A Dot's computer: its screen under the steps of a turn that used the
    // browser (for members too: this is about the chat, not the admin page);
    // and its coding sessions' card (CB-239), the sandbox being part of
    // the socio's computer as people see it.
    toolRenderers: {
        cards: CODING_CARD_TOOLS,
        Register: CodingSessionRenderer,
        afterSteps: {
            tools: COMPUTER_BROWSER_TOOLS,
            Component: ComputerScreenRenderer,
        },
    },
};

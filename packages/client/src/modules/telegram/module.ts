import { Send } from 'lucide-react';

import { MODULE_IDS } from '@socio/shared/modules';

import type { ClientModule } from '../types';

import { telegramStatusText } from './TelegramLink';

/** Telegram: link your account; shown once the bot is configured. */
export const telegramModule: ClientModule = {
    id: MODULE_IDS.telegram,
    title: 'Telegram',
    description: 'Link your account and talk to your socios from Telegram.',
    icon: Send,
    tone: 'sky',
    order: 80,
    access: ({ workspace }) => workspace.setup.telegram !== 'not_configured',
    opens: { path: '/settings/telegram' },
    sidebar: 'integrations',
    badge: ({ workspace }) => telegramStatusText[workspace.setup.telegram],
};

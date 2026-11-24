/**
 * The commands the Telegram channel answers itself in a direct message
 * with the bot (CB-145), as the web chat's own controls do: a new chat,
 * which socio you talk to, Stop, the memories waiting for you and how
 * your jobs are doing. They never reach a socio and never start a turn.
 * Chat skills (`/compact`, `/grill_me`) are turns, as on the web, and are
 * listed after these in Telegram's command menu.
 *
 * Group chats and forum topics don't get them: there the bot answers
 * `/bind` (linking a topic to a room, CB-214) and chat skills that name
 * it (`/compact@bot`).
 */
export interface TelegramCommand {
    /** As typed after the slash: Telegram's `[a-z0-9_]`, up to 32. */
    name: string;
    /** Telegram's command menu shows it: up to 256 characters. */
    description: string;
}

export const TELEGRAM_DM_COMMANDS: readonly TelegramCommand[] = [
    {
        name: 'new',
        description: 'Start a new conversation with the same socio.',
    },
    {
        name: 'socio',
        description: 'Choose which socio you talk to here.',
    },
    { name: 'stop', description: 'Stop the answer in progress.' },
    {
        name: 'memories',
        description: 'Review what your socios proposed to remember about you.',
    },
    { name: 'jobs', description: 'See how your long-running jobs are doing.' },
];

/** The channel's own command names; no chat skill may take one. */
export const TELEGRAM_DM_COMMAND_NAMES = TELEGRAM_DM_COMMANDS.map((command) => command.name);

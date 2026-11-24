import { registerRunSource } from '@socio/shared/runs/run-sources';

/**
 * Telegram's turns as a run source (CB-187). Its turns don't record their
 * source: a turn in a chat Telegram started (`telegram_threads`) is
 * Telegram's. Registered when the module loads, and by the analytics
 * process, which reads every module's sources (`operations/etl/sources.ts`).
 * Moved here from `server/telegram/telegram-source.ts` so
 * the analytics process imports no Telegram file.
 */
export const TELEGRAM_RUN_SOURCE = registerRunSource({
    key: 'telegram',
    label: 'Telegram',
    kind: 'human',
    channel: 'telegram',
    threads: { table: 'telegram_threads', column: 'threadId' },
});

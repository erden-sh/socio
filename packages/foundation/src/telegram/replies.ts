/**
 * Posted for a turn that ended without text (approvals' continuation posts
 * it too). Moved here from `server/telegram/contract.ts`, which re-exports
 * it, so approvals, below Telegram in the folder order, can name it.
 */
export const NO_TEXT_REPLY = 'The socio finished without a text reply.';

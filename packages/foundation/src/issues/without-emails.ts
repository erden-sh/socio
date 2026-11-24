/**
 * Email addresses never reach a notice or what a Dot reads of the board.
 * Moved from `issues/requests.ts`, which re-exports it.
 */

/** Email addresses are never part of a notice's text. */
export const withoutEmails = (text: string) => text.replace(/[^\s@<>()]+@[^\s@<>()]+\.[^\s@<>()]+/g, '[email removed]');

import { CARD_TEXT } from '../socio-access.js';
import { inertText } from '../text/inert-text.js';

/**
 * Text as a socio-access consent card shows it (CB-232): inert
 * and capped. Moved from `src/server/actors/consent.ts`, which re-exports
 * them.
 */

/** The task as the card shows it: inert, capped. */
export const cardTask = (task: string) => inertText(task.trim(), { max: CARD_TEXT.task });

/** An app's label as the card shows it: one inert line. */
export const cardLabel = (label: string) => inertText(label, { max: CARD_TEXT.label, lines: false });

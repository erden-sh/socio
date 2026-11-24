import type { Page } from '@socio/shared/pages/page-library';

export type PageContext = Pick<Page, 'id' | 'spaceId' | 'title'>;

/**
 * The page line older messages in a page chat start with,
 * `From [Title](/spaces/…/pages/…):`, then a blank line. A message is
 * sent as typed now (CB-158): the server gives the Dot the chat's page in
 * the turn's note, and the chat shows it once, in its banner.
 */
const PAGE_LINE = /^From \[[^\]\n]*\]\(\/spaces\/[^/)\s]+\/pages\/[^)\s]+\):\n\n/;

/** A message's text without that page line, for display; stored text keeps it. */
export const withoutPageLine = (text: string) => text.replace(PAGE_LINE, '');

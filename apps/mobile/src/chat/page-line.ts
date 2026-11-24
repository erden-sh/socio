// The page line older page chats' messages start with (CB-158; the web's
// packages/client/src/modules/pages/page-context.ts, copied, since the app
// can't import the web's package): `From [Title](/spaces/…/pages/…):`, then a
// blank line. A message is sent as typed now: the server gives the socio the
// chat's page in the turn's note, and the chat shows it once, in its banner
// (CB-499, screens/page-chat-context.tsx). No React Native.

const PAGE_LINE = /^From \[[^\]\n]*\]\(\/spaces\/[^/)\s]+\/pages\/[^)\s]+\):\n\n/;

/** A message's text without that page line, for display; stored text keeps it. */
export const withoutPageLine = (text: string) => text.replace(PAGE_LINE, '');

/**
 * The words the live chat shows (ClientChat). Chat routes inline some of
 * them and load the rest with their data (ChatThread.route.tsx); the Ask
 * panel and pages don't, so the chat waits for them behind its loading
 * state.
 */
export const CHAT_NAMESPACES = ['chat', 'chat.composer', 'chat.model', 'chat.trace', 'chat.menu'] as const;

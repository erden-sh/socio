/**
 * The admin transcript view of a chat (CB-188), and the page it is opened
 * from (an Operations section's id), which the access log keeps.
 */
export const transcriptPath = (threadId: string, via: string) =>
    `/operations/chats/${encodeURIComponent(threadId)}?via=${encodeURIComponent(via)}`;

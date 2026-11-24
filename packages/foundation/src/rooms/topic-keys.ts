/** The key a forum topic's conversation has (`telegram_threads.key`). */
export const topicKey = (chatId: string, topicId: string) => `tg:${chatId}:topic:${topicId}`;

/** A topic's chat and topic id, from its key. */
export function topicOfKey(key: string) {
    const match = /^tg:(-?\d+):topic:(\d+|general)$/.exec(key);
    return match ? { chatId: match[1], topicId: match[2] } : undefined;
}

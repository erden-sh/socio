// What a screen reader is told as a message shows, changes or goes (the
// iOS half of a live region, use-announcement.ts). No React Native here, so
// the Node tests read it as the app does.

/**
 * The message to announce, or undefined: a message is said when it differs
 * from the last one said, so a re-render, or React's second run of an effect
 * in development, says nothing new. No message says nothing, and forgets the
 * last one: an error that goes and comes back is said again.
 */
export function announcement(said: string | undefined, message: string | undefined): string | undefined {
    return message === undefined || message === '' || message === said ? undefined : message;
}

/**
 * Whether this hook says the message itself on `os`. iOS has no live region, so
 * always. Android's live region speaks for a message a view shows (`shown`, the
 * view sets accessibilityLiveRegion); a message no view shows is said here.
 */
export function announcesHere(os: string, { shown }: { readonly shown: boolean }): boolean {
    return os === 'ios' || !shown;
}

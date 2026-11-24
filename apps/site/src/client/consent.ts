// The cookie choice: the banner, the Cookie settings dialog, and the choice kept on this device.
//
// The choice lives in localStorage as `socio_consent` ({ v, analytics, at }), and is asked again
// after 12 months (the cookie policy's table says so). Nothing else is stored, and nothing is sent.
//
// Analytics arrive in a later change (PostHog, through the site's own origin). Until then there
// is nothing to ask about, so the banner doesn't open by itself (ASK_ON_ARRIVAL); the footer's and
// the cookie policy's "Cookie settings" buttons open the dialog, and a choice made there is kept.
// That change sets ASK_ON_ARRIVAL and passes startConsent an `onChoice` that opts PostHog in or out.

export const STORAGE_KEY = 'socio_consent';
export const CONSENT_VERSION = 1;
/** How long a choice stands before the banner asks again: 12 months. */
export const CONSENT_DAYS = 365;
/** Whether the banner opens by itself when no choice stands. Off until analytics exist. */
export const ASK_ON_ARRIVAL = false;

export interface Choice {
    v: typeof CONSENT_VERSION;
    analytics: boolean;
    /** When it was made, ISO 8601. */
    at: string;
}

export type Store = Pick<Storage, 'getItem' | 'setItem'>;

/** A store that lives as long as the page: where the choice goes when the browser denies storage. */
export function memoryStore(): Store {
    const data = new Map<string, string>();
    return {
        getItem: (key) => data.get(key) ?? null,
        setItem: (key, value) => void data.set(key, value),
    };
}

/**
 * The browser's localStorage, or a memory store when reaching it throws (a SecurityError when
 * storage is blocked or the page is sandboxed): the Cookie settings buttons work either way, and
 * the choice holds for this page.
 */
export function pickStorage(get: () => Storage | null | undefined): Store {
    try {
        const storage = get();
        if (storage) {
            return storage;
        }
    } catch {
        // Denied: fall through.
    }
    return memoryStore();
}

/** The standing choice, or null when there is none, it is unreadable, old, or from another version. */
export function readChoice(storage: Store, now: Date): Choice | null {
    let raw: string | null;
    try {
        raw = storage.getItem(STORAGE_KEY);
    } catch {
        return null;
    }
    if (!raw) {
        return null;
    }
    try {
        const parsed = JSON.parse(raw) as Partial<Choice>;
        const at = Date.parse(parsed.at ?? '');
        if (parsed.v !== CONSENT_VERSION || typeof parsed.analytics !== 'boolean' || Number.isNaN(at)) {
            return null;
        }
        const age = now.getTime() - at;
        return age >= 0 && age < CONSENT_DAYS * 86_400_000 ? (parsed as Choice) : null;
    } catch {
        return null;
    }
}

export function writeChoice(storage: Store, analytics: boolean, now: Date): Choice {
    const choice: Choice = { v: CONSENT_VERSION, analytics, at: now.toISOString() };
    try {
        storage.setItem(STORAGE_KEY, JSON.stringify(choice));
    } catch {
        // Storage refused (private mode, full): the choice holds for this page only.
    }
    return choice;
}

/**
 * Wires the banner (#consent-banner), the dialog (#consent-settings) and every
 * `[data-open-cookie-settings]` button. Buttons carry `data-consent="accept|reject|save|customize|close"`.
 * Returns a function that stops listening.
 */
export function startConsent(
    doc: Document,
    storage: Store,
    now: Date,
    onChoice: (choice: Choice) => void = () => {},
    ask = ASK_ON_ARRIVAL,
): () => void {
    const banner = doc.getElementById('consent-banner');
    const dialog = doc.getElementById('consent-settings') as HTMLDialogElement | null;
    const toggle = doc.getElementById('consent-analytics') as HTMLInputElement | null;
    if (!banner || !dialog || !toggle) {
        return () => {};
    }
    const listening = new AbortController();
    const standing = readChoice(storage, now);
    // The choice made on this page, kept here too: when storage refuses a write (full, denied),
    // reopening the dialog still shows what the person chose.
    let current: Choice | null = standing;
    toggle.checked = standing?.analytics ?? false;

    const close = () => {
        banner.hidden = true;
        if (dialog.open) {
            if (typeof dialog.close === 'function') {
                dialog.close();
            } else {
                dialog.removeAttribute('open');
            }
        }
    };
    const choose = (analytics: boolean) => {
        toggle.checked = analytics;
        current = writeChoice(storage, analytics, new Date());
        onChoice(current);
        close();
    };
    const open = () => {
        banner.hidden = true;
        toggle.checked = (current ?? readChoice(storage, new Date()))?.analytics ?? false;
        if (typeof dialog.showModal === 'function') {
            dialog.showModal();
        } else {
            dialog.setAttribute('open', '');
        }
    };

    doc.addEventListener(
        'click',
        (event) => {
            const target = event.target instanceof Element ? event.target.closest('button') : null;
            if (!target) {
                return;
            }
            if (target.hasAttribute('data-open-cookie-settings')) {
                open();
                return;
            }
            switch (target.getAttribute('data-consent')) {
                case 'accept':
                    choose(true);
                    break;
                case 'reject':
                    choose(false);
                    break;
                case 'save':
                    choose(toggle.checked);
                    break;
                case 'customize':
                    open();
                    break;
                case 'close':
                    close();
                    break;
            }
        },
        { signal: listening.signal },
    );

    if (standing) {
        onChoice(standing);
    } else if (ask) {
        banner.hidden = false;
    }
    return () => listening.abort();
}

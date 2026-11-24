/** A disconnected or hidden mobile/sidebar target is never highlighted. */
export function visibleTarget(selector: string | undefined): Element | undefined {
    if (!selector) {
        return;
    }
    return [...document.querySelectorAll(selector)].find((element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return (
            element.isConnected &&
            rect.width > 0 &&
            rect.height > 0 &&
            style.display !== 'none' &&
            style.visibility !== 'hidden'
        );
    });
}
/** Bounded wait after route/lazy rendering; cancellation removes every observer. */
export function waitForTarget(
    selector: string | undefined,
    signal: AbortSignal,
    timeout = 1200,
): Promise<Element | undefined> {
    return new Promise((resolve) => {
        if (!selector || signal.aborted) {
            return resolve(undefined);
        }
        const done = (value?: Element) => {
            observer.disconnect();
            clearTimeout(timer);
            signal.removeEventListener('abort', abort);
            resolve(value);
        };
        const abort = () => done();
        const observer = new MutationObserver(() => {
            const found = visibleTarget(selector);
            if (found) {
                done(found);
            }
        });
        const timer = setTimeout(() => done(visibleTarget(selector)), timeout);
        observer.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
        });
        signal.addEventListener('abort', abort, { once: true });
        const found = visibleTarget(selector);
        if (found) {
            done(found);
        }
    });
}

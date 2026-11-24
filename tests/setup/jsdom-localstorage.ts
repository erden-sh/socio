// Node 26 ("Lithium") adds an experimental `localStorage` to `globalThis`
// that is `undefined` unless `--localstorage-file` is passed (CB-203).
// Vitest's jsdom environment copies window properties to the global only
// when they are not already there; Node 26's placeholder blocks jsdom's
// working `localStorage`, so every jsdom test that reads or writes it
// fails with "Cannot read properties of undefined". In a jsdom
// environment the real `localStorage` is still on the jsdom window
// (`globalThis.jsdom.window`); copy it back before the tests run.
//
// `sessionStorage` works on Node 26 without a flag, so it is not patched.

const jsdomWindow = (globalThis as { jsdom?: { window?: Window } }).jsdom?.window as
    | (Window & { localStorage?: Storage })
    | undefined;

if (jsdomWindow && typeof jsdomWindow.localStorage === 'object' && typeof globalThis.localStorage === 'undefined') {
    Object.defineProperty(globalThis, 'localStorage', {
        get: () => jsdomWindow.localStorage,
        configurable: true,
    });
}

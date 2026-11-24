// The site's one script, bundled by Vite and loaded with `defer` on every page. It only wires
// the cookie choice (consent.ts); the stylesheet is imported here so Vite emits it beside the script.
import '../styles/site.css';
import { pickStorage, startConsent } from './consent';

// Reading window.localStorage itself can throw (storage blocked): pickStorage falls back to memory.
startConsent(
    document,
    pickStorage(() => window.localStorage),
    new Date(),
);

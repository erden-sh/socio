# Product guides (CB-253)

The signed-in shell offers an optional getting-started guide and a Help entry in
its sidebar, account menu and command palette. The focused guides cover goals and
schedules, Improvements, administration and operations. Definitions live in
`packages/client/src/modules/onboarding/guides.ts`; their role, module and setup predicates come
from the same context as navigation. Each substantive step links directly to a
written help article from CB-94. Those articles are served separately by the
server, with their own access checks.

Driver.js is pinned and bundled with its stylesheet. It is initialized after
hydration, never from SSR. `TourLayer` owns only an overlay; it cannot call a
content mutation. Next/Previous may navigate to an existing product route through
the normal router and its unsaved-page guard. Steps never synthesize a click,
submit a message, create a page, run work, save a draft or approve a request. If a
control is absent, hidden, removed or on another route, a bounded wait ends in an
explanation with a way to continue. Closing, navigating or changing the person
removes the overlay and observers.

Read More opens the exact topic in a separate tab, with `noopener`, leaving the
current step intact. The person can also return after a same-tab navigation or
reload and choose Continue. Guide identity, version, status and stable step ID
are stored through the person's existing `/api/preferences` API and SQLite JSON
row. A PATCH merges guide records instead of overwriting another guide's state.
There is no localStorage dismissal flag. Increase `GUIDE_VERSION` when the content
should be offered again; preserve step IDs within a version. Replay continues a
saved position; Restart explicitly starts at the first available step. Persistence
failures remain visible and offer Retry rather than claiming a successful save.

The current guide status distinguishes `in_progress`, `dismissed` and `completed`.
Unavailable role/feature steps are filtered before indexing, so positions resolve
by step ID rather than a raw filtered index. Preferences contain no user text,
credentials, document IDs or conversation content.

## Verification

- `pnpm exec vitest run tests/onboarding.test.ts packages/client/tests/onboarding-ui.test.tsx tests/integration/dictation.test.ts packages/client/tests/client-modules.test.tsx tests/integration/module-ids.test.ts packages/client/tests/route-config.test.ts`
- `node scripts/onboarding-browser.mjs`

The browser runner builds a synthetic local workspace around the real controller
and Driver.js. It uses disposable fake people and an in-memory preference server;
only loopback GETs and preference PATCHes are admitted. It checks desktop and
390px Chromium mobile emulation, Read More, keyboard/escape behavior, route and
missing-target handling, persistence across reload, focused guides and role
visibility. It preserves every attempt under `artifacts/onboarding-browser-*` and
closes the browser before the fixture server. This is not physical iPhone/PWA or
live-deployment acceptance. Unit/API tests separately exercise actual SQLite
reopening, strict ownership/validation and nested guide merging. Article existence
and server audience protection must also pass with the CB-94 integration.

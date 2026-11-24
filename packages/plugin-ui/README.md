# @socio/plugin-ui

Shared UI for Socio plugin apps. The social-strategy planner is the first
consumer. A second plugin imports this package and keeps its own data,
time zone, and actions.

The package is source-only. Socio builds it with the plugin's Vite bundle.
It is not published.

## Add it to a plugin

In the Socio repo the package is already a workspace member. Depend on it
from the root `package.json`:

```json
"@socio/plugin-ui": "workspace:*"
```

A plugin bundle has to resolve two things this package imports:

1. **`@` → Socio's client.** Components use `@/components/ui/*` and
   `@/lib/utils` (the same shadcn set and `cn` helper as the workspace).
   `scripts/build-planner-ui.mjs` sets that alias. Copy it into the new
   plugin's Vite config.
2. **Tailwind scans this package.** `packages/client/src/globals.css` includes
   `@source "../../plugin-ui"`. Import that stylesheet from the
   plugin entry so the class names here are generated. Also import the
   page CSS:

```tsx
import '../../globals.css';
import '@socio/plugin-ui/plugin.css';
import '@socio/plugin-ui/preview.css';
```

`preview.css` is only needed when the page renders `PreviewCard`.

## Bridge and theme

The host iframe sets `<meta name="socio-parent" content="https://…">`.
Call this once, before `createRoot`:

```tsx
import { installPluginBridge } from '@socio/plugin-ui';

installPluginBridge();
```

That posts `{ v: 1, source: 'socio-plugin', type: 'ready' }` and applies
later `theme` messages by toggling the `dark` class on `<html>`. The
message schema stays in `packages/shared/src/plugins/plugins.ts`. This client imports those
parsers so a plugin cannot drift from the host.

Open a link through the host. When the page is not embedded, `openInHost`
returns false and the anchor navigates on its own. The host opens a link
the manifest's `bridge.open` lists at once. With `bridge.openAnyHttps: true`
it opens any other https link after the person confirms it in a dialog
the workspace draws ("Open docs.example.com in a new tab?"); without it,
or for another scheme (`http:`, `javascript:`, `data:`, `blob:`, `file:`),
nothing opens. The sandbox has no `allow-popups`, so `target="_blank"`
alone never opens from the frame:

```tsx
import { openInHost } from '@socio/plugin-ui';

<a
    href={url}
    target="_blank"
    rel="noopener noreferrer"
    onClick={(event) => {
        if (openInHost(url)) event.preventDefault();
    }}
>
    Open
</a>;
```

Deep links (CB-446). With `bridge.routes: true` in the manifest, the
workspace address mirrors the app's own route exactly:
`/plugins/<id>/events/42?tab=a#b` is the app's `/events/42?tab=a#b`.
`installPluginBridge()` reports the route by itself, now and after every
location change; nothing else is needed. The app answers any path at its
origin. When the workspace sends the open app somewhere (a link into it,
or Back), the default replaces the page's URL and dispatches `popstate`
for the app's router; pass `onGoTo` to do it yourself:

```tsx
import { installPluginBridge } from '@socio/plugin-ui';

installPluginBridge({
    onGoTo: ({ path, query, hash }) => router.navigate(`${path}${query}${hash}`, { replace: true }),
});
```

An app whose URL never changes (a memory router) can tell the host
instead: `navigateInHost('/events/42?tab=a', { replace: true })`.

## Page shell

```tsx
import { PluginPage } from '@socio/plugin-ui';

export function App() {
    return <PluginPage>{/* your screens */}</PluginPage>;
}
```

## Calendar

Map your rows to `CalendarEvent` (`id`, `title`, `start` as UTC
milliseconds, `color`, and optional `hint`, `detail`, `meta`). Pass a
`CalendarTime` for the zone you use. The planner's New York helpers stay
in `packages/client/src/plugins/planner/dates.ts`; the calendar plugin builds one
for any IANA zone in `packages/client/src/plugins/calendar/time.ts`. Neither is in
this package.

An event may also have `end` (UTC milliseconds, exclusive) and `allDay`:

- Without `end`, an event is a point in time: a `BLOCK_MINUTES` block on
  its start day (the planner's posts).
- With `end`, its week block is as tall as it lasts (at least
  `MIN_BLOCK_MINUTES`, clipped at midnight of its start day), overlap
  columns use the real end, and the month and agenda views show it on
  every day it covers.
- `allDay` events sit in an "All day" row under the week's day headers
  and show no clock time. Pass `end` as midnight after the last day.

```tsx
import { Calendar, type CalendarEvent, type CalendarTime } from '@socio/plugin-ui';

<Calendar
    view="week"
    anchor={anchor}
    todayKey={time.dayKey(Date.now())}
    keys={time.weekKeys(anchor)}
    events={events}
    now={Date.now()}
    variant="colored"
    time={time}
    onOpen={(event) => {
        /* look the row up by event.id */
    }}
    onMove={(event, day, hour, minute) => {
        /* hour and minute are set when the drop landed on the week grid */
    }}
    onCreate={(day, hour, minute) => {}}
/>;
```

`variant` is `'colored'` or `'dot'`. `AvatarFilter` is the single-select
account menu. `AvatarChoices` is the radio row of avatars. `MiniMonth`
sits beside the grid. `markedDayKeys(starts, time)` builds the dots.

Drag-and-drop is pointer-based. A drop on the week grid reports a
15-minute slot. A drop on the month or agenda reports the day only.

## Editor and preview

`EditorShell` is the dialog: title, optional account row, the editor
column, the preview column, and a footer. Your plugin owns the draft and
the save request. Pass those as `editor`, `accounts`, `preview`, and
`footer`.

`PreviewCard` is the card frame (avatar, name, handle, time, action
icons). Put your text in `children`. For an X-style body, use the
`tweet-text` and `tweet-link` classes from `preview.css`.

## Catalog cards

`CategoryCard`, `AppCard`, `AppDetail`, `ScreenshotFrame`,
`InstalledCard`, and `CatalogEmpty` are the app-store pieces. The host
Plugins page (`packages/client/src/modules/plugins/PluginsPage.tsx`) keeps search,
install, enable, and scale, and passes icons and actions into these
cards. A plugin can use the same cards for its own catalog-style list.

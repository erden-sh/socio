# Socio UI

`@socio/ui` provides Socio's 25 React component families, seven visual themes, and the Quick actions and Access review patterns. The interactive components use Radix for keyboard navigation, focus management and portals. A consumer supplies its routing, data, permissions and persistence.

## Install in a React project

Pack the library from the Socio checkout. Packing compiles ESM, TypeScript declarations and CSS.

```sh
pnpm --dir packages/ui pack --pack-destination /absolute/path/to/artifacts
```

From the consuming project, install the archive with React 19 and React DOM 19.

```sh
pnpm add /absolute/path/to/artifacts/socio-ui-0.1.0.tgz react@19 react-dom@19
```

Import the compiled stylesheet once at the application entry. The consuming project can use its existing CSS tooling.

```tsx
import { Badge, Button, Card, CardAction, CardHeader, CardTitle } from '@socio/ui';
import '@socio/ui/styles.css';

export function WorkspaceCard({ onInvite }: { onInvite: () => void }) {
    return (
        <Card>
            <CardHeader>
                <CardTitle>Workspace members</CardTitle>
                <Badge variant="success">Active</Badge>
                <CardAction>
                    <Button onClick={onInvite}>Invite people</Button>
                </CardAction>
            </CardHeader>
        </Card>
    );
}
```

Each family also has an entry such as `@socio/ui/components/button`. The archive includes the Socio license.

## Apply a theme

Set the palette on `<html>` so content portalled to `document.body` inherits the same tokens. Render the resolved scheme in the initial HTML for SSR, then update both values in place to switch appearance.

```html
<html lang="en" data-theme="erden-glass" class="dark">
    <!-- Application -->
</html>
```

Use `socio`, `indigo`, `erden`, `erden-glass`, `cobalt`, `plum` or `clay`. Include `dark` for dark mode and remove it for light mode. For a system setting, resolve `matchMedia('(prefers-color-scheme: dark)')` and listen for changes. The host decides how to store settings and what theme to set for its users. With no `data-theme` the library uses Socio's base palette.

`styles.css` ships the utilities used by the library, theme variables and reset rules for component markup. The host styles its own layout. Erden Glass falls back to solid surfaces with reduced transparency, increased contrast or forced colors.

## Compose product interactions

- **Quick actions** renders a searchable command dialog. Provide a trigger, translated labels and `CommandItem` or `CommandGroup` children. Use `open` and `onOpenChange` when an action also closes the dialog or an application shortcut opens it.
- **Access review** renders a sheet with a title, description and review content. Set `state` to `loading`, `ready`, `partial` or `error`. Supply a `stateMessage` for loading, partial and error. The host performs the review and can use `SheetClose` for actions that close the panel.

The Socio development gallery demonstrates both patterns with sample data.

```sh
pnpm exec vite scripts/component-gallery --config scripts/component-gallery/vite.config.ts --host 127.0.0.1 --port 4400
node scripts/check-component-gallery.mjs http://127.0.0.1:4400
```

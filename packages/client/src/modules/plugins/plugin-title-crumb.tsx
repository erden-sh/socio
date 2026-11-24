import { ExternalLink } from 'lucide-react';
import { useEffect, useSyncExternalStore } from 'react';

import { showInHeaderMenu } from '../../shell/header-menu';

import { BreadcrumbPage } from '@/components/ui/breadcrumb';
import { Button } from '@/components/ui/button';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';

const OPEN_LABEL = 'Open in a new tab';

/**
 * The embedded plugin page's own action for the header: Open in a new
 * tab. The page (PluginFrame's ServicePlugin) publishes it while the
 * plugin is in its frame; the header's last crumb shows it beside the
 * name, so the page draws no bar of its own.
 */
interface FrameAction {
    pluginId: string;
    open: () => void;
}

let current: FrameAction | undefined;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => void listeners.delete(listener);
};
const publish = (next: FrameAction | undefined) => {
    current = next;
    for (const listener of listeners) {
        listener();
    }
};

/**
 * Offers `open` in the header while the calling view is mounted and
 * `enabled`: beside the title on wider screens, in the header's ⋯ menu
 * on phones.
 */
export function usePluginFrameAction(pluginId: string, open: () => void, enabled = true) {
    useEffect(() => {
        if (!enabled) {
            return;
        }
        const action = { pluginId, open };
        publish(action);
        const hide = showInHeaderMenu(
            <DropdownMenuItem className="h-8.5" onSelect={open}>
                <ExternalLink />
                {OPEN_LABEL}
            </DropdownMenuItem>,
        );
        return () => {
            hide();
            if (current === action) {
                publish(undefined);
            }
        };
    }, [pluginId, open, enabled]);
}

const useFrameAction = () =>
    useSyncExternalStore(
        subscribe,
        () => current,
        () => undefined,
    );

/** The header's last crumb on `/plugins/:id`: the name, and Open in a new tab. */
export function PluginTitleCrumb({ pluginId, name }: { pluginId: string; name: string }) {
    const action = useFrameAction();
    return (
        <span className="flex min-w-0 items-center gap-1" data-slot="plugin-title">
            <BreadcrumbPage className="truncate" title={name}>
                {name}
            </BreadcrumbPage>
            {action?.pluginId === pluginId && (
                <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    // On phones it is in the header's ⋯ menu. An invisible
                    // 44 px hit area on a touch screen (CB-219).
                    className="relative size-7 shrink-0 text-muted-foreground max-md:hidden pointer-coarse:after:absolute pointer-coarse:after:-inset-2"
                    aria-label={OPEN_LABEL}
                    title={OPEN_LABEL}
                    data-slot="plugin-open-tab"
                    onClick={action.open}
                >
                    <ExternalLink />
                </Button>
            )}
        </span>
    );
}

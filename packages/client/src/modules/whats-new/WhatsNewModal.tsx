import { Puzzle, Sparkles } from 'lucide-react';

import { PluginVersion } from './PluginReleaseCard';
import { useWhatsNewModal } from './use-plugin-release-notes';

import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';

/** Asks the header to open What's new (the Help menu's popover). */
export const OPEN_WHATS_NEW = 'socio:open-whats-new';
export function openWhatsNew() {
    window.dispatchEvent(new CustomEvent(OPEN_WHATS_NEW));
}

const more = (count: number, shown: number) =>
    count > shown ? (
        <p className="text-xs text-muted-foreground">
            And {count - shown} more {count - shown === 1 ? 'version' : 'versions'} in What’s new.
        </p>
    ) : null;

/**
 * "What's new" once per person (CB-527): the first time they open the app
 * after the workspace or a plugin they may open moved on, a summary of
 * the workspace's highlights and a section per updated plugin. Closing it
 * any way records what it showed as seen on the server, so it doesn't
 * come back on this device or another; "See everything" opens What's new.
 */
export function WhatsNewModal() {
    const { whatsNew, dismiss } = useWhatsNewModal();
    if (!whatsNew) {
        return null;
    }
    const { workspace, plugins } = whatsNew;
    return (
        <Dialog
            open
            onOpenChange={(open) => {
                if (!open) {
                    dismiss();
                }
            }}
        >
            <DialogContent
                data-slot="whats-new-modal"
                className="max-h-[min(40rem,calc(100dvh-2rem))] overflow-y-auto sm:max-w-lg"
            >
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <Sparkles className="size-4.5 text-primary" aria-hidden />
                        What’s new
                    </DialogTitle>
                    <DialogDescription>Here’s what changed since you last looked.</DialogDescription>
                </DialogHeader>
                <div className="grid grid-cols-1 gap-4">
                    {workspace && (
                        <section data-slot="whats-new-modal-workspace" aria-label="Socio" className="grid gap-2">
                            {workspace.releases.map((release) => (
                                <div key={release.version} className="grid gap-1">
                                    <h3 className="text-sm font-semibold">v{release.version}</h3>
                                    {release.summary && (
                                        <p className="text-sm text-muted-foreground">{release.summary}</p>
                                    )}
                                    {release.highlights.length > 0 && (
                                        <ul className="list-disc pl-5 text-sm">
                                            {release.highlights.map((highlight, index) => (
                                                <li key={index}>{highlight.title}</li>
                                            ))}
                                        </ul>
                                    )}
                                </div>
                            ))}
                            {more(workspace.count, workspace.releases.length)}
                        </section>
                    )}
                    {plugins.map((plugin) => (
                        <section
                            key={plugin.id}
                            data-slot="whats-new-modal-plugin"
                            data-plugin={plugin.id}
                            aria-label={plugin.name}
                            className="grid gap-2 border-t pt-3 first:border-t-0 first:pt-0"
                        >
                            <h3 className="flex items-center gap-2 text-sm font-semibold">
                                <Puzzle className="size-4 text-muted-foreground" aria-hidden />
                                {plugin.name}
                                <span className="ml-auto text-xs font-normal text-muted-foreground">v{plugin.to}</span>
                            </h3>
                            <ul className="grid grid-cols-1 gap-3">
                                {plugin.releases.map((release) => (
                                    <PluginVersion key={release.version} release={release} />
                                ))}
                            </ul>
                            {more(plugin.count, plugin.releases.length)}
                        </section>
                    ))}
                </div>
                <DialogFooter>
                    <Button
                        variant="outline"
                        data-slot="whats-new-modal-more"
                        onClick={() => {
                            dismiss();
                            // After the dialog's own focus handling, as the Help menu's items do.
                            setTimeout(openWhatsNew, 0);
                        }}
                    >
                        See everything
                    </Button>
                    <Button data-slot="whats-new-modal-close" onClick={dismiss}>
                        Got it
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

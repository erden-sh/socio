/**
 * Side-panel editor shell. The two-column arrangement (editor, live
 * preview, account row, bottom bar) follows inovector/mixpost (MIT) as a
 * design reference only. No Mixpost source is copied.
 *
 * The panel chrome is adapted from coollabsio/shoutrrr (Apache-2.0),
 * resources/js/components/compose/composer.tsx.
 * Copyright Shoutrrr contributors. SPDX-License-Identifier: Apache-2.0
 *
 * The plugin owns the draft, validation, and save. This shell is the frame.
 */
import type { ReactNode } from 'react';

import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';

export function EditorShell({
    title,
    description,
    status,
    onClose,
    accounts,
    error,
    editor,
    preview,
    previewMeta,
    footer,
}: {
    title: ReactNode;
    description?: ReactNode;
    status?: ReactNode;
    onClose: () => void;
    accounts?: ReactNode;
    error?: string;
    editor: ReactNode;
    preview?: ReactNode;
    previewMeta?: ReactNode;
    footer?: ReactNode;
}) {
    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="flex h-[min(880px,94vh)] w-[min(1080px,96vw)] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-none">
                <header className="flex items-start justify-between gap-3 border-b px-4 py-3 pr-12">
                    <div>
                        <DialogTitle>{title}</DialogTitle>
                        {description && <DialogDescription className="mt-1">{description}</DialogDescription>}
                    </div>
                    {status && <span className="text-xs text-muted-foreground">{status}</span>}
                </header>
                {accounts && <div className="flex flex-wrap items-center gap-3 border-b px-4 py-3">{accounts}</div>}
                {error && (
                    <p className="px-4 pt-3 text-sm text-destructive" role="alert">
                        {error}
                    </p>
                )}
                <div className="grid min-h-0 flex-1 lg:grid-cols-[minmax(0,1fr)_22rem]">
                    <div className="flex min-h-0 flex-col gap-3 overflow-y-auto border-b px-4 py-4 lg:border-r lg:border-b-0">
                        {editor}
                    </div>
                    <aside className="min-h-0 overflow-y-auto bg-muted/40 px-4 py-4">
                        <div className="mb-3 flex items-center justify-between">
                            <h2 className="text-sm font-medium">Preview</h2>
                            {previewMeta}
                        </div>
                        {preview}
                    </aside>
                </div>
                {footer && (
                    <footer className="flex flex-wrap items-center justify-between gap-2 border-t px-4 py-3">
                        {footer}
                    </footer>
                )}
            </DialogContent>
        </Dialog>
    );
}

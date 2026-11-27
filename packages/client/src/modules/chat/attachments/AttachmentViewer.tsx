import { ChevronLeft, ChevronRight, Download } from 'lucide-react';
import type { KeyboardEvent } from 'react';

import { useTranslation } from '@socio/i18n/react';
import { attachmentContentUrl, type AttachmentKind } from '@socio/shared/media-types';
import { formatSize } from '@socio/shared/text/format-size';

import { typeIcon } from '../../media/MediaGrid';
import { typeLabel } from '../../media/MediaList';
import { TextPreview } from '../../media/MediaPreview';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';

/** One attachment the viewer can show: sent, or in a composer's tray. */
export interface ViewedAttachment {
    id: string;
    name: string;
    mediaType: string;
    kind: AttachmentKind;
    /** Unknown for a sent message's part. */
    size?: number;
    /**
     * An image the browser has already, as a data URL: a screenshot an older
     * version stored as base64 text in its result (CB-157).
     */
    src?: string;
}

/**
 * Attachments at full size (CB-85), one at a time, from their uploaded
 * originals: an image, text read-only (the start of a long file), or a
 * file's details. Previous and next (or the arrow keys) step through
 * `items`; Escape closes. `shown` is the open one's id.
 */
export function AttachmentViewer({
    items,
    shown,
    onShow,
}: {
    items: readonly ViewedAttachment[];
    shown?: string;
    onShow: (id?: string) => void;
}) {
    const { t } = useTranslation(['chat']);
    const index = items.findIndex((item) => item.id === shown);
    const item = items[index] as ViewedAttachment | undefined;
    const many = items.length > 1;
    const step = (by: number) => onShow(items[(index + by + items.length) % items.length].id);
    const onKeyDown = (event: KeyboardEvent) => {
        if (!many) {
            return;
        }
        if (event.key === 'ArrowLeft') {
            step(-1);
        } else if (event.key === 'ArrowRight') {
            step(1);
        } else {
            return;
        }
        event.preventDefault();
    };
    const Icon = item ? typeIcon(item) : undefined;
    return (
        <Dialog open={!!item} onOpenChange={(open) => !open && onShow(undefined)}>
            <DialogContent
                className="max-h-[92svh] overflow-y-auto sm:max-w-4xl"
                data-slot="attachment-viewer"
                onKeyDown={onKeyDown}
            >
                {item && Icon && (
                    <>
                        <DialogHeader>
                            <DialogTitle className="truncate pr-8 text-sm">{item.name}</DialogTitle>
                            <DialogDescription className="text-xs">
                                {[
                                    typeLabel(item),
                                    item.size !== undefined && formatSize(item.size),
                                    many && t('chat:viewer.position', { at: index + 1, total: items.length }),
                                ]
                                    .filter(Boolean)
                                    .join(' · ')}
                            </DialogDescription>
                        </DialogHeader>
                        {item.kind === 'image' ? (
                            <img
                                key={item.id}
                                src={item.src ?? attachmentContentUrl(item.id)}
                                alt={item.name}
                                className="max-h-[70svh] w-full rounded-md object-contain"
                            />
                        ) : item.kind === 'text' ? (
                            <TextPreview key={item.id} url={attachmentContentUrl(item.id)} />
                        ) : (
                            <div className="flex items-center gap-3 rounded-md bg-muted p-4 text-sm">
                                <Icon className="size-8 text-muted-foreground" aria-hidden />
                                <span>{t('chat:viewer.no-preview')}</span>
                            </div>
                        )}
                        <div className="flex items-center justify-between gap-2">
                            <a
                                className="inline-flex items-center gap-1.5 self-start text-[12px]"
                                href={item.src ?? attachmentContentUrl(item.id, true)}
                                download={item.name}
                            >
                                <Download size={14} /> {t('chat:viewer.download')}
                            </a>
                            {many && (
                                <div className="flex gap-1">
                                    <Button
                                        variant="outline"
                                        size="icon-sm"
                                        aria-label={t('chat:viewer.previous')}
                                        onClick={() => step(-1)}
                                    >
                                        <ChevronLeft />
                                    </Button>
                                    <Button
                                        variant="outline"
                                        size="icon-sm"
                                        aria-label={t('chat:viewer.next')}
                                        onClick={() => step(1)}
                                    >
                                        <ChevronRight />
                                    </Button>
                                </div>
                            )}
                        </div>
                    </>
                )}
            </DialogContent>
        </Dialog>
    );
}

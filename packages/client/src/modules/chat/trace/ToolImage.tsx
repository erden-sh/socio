import { useState } from 'react';

import { attachmentContentUrl } from '@socio/shared/media-types';

import { plainHover } from '../../../lib/plain-button';
import { AttachmentViewer } from '../attachments/AttachmentViewer';

import { cn } from '@/lib/utils';

/** An image a tool returned, as its trace shows it (CB-157). */
export interface ShownToolImage {
    /** The attachment's id; for an older inline one, any key. */
    id: string;
    name: string;
    mediaType: string;
    size?: number;
    /** An older version's screenshot, stored as base64 in its result. */
    src?: string;
}

/**
 * A screenshot or another image a tool returned, as a thumbnail that opens
 * the viewer at full size. Its bytes come from the chat's attachments,
 * which only people who can read the chat get; anyone else (an admin on
 * the Runs page) sees a note instead.
 */
export function ToolImageThumb({
    image,
    small,
}: {
    image: ShownToolImage;
    /** The run view's line: a smaller thumbnail. */
    small?: boolean;
}) {
    const [open, setOpen] = useState(false);
    const [failed, setFailed] = useState(false);
    if (failed) {
        return (
            <p className="m-0 text-[11px]" data-slot="trace-image-missing">
                The image isn’t available: it was deleted, or you can’t read this chat.
            </p>
        );
    }
    return (
        <>
            <button
                type="button"
                className={cn(
                    'block w-fit max-w-full cursor-zoom-in overflow-hidden rounded-[8px] border border-border bg-muted p-0',
                    plainHover,
                )}
                data-slot="trace-image"
                aria-label={`View ${image.name}`}
                onClick={() => setOpen(true)}
            >
                <img
                    className={cn(
                        'block max-w-full min-w-12 object-contain',
                        small ? 'max-h-18 min-h-8' : 'max-h-50 min-h-12',
                    )}
                    src={image.src ?? attachmentContentUrl(image.id)}
                    alt={image.name}
                    loading="lazy"
                    onError={() => setFailed(true)}
                />
            </button>
            <AttachmentViewer
                items={[{ ...image, kind: 'image' }]}
                shown={open ? image.id : undefined}
                onShow={(id) => setOpen(!!id)}
            />
        </>
    );
}

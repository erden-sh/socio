import { Download, FileText, ImageOff } from 'lucide-react';
import { useEffect, useState } from 'react';

import { attachmentContentUrl } from '@socio/shared/media-types';
import type { AttachmentRef } from '@socio/shared/media/refs';
import { formatSize } from '@socio/shared/text/format-size';

import { plainHover } from '../../../lib/plain-button';

import { AttachmentViewer } from './AttachmentViewer';
import { attachmentView } from './upload';

import { cn } from '@/lib/utils';

/**
 * An attachment a message refers to, read from either part shape
 * (`@socio/shared/media/refs`: AG-UI 1.0's media part, or the pre-1.0
 * `binary` one stored history still holds).
 */
export type AttachmentPart = AttachmentRef;

/** A file's chip, on the bubble's color. */
const fileChip =
    'inline-flex max-w-70 items-center gap-1.5 rounded-[8px] border border-[#ffffff40] bg-[#ffffff1f] px-2.5 py-1 text-[11px] leading-[1.6] text-inherit no-underline hover:bg-[#ffffff33]';
const fileName = 'min-w-0 truncate';
const fileNote = 'whitespace-nowrap opacity-75';

const IMAGES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/**
 * A message's attachments in its bubble: images as thumbnails of the
 * original (up to 240 px) that open the viewer, to step through them at
 * full size; other files as chips that download it. One that was deleted
 * shows as "Removed".
 */
export function MessageAttachments({ parts }: { parts: readonly AttachmentPart[] }) {
    const [shown, setShown] = useState<string>();
    if (!parts.length) {
        return null;
    }
    const images = parts.flatMap((part) =>
        IMAGES.has(part.mimeType)
            ? [
                  {
                      id: part.id,
                      name: part.filename ?? 'Image',
                      mediaType: part.mimeType,
                      kind: 'image' as const,
                  },
              ]
            : [],
    );
    return (
        <>
            <ul className="mx-0 mt-2 mb-0 flex list-none flex-wrap gap-2 p-0 first:mt-0" aria-label="Attachments">
                {parts.map((part) =>
                    IMAGES.has(part.mimeType) ? (
                        <ImageThumb key={part.id} part={part} onOpen={() => setShown(part.id)} />
                    ) : (
                        <FileChip key={part.id} part={part} />
                    ),
                )}
            </ul>
            <AttachmentViewer items={images} shown={shown} onShow={setShown} />
        </>
    );
}

function Removed({ name }: { name?: string }) {
    return (
        <li className={cn(fileChip, 'italic opacity-75')} data-slot="attachment-removed">
            <ImageOff size={14} aria-hidden />
            <span className={fileName}>{name ?? 'Attachment'}</span>
            <small className={fileNote}>Removed</small>
        </li>
    );
}

function ImageThumb({ part, onOpen }: { part: AttachmentPart; onOpen: () => void }) {
    const [failed, setFailed] = useState(false);
    if (failed) {
        return <Removed name={part.filename} />;
    }
    return (
        <li>
            <button
                type="button"
                className={cn(
                    'block cursor-zoom-in overflow-hidden rounded-[8px] border-0 bg-transparent p-0',
                    plainHover,
                )}
                data-attachment="image"
                aria-label={`View ${part.filename ?? 'image'}`}
                onClick={onOpen}
            >
                <img
                    className="block max-h-60 min-h-12 max-w-60 min-w-12 rounded-[8px] object-contain"
                    src={attachmentContentUrl(part.id)}
                    alt={part.filename ?? ''}
                    loading="lazy"
                    onError={() => setFailed(true)}
                />
            </button>
        </li>
    );
}

function FileChip({ part }: { part: AttachmentPart }) {
    // The size, and whether the file still exists.
    const [view, setView] = useState<{ size: number } | null>();
    useEffect(() => {
        let live = true;
        attachmentView(part.id)
            .then((value) => live && setView(value))
            .catch(() => undefined);
        return () => {
            live = false;
        };
    }, [part.id]);
    if (view === null) {
        return <Removed name={part.filename} />;
    }
    return (
        <li>
            <a
                className={fileChip}
                data-attachment="file"
                href={attachmentContentUrl(part.id, true)}
                download={part.filename ?? true}
                aria-label={`Download ${part.filename ?? 'attachment'}`}
            >
                <FileText size={14} aria-hidden />
                <span className={fileName}>{part.filename ?? 'Attachment'}</span>
                {view && <small className={fileNote}>{formatSize(view.size)}</small>}
                <Download size={13} aria-hidden />
            </a>
        </li>
    );
}

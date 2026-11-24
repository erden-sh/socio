import { ImageOff, ImagePlus, ImageUp, LoaderCircle, Trash2 } from 'lucide-react';
import { useEffect, useId, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { toast } from 'sonner';

import {
    COVER_MAX_BYTES,
    COVER_UPLOAD_TYPES,
    type CoverImage,
    type Page,
    type PageCover,
} from '@socio/shared/pages/page-library';

import { api } from '../../lib/api';
import { uploadToFolder } from '../chat/attachments/upload';

import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

/*
 * A page's cover (CB-308): a 200 px band above the title, inside the
 * page's reading width. People who may edit the page get "Add cover" on
 * hover or focus of the page's top (always on touch screens), and Change
 * cover and Remove over the band; readers see the band alone. The picker
 * uploads an image to the person's Files, or reuses one of the Space's.
 */

/** What `PUT …/cover` takes: one of the person's files, or an image of the Space. */
export type CoverChoice = { fileId: string } | { embedId: string };

const MB = 1048576;

/** Why a file can't be a cover, or undefined when it can. */
export function coverFileProblem(file: Pick<File, 'type' | 'size'>) {
    if (!COVER_UPLOAD_TYPES.includes(file.type)) {
        return 'Choose a PNG, JPEG or WebP image.';
    }
    if (file.size > COVER_MAX_BYTES) {
        return `Covers can be at most ${COVER_MAX_BYTES / MB} MB.`;
    }
    return undefined;
}

const coverPath = (spaceId: string, pageId: string) =>
    `/spaces/${encodeURIComponent(spaceId)}/pages/${encodeURIComponent(pageId)}/cover`;

const failure = (error: unknown, fallback: string) => (error instanceof Error && error.message) || fallback;

/**
 * Hover and keyboard focus of `group/page-top` (the cover and the title)
 * show a control; touch screens, which can't hover, always show it. Open
 * (its picker showing), it stays.
 */
const revealed =
    'opacity-0 transition-opacity group-focus-within/page-top:opacity-100 group-hover/page-top:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 motion-reduce:transition-none [@media(hover:none)]:opacity-100';

export function PageCoverArea({
    spaceId,
    pageId,
    cover,
    editable,
    onChange,
}: {
    spaceId: string;
    pageId: string;
    cover: PageCover | null;
    /** Whether the person may change it: readers see the band only. */
    editable: boolean;
    /** After a change here: the cover now, and the page when the server sent it. */
    onChange: (cover: PageCover | null, page?: Page) => void;
}) {
    const [picking, setPicking] = useState(false);
    const [removing, setRemoving] = useState(false);
    // The image failed to load (its file deleted since the page was read).
    const [broken, setBroken] = useState<string>();
    const set = async (choice: CoverChoice) => {
        const page = await api<Page>(coverPath(spaceId, pageId), 'PUT', choice);
        // Closed first: the band that replaces Add cover has a picker of its own.
        setPicking(false);
        onChange(page.cover, page);
        return page;
    };
    const remove = async () => {
        setRemoving(true);
        try {
            const { previous } = await api<{ previous: string | null }>(coverPath(spaceId, pageId), 'DELETE');
            onChange(null);
            toast('Cover removed', {
                ...(previous && {
                    action: {
                        label: 'Undo',
                        onClick: () => {
                            set({ embedId: previous }).catch((error: unknown) =>
                                toast.error(failure(error, 'Could not put the cover back.')),
                            );
                        },
                    },
                }),
            });
        } catch (error) {
            toast.error(failure(error, 'Could not remove the cover.'));
        } finally {
            setRemoving(false);
        }
    };
    // Under Add cover from its start; under Change cover (at the band's right) from its end.
    const picker = (trigger: ReactNode, align: 'start' | 'end' = 'start') => (
        <Popover open={picking} onOpenChange={setPicking}>
            <PopoverTrigger asChild>{trigger}</PopoverTrigger>
            <PopoverContent
                align={align}
                sideOffset={6}
                collisionPadding={12}
                className="w-[min(21.5rem,calc(100vw-1.5rem))] rounded-xl p-3.5"
                aria-label="Cover"
            >
                <CoverPicker
                    spaceId={spaceId}
                    onPick={async (choice) => {
                        await set(choice);
                    }}
                />
            </PopoverContent>
        </Popover>
    );
    if (!cover || (broken === cover.id && !editable)) {
        if (!editable) {
            return null;
        }
        return (
            <div data-slot="page-cover-add" className="-mt-3 mb-3 flex h-8 items-center max-[700px]:-mt-1">
                {picker(
                    <Button
                        variant="ghost"
                        size="sm"
                        className={cn('-ml-2.5 font-normal text-muted-foreground hover:text-foreground', revealed)}
                    >
                        <ImagePlus /> Add cover
                    </Button>,
                )}
            </div>
        );
    }
    const gone = broken === cover.id;
    return (
        <div
            data-slot="page-cover"
            className="relative mb-7 h-50 w-full overflow-hidden rounded-xl bg-muted max-[700px]:mb-6"
        >
            {gone ? (
                <div className="flex size-full flex-col items-center justify-center gap-2 text-[13px] text-muted-foreground">
                    <ImageOff className="size-5" aria-hidden />
                    This cover’s image is no longer available.
                </div>
            ) : (
                <img
                    src={cover.url}
                    alt=""
                    // Decorative: the title below says what the page is.
                    className="size-full object-cover object-center"
                    onError={() => setBroken(cover.id)}
                />
            )}
            {editable && (
                <div className="absolute right-3 bottom-3 flex gap-2">
                    {picker(
                        <Button size="sm" className={cn(overImage, revealed)}>
                            <ImageUp /> Change cover
                        </Button>,
                        'end',
                    )}
                    <Button
                        size="sm"
                        className={cn(overImage, revealed)}
                        disabled={removing}
                        onClick={() => void remove()}
                    >
                        {removing ? <LoaderCircle className="animate-spin motion-reduce:animate-none" /> : <Trash2 />}
                        Remove
                    </Button>
                </div>
            )}
        </div>
    );
}

/**
 * A button over the cover's image: dark glass whatever the theme, so it
 * reads on a light or a dark picture alike.
 */
const overImage =
    'border border-white/15 bg-black/60 font-normal text-white shadow-sm backdrop-blur-sm hover:bg-black/75 active:bg-black/75 focus-visible:ring-white/60';

/**
 * The cover picker's two sources: an upload (or a drop) into the person's
 * Files, and the images already in the Space.
 */
export function CoverPicker({ spaceId, onPick }: { spaceId: string; onPick: (choice: CoverChoice) => Promise<void> }) {
    const input = useRef<HTMLInputElement>(null);
    const hint = useId();
    const [images, setImages] = useState<CoverImage[]>();
    const [listError, setListError] = useState('');
    const [busy, setBusy] = useState<{ label: string; progress?: number }>();
    const [error, setError] = useState('');
    const [dragging, setDragging] = useState(false);
    useEffect(() => {
        const controller = new AbortController();
        api<CoverImage[]>(
            `/spaces/${encodeURIComponent(spaceId)}/cover-images`,
            'GET',
            undefined,
            controller.signal,
        ).then(setImages, (e: unknown) => {
            if (!controller.signal.aborted) {
                setListError(failure(e, 'Could not load this Space’s images.'));
            }
        });
        return () => controller.abort();
    }, [spaceId]);
    const pick = async (choice: CoverChoice) => {
        setBusy({ label: 'Setting the cover…' });
        try {
            await onPick(choice);
        } finally {
            setBusy(undefined);
        }
    };
    const upload = async (file: File | undefined) => {
        if (!file || busy) {
            return;
        }
        const problem = coverFileProblem(file);
        if (problem) {
            setError(problem);
            return;
        }
        setError('');
        setBusy({ label: 'Uploading…', progress: 0 });
        try {
            // Into the person's Files, like any upload there; then the cover.
            const { item } = await uploadToFolder(file, '', {
                onProgress: (progress) => setBusy({ label: 'Uploading…', progress }),
            });
            await pick({ fileId: item.id });
        } catch (e) {
            setError(failure(e, 'Could not upload the image.'));
            setBusy(undefined);
        }
    };
    const choose = async (image: CoverImage) => {
        setError('');
        try {
            await pick({ embedId: image.id });
        } catch (e) {
            setError(failure(e, 'Could not set the cover.'));
        }
    };
    const drop = (event: DragEvent) => {
        event.preventDefault();
        setDragging(false);
        void upload(event.dataTransfer.files[0]);
    };
    return (
        <div data-slot="cover-picker" className="grid gap-3 text-sm" aria-busy={!!busy}>
            <h2 className="m-0 text-[13px] font-medium text-muted-foreground">Cover</h2>
            <button
                type="button"
                data-slot="cover-upload"
                aria-describedby={hint}
                disabled={!!busy}
                className={cn(
                    'flex min-h-28 flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed border-border px-4 py-4 text-center outline-none transition-colors hover:bg-accent/60 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-70 motion-reduce:transition-none',
                    dragging && 'border-ring bg-accent/60',
                )}
                onClick={() => input.current?.click()}
                onDragEnter={(event) => {
                    event.preventDefault();
                    setDragging(true);
                }}
                onDragOver={(event) => event.preventDefault()}
                onDragLeave={() => setDragging(false)}
                onDrop={drop}
            >
                {busy ? (
                    <LoaderCircle className="size-4.5 animate-spin text-muted-foreground motion-reduce:animate-none" />
                ) : (
                    <ImageUp className="size-4.5 text-muted-foreground" aria-hidden />
                )}
                <span className="font-medium text-foreground">
                    {busy
                        ? `${busy.label}${busy.progress !== undefined ? ` ${Math.round(busy.progress * 100)}%` : ''}`
                        : 'Upload an image'}
                </span>
                <span id={hint} className="text-xs/5 text-muted-foreground">
                    or drop one here · PNG, JPEG or WebP, up to {COVER_MAX_BYTES / MB} MB
                </span>
            </button>
            <input
                ref={input}
                type="file"
                data-slot="cover-file"
                accept={COVER_UPLOAD_TYPES.join(',')}
                className="sr-only"
                tabIndex={-1}
                aria-hidden
                onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = '';
                    void upload(file);
                }}
            />
            {error && (
                <p role="alert" className="m-0 text-xs/5 text-destructive">
                    {error}
                </p>
            )}
            <section aria-label="From this Space" className="grid gap-2">
                <h3 className="m-0 text-[13px] font-medium text-muted-foreground">From this Space</h3>
                {listError ? (
                    <p className="m-0 text-xs/5 text-destructive">{listError}</p>
                ) : !images ? (
                    <p className="m-0 text-xs/5 text-muted-foreground">Loading images…</p>
                ) : images.length ? (
                    <ul className="m-0 grid max-h-40 list-none grid-cols-4 gap-1.5 overflow-y-auto p-0.5">
                        {images.map((image) => (
                            <li key={image.id}>
                                <button
                                    type="button"
                                    data-slot="cover-image"
                                    aria-label={`Use ${image.name}`}
                                    title={image.name}
                                    disabled={!!busy}
                                    className="block aspect-[4/3] w-full overflow-hidden rounded-md bg-muted outline-none ring-offset-2 ring-offset-popover hover:ring-2 hover:ring-border focus-visible:ring-[3px] focus-visible:ring-ring disabled:opacity-60"
                                    onClick={() => void choose(image)}
                                >
                                    <img src={image.url} alt="" loading="lazy" className="size-full object-cover" />
                                </button>
                            </li>
                        ))}
                    </ul>
                ) : (
                    <p className="m-0 text-xs/5 text-muted-foreground">
                        No images in this Space yet. Link-card images and other pages’ covers show here.
                    </p>
                )}
            </section>
            <p className="m-0 text-xs/5 text-muted-foreground">
                Wide images work best (about 3:1). Everyone who can see the page sees its cover.
            </p>
        </div>
    );
}

import { Image } from 'expo-image';
import { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';

import type { ViewSpec } from '@socio/shared/dataset-view';
import type { EmbedCard } from '@socio/shared/embed-card';

import { useBoundedState, useWorkspaceScope } from '../live';
import { useEmbedPicture } from '../platform/image-cache';
import {
    cellText,
    type PagePicture,
    type PageTable,
    PICTURE_LABEL,
    VIEW_EMPTY,
    VIEW_OPEN_TO_LOAD,
    VIEW_ROWS_SHOWN,
    viewChart,
    viewRowsNote,
    viewUpdated,
} from '../shell/page-reader';
import { createViewAsk, datasetViewKey, type DatasetViewResult } from '../sync/dataset-views';
import { AppSymbol, Text } from '../ui';

import { MarkdownBlock, ReplyChart } from './chat-markdown';

// A page's fenced blocks as the reader draws them, each
// from the phone's own copies, so nothing a page names is fetched from
// elsewhere: a dataset view's last result with its time (asked once as the page
// opens, no timer), a link card's saved snapshot and a picture, both through
// the image cache by their media embed's id. A table is drawn here too, full
// width as the web's.

/** A picture (a page's ```image fence): its embed through the image cache, at its own shape. */
export function PagePictureBlock({ picture }: { picture: PagePicture }) {
    const shown = useEmbedPicture(picture.id);
    const ratio = picture.width && picture.height ? picture.width / picture.height : 4 / 3;
    const label = picture.alt ?? PICTURE_LABEL;
    return (
        <View
            accessible
            accessibilityRole="image"
            accessibilityLabel={label}
            testID="page-picture"
            className="w-full overflow-hidden rounded-xl bg-muted"
            style={{ aspectRatio: ratio }}
        >
            {shown.state === 'ready' ? (
                <Image source={{ uri: shown.uri }} cachePolicy="memory" contentFit="cover" style={{ flex: 1 }} />
            ) : (
                <View className="flex-1 items-center justify-center gap-1 p-4">
                    <AppSymbol name="image" color="muted-foreground" />
                    {shown.state === 'loading' ? null : (
                        <Text variant="footnote" tone="muted">
                            {picture.alt ? `${label} isn’t available here` : 'Picture not available here'}
                        </Text>
                    )}
                </View>
            )}
        </View>
    );
}

const hostOf = (url: string) => {
    try {
        return new URL(url).hostname.replace(/^www\./, '');
    } catch {
        return url;
    }
};

/** A link card: the snapshot `/unfurl` saved, its first image from the image cache; a tap opens the link by the chat replies' rules. */
export function EmbedCardBlock({ card, onOpen }: { card: EmbedCard; onOpen: (url: string) => void }) {
    const media = card.media?.find((item) => item.id !== undefined);
    const source = card.provider ?? hostOf(card.url);
    const byline = [card.author, card.handle].filter(Boolean).join(' ');
    const title = card.title ?? card.url;
    return (
        <Pressable
            testID="page-embed"
            accessibilityRole="link"
            accessibilityLabel={[title, source, byline].filter(Boolean).join(', ')}
            accessibilityHint="Opens the link"
            onPress={() => onOpen(card.url)}
            className="overflow-hidden rounded-xl border border-border bg-card active:bg-accent"
        >
            {media?.id === undefined ? null : <CardMedia id={media.id} alt={media.alt} />}
            <View className="gap-1 p-3">
                <View className="flex-row items-center gap-2">
                    <Text variant="footnote" tone="muted" numberOfLines={1} className="min-w-0 flex-1">
                        {source}
                    </Text>
                    <AppSymbol name="external-link" size={14} color="muted-foreground" />
                </View>
                <Text weight="medium" numberOfLines={3}>
                    {title}
                </Text>
                {byline === '' ? null : (
                    <Text variant="footnote" tone="muted" numberOfLines={1}>
                        {byline}
                    </Text>
                )}
                {card.text === undefined ? null : (
                    <Text variant="subheadline" tone="muted" numberOfLines={6}>
                        {card.text}
                    </Text>
                )}
            </View>
        </Pressable>
    );
}

function CardMedia({ id, alt }: { id: string; alt?: string }) {
    const shown = useEmbedPicture(id);
    return shown.state === 'ready' ? (
        <Image
            source={{ uri: shown.uri }}
            cachePolicy="memory"
            contentFit="cover"
            accessibilityLabel={alt}
            style={{ width: '100%', aspectRatio: 16 / 9 }}
        />
    ) : null;
}

/** What a view shows: its kept result, a wait, or why there is none. */
type ViewLoad = 'loading' | 'failed' | { readonly denied: string } | 'done';

/**
 * A dataset view: its last result from the phone, asked again once as the page
 * opens; offline, the kept one with its time, else "Open the page online…". A
 * denial deletes the kept one and says the server's words.
 */
export function DatasetViewBlock({ spaceId, pageId, spec }: { spaceId: string; pageId: string; spec: ViewSpec }) {
    const { pages } = useWorkspaceScope();
    // Followed by its key, not by the item: a denial drops the kept copy, so
    // `item()` would hand out a new one on the next render, and an effect on
    // the item would ask again, and again. The asks are this mount's: once a
    // view, whatever re-renders.
    const key = datasetViewKey(spaceId, pageId, spec);
    const item = useMemo(() => pages.views.itemAt(key), [pages, key]);
    const ask = useMemo(() => createViewAsk(pages.views), [pages]);
    const state = useBoundedState(item);
    const [load, setLoad] = useState<ViewLoad>('loading');
    useEffect(() => {
        const release = item.use();
        let live = true;
        setLoad('loading');
        ask(spaceId, pageId, spec)
            .then((outcome) => {
                if (live) {
                    setLoad(
                        outcome.outcome === 'denied'
                            ? { denied: outcome.message }
                            : outcome.outcome === 'fresh'
                              ? 'done'
                              : 'failed',
                    );
                }
            })
            .catch(() => live && setLoad('failed'));
        return () => {
            live = false;
            release();
        };
    }, [ask, item, spaceId, pageId, spec]);
    const result = typeof load === 'object' ? null : state.value;
    const title = spec.title || 'Dataset view';
    return (
        <View testID="page-dataset-view" className="gap-2 rounded-xl border border-border bg-card p-3">
            <View className="flex-row items-center gap-2">
                <AppSymbol name="table" color="muted-foreground" />
                <Text weight="medium" numberOfLines={1} className="min-w-0 flex-1">
                    {title}
                </Text>
            </View>
            {typeof load === 'object' ? (
                <Text variant="subheadline" tone="muted">
                    {load.denied}
                </Text>
            ) : result === null ? (
                <Text variant="subheadline" tone="muted">
                    {load === 'loading' ? 'Loading…' : VIEW_OPEN_TO_LOAD}
                </Text>
            ) : (
                <ViewResult result={result} spec={spec} />
            )}
            {result === null ? null : (
                <Text variant="footnote" tone="muted" testID="page-dataset-view-updated">
                    {viewUpdated(result)}
                </Text>
            )}
        </View>
    );
}

function ViewResult({ result, spec }: { result: DatasetViewResult; spec: ViewSpec }) {
    if (result.rows.length === 0) {
        return (
            <Text variant="subheadline" tone="muted">
                {VIEW_EMPTY}
            </Text>
        );
    }
    if (spec.display !== 'table') {
        const chart = viewChart(result, spec, result.dataset?.name ?? '');
        return typeof chart === 'string' ? (
            <Text variant="subheadline" tone="muted">
                {chart}
            </Text>
        ) : (
            <ReplyChart chart={chart} />
        );
    }
    const note = viewRowsNote(result);
    const numeric = result.columns.map(
        (_, index) =>
            result.rows.some((row) => typeof row[index] === 'number') &&
            result.rows.every((row) => row[index] === null || typeof row[index] === 'number'),
    );
    return (
        <View className="gap-2">
            <ScrollView horizontal accessibilityLabel={spec.title || 'Dataset view'}>
                <View>
                    <View className="flex-row border-b border-border">
                        {result.columns.map((column, index) => (
                            <Cell key={`${column}-${index}`} text={column} header numeric={numeric[index] === true} />
                        ))}
                    </View>
                    {result.rows.slice(0, VIEW_ROWS_SHOWN).map((row, rowIndex) => (
                        <View key={rowIndex} className="flex-row border-b border-border">
                            {row.map((value, index) => (
                                <Cell key={index} text={cellText(value)} numeric={numeric[index] === true} />
                            ))}
                        </View>
                    ))}
                </View>
            </ScrollView>
            {note === null ? null : (
                <Text variant="footnote" tone="muted">
                    {note}
                </Text>
            )}
        </View>
    );
}

function Cell({ text, header = false, numeric }: { text: string; header?: boolean; numeric: boolean }) {
    return (
        <View className="w-32 px-2 py-1.5">
            <Text
                variant="footnote"
                weight={header ? 'medium' : undefined}
                numberOfLines={2}
                className={numeric ? 'text-right' : undefined}
            >
                {text}
            </Text>
        </View>
    );
}

/** The narrowest a page table's column gets (editor.css's `min-width: 60px`); past that the table scrolls sideways. */
export const TABLE_MIN_COLUMN = 60;

/**
 * A page's table as editor.css draws it: the page's full width in equal
 * columns (`width: 100%; table-layout: fixed`), each cell bordered with
 * 9 × 12 padding, the header row semibold and centered (the browser's `th`) on the
 * block tone unless the delimiter row aligns it; cells keep their
 * Markdown (links, code, bold). Wider than the screen at 60 per column, it
 * scrolls sideways.
 */
export function PageTableBlock({ table, onLink }: { table: PageTable; onLink: (url: string) => void }) {
    const columns = table.header.length;
    const row = (cells: readonly string[], header: boolean, key: string) => (
        <View key={key} className={header ? 'flex-row bg-muted' : 'flex-row'}>
            {cells.map((cell, column) => (
                <View
                    key={column}
                    className="border-border px-3 py-2"
                    style={{
                        // A share of the table, not flex: a cell's text would move its column's edge row by row.
                        width: `${100 / columns}%`,
                        minWidth: TABLE_MIN_COLUMN,
                        borderRightWidth: column === columns - 1 ? 0 : 1,
                        borderTopWidth: key === 'h' ? 0 : 1,
                    }}
                >
                    {cell === '' ? null : (
                        <MarkdownBlock
                            markdown={cell}
                            onLink={onLink}
                            prose="page"
                            cell={header ? 'header' : 'body'}
                            align={table.align[column] ?? (header ? 'center' : null)}
                        />
                    )}
                </View>
            ))}
        </View>
    );
    return (
        <ScrollView
            horizontal
            testID="page-table"
            className="my-2"
            contentContainerStyle={{ flexGrow: 1 }}
            showsHorizontalScrollIndicator={false}
        >
            <View className="flex-1 border border-border" style={{ minWidth: columns * TABLE_MIN_COLUMN }}>
                {row(table.header, true, 'h')}
                {table.rows.map((cells, index) => row(cells, false, `r${index}`))}
            </View>
        </ScrollView>
    );
}

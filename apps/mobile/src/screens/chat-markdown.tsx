import { useMemo } from 'react';
import { Platform, StyleSheet, useWindowDimensions, View } from 'react-native';
import { EnrichedMarkdownText, type MarkdownImageBlock, type MarkdownStyle } from 'react-native-enriched-markdown';
import Svg, { Circle, Line, Path, Text as SvgText } from 'react-native-svg';

import type { InlineChartData } from '@socio/shared/inline-chart';
import { ISSUE_STATUSES } from '@socio/shared/issues/issue-types';

import { type BubbleSurface, bubbleStyle } from '../chat/bubble-style';
import { chartLayout, chartNote, chartSummary } from '../chat/chart';
import { IMAGE_LABEL, type ReplyPart, replyParts } from '../chat/markdown';
import {
    hasIssueLink,
    type IssueCardPart,
    issueCardGroups,
    issueCardParts,
    issueLinkPattern,
    statusLinkPattern,
    tappedLink,
    withIssueStatuses,
} from '../chat/markdown-links';
import { useCollections, useLiveQuery, useSyncOnFocus, useWorkspaceScope } from '../live';
import { STATUS_TONE } from '../shell/board';
import { issuesQuery } from '../shell/queries';
import { ISSUES } from '../sync/issues';
import { useScheme } from '../theme/scheme';
import { type Colors, colorsOf, theme } from '../theme/theme';
import { Text } from '../ui';
import {
    floored,
    fontWeight,
    headingFamily,
    monoFamily,
    type ProseHeading,
    type ProseKind,
    proseOf,
} from '../ui/type-scale';

import { IssueCardStack } from './issue-card';
import { useOpenLink } from './open-link';

// A socio's reply in Markdown: enriched-markdown's
// native renderer (GFM), styled from theme.json, over text markdown.ts has
// made safe (no image, no `<video>`), with `socio-chart` fences drawn between
// as react-native-svg charts. Belt and braces for the "nothing fetches" rule:
// an image that still reached the renderer gets an empty source (no request)
// and shows as its alt text, a video block shows nothing, the iOS link
// preview (which loads the page) is off, and math is off. Taps go through
// useOpenLink; links to the workspace's issues are chips in running text and,
// in a chat's reply (`issueCards`), cards where they stand alone
// (issue-card.tsx). A reply isn't
// selectable text: a long-press is its menu, with Copy (chat.tsx).

export function ReplyMarkdown({
    text,
    testID,
    prose,
    issueCards = false,
}: {
    text: string;
    testID?: string;
    prose?: ProseKind;
    /** A socio's reply in a chat: a paragraph or list item of issue links only is a stack of issue cards (the web's). */
    issueCards?: boolean;
}) {
    const { workspace } = useWorkspaceScope();
    const parts = useMemo(
        () =>
            replyParts(text).flatMap((part): (ReplyPart | IssueCardPart)[] =>
                part.kind === 'markdown' && issueCards
                    ? issueCardParts(part.text, workspace.origin).map((piece) => ({
                          ...piece,
                          key: `${part.key}${piece.key}`,
                      }))
                    : [part],
            ),
        [text, issueCards, workspace.origin],
    );
    const proseProp = prose === undefined ? {} : { prose };
    return (
        <View testID={testID} className="gap-2">
            {parts.map((part) =>
                part.kind === 'chart' ? (
                    <ReplyChart key={part.key} chart={part.chart} />
                ) : part.kind === 'issues' ? (
                    <View
                        key={part.key}
                        className="gap-2"
                        {...(testID === undefined ? {} : { testID: `${testID}-${part.key}` })}
                    >
                        {issueCardGroups(part.links).map((group) => {
                            const stack = (
                                <IssueCardStack
                                    links={group.links}
                                    chip={(source) => <MarkdownBlock markdown={source} {...proseProp} />}
                                />
                            );
                            // A mixed list's item keeps its marker, the cards indented under it (the web's `li`).
                            return group.marker === null ? (
                                <View key={group.key}>{stack}</View>
                            ) : (
                                <View key={group.key} className="flex-row" testID={`issue-cards-item-${group.key}`}>
                                    <View
                                        style={{ width: LIST_INDENT }}
                                        accessibilityElementsHidden
                                        importantForAccessibility="no"
                                    >
                                        {group.marker === '•' ? (
                                            // The list's own disc: 6 pt in the bullet's color, beside the card's title.
                                            <View className="mt-4 size-1.5 rounded-full bg-muted-foreground" />
                                        ) : (
                                            <Text variant="subheadline" tone="muted" className="pt-2">
                                                {group.marker}
                                            </Text>
                                        )}
                                    </View>
                                    <View className="min-w-0 flex-1">{stack}</View>
                                </View>
                            );
                        })}
                    </View>
                ) : issueCards && hasIssueLink(part.text, workspace.origin) ? (
                    <StatusedMarkdown key={part.key} markdown={part.text} {...proseProp} />
                ) : (
                    <MarkdownBlock key={part.key} markdown={part.text} {...proseProp} />
                ),
            )}
        </View>
    );
}

/** The web's list indent (`pl-4.5`), where a mixed list's marker sits beside its cards. */
const LIST_INDENT = 18;

/**
 * Reply Markdown whose issue chips have their status beside them, as the web's
 * "CB-3 [Ready]" (`withIssueStatuses`), from the phone's issues kind. Only a
 * reply's part that links an issue reads it, so a long transcript holds few queries.
 */
function StatusedMarkdown({ markdown, prose }: { markdown: string; prose?: ProseKind }) {
    const { workspace } = useWorkspaceScope();
    const collections = useCollections();
    useSyncOnFocus(ISSUES_SYNCED);
    const { data: issues } = useLiveQuery({ query: issuesQuery(collections) });
    const shown = useMemo(() => {
        const byNumber = new Map(issues.map((issue) => [issue.number, issue.status]));
        return withIssueStatuses(markdown, workspace.origin, (number) => byNumber.get(number));
    }, [issues, markdown, workspace.origin]);
    return <MarkdownBlock markdown={shown} {...(prose === undefined ? {} : { prose })} />;
}

const ISSUES_SYNCED = [ISSUES];

const NO_IMAGE = () => ({ uri: '' });
const NO_VIDEO = () => <View />;
const MD4C = { latexMath: false, admonitions: true } as const;

/**
 * Markdown already made safe (markdown.ts), in the chat reply's style with the platform's prose
 * (type-scale.ts's `proseOf`: iOS's text styles, Material's on Android): a chat's by default, an issue's or a page's where
 * those show it. Taps go through useOpenLink unless `onLink` takes them (a
 * page's links to pages).
 */
export function MarkdownBlock({
    markdown,
    onLink,
    prose = 'chat',
    cell,
    align,
    surface,
    selectable = false,
}: {
    markdown: string;
    onLink?: (url: string) => void;
    prose?: ProseKind;
    /** A person's message (CB-415): in their bubble's colors, its links plain (the web's `onBubble`). */
    surface?: BubbleSurface;
    /** A pending bubble's words stay selectable, as its text was. */
    selectable?: boolean;
    /** A table's cell (page-blocks.tsx's PageTableBlock): no space under its paragraphs, a header's in semibold. */
    cell?: 'header' | 'body';
    /** A cell's column alignment, from the table's delimiter row. */
    align?: 'left' | 'center' | 'right' | null;
}) {
    const scheme = useScheme();
    const { fontScale } = useWindowDimensions();
    const { workspace } = useWorkspaceScope();
    const openLink = useOpenLink();
    const markdownStyle = useMemo(
        () =>
            bubbleStyle(
                cellStyle(
                    replyStyle(
                        colorsOf(scheme),
                        theme[scheme].tones,
                        scheme === 'dark',
                        fontScale,
                        workspace.origin,
                        prose,
                    ),
                    cell,
                    align,
                ),
                colorsOf(scheme),
                surface,
            ),
        [scheme, fontScale, workspace.origin, prose, cell, align, surface],
    );
    return (
        <EnrichedMarkdownText
            markdown={markdown}
            markdownStyle={markdownStyle}
            flavor="github"
            selectable={selectable}
            md4cFlags={MD4C}
            enableLinkPreview={false}
            resolveImageSource={NO_IMAGE}
            renderers={{ image: ImageAlt, video: NO_VIDEO }}
            onLinkPress={({ url }) => {
                // A status chip beside an issue link opens its issue, as the web's badge is in the link (CB-414).
                const href = tappedLink(url);
                if (href === null) {
                    return;
                }
                if (onLink === undefined) {
                    // A page of the workspace opens its screen in the app when it has one (CB-413).
                    openLink(href, { app: true });
                } else {
                    onLink(href);
                }
            }}
            containerStyle={{ flexShrink: 1, minWidth: 0 }}
        />
    );
}

function ImageAlt(block: MarkdownImageBlock) {
    return (
        <Text variant="subheadline" tone="muted">
            {block.altText.trim() || IMAGE_LABEL}
        </Text>
    );
}

/** A table cell's paragraphs, as editor.css's `td p, th p { margin: 0 }` and `th { font-weight: 600 }`. */
function cellStyle(
    style: MarkdownStyle,
    cell: 'header' | 'body' | undefined,
    align: 'left' | 'center' | 'right' | null | undefined,
): MarkdownStyle {
    if (cell === undefined) {
        return style;
    }
    const headingFace = headingFamily(Platform.OS);
    return {
        ...style,
        paragraph: {
            ...style.paragraph,
            marginBottom: 0,
            ...(align === null || align === undefined ? {} : { textAlign: align }),
            ...(cell === 'header'
                ? {
                      fontWeight: fontWeight('semibold'),
                      ...(headingFace === undefined ? {} : { fontFamily: headingFace }),
                  }
                : {}),
        },
    };
}

type Tones = (typeof theme)['light']['tones'];

function replyStyle(
    colors: Colors,
    tones: Tones,
    dark: boolean,
    fontScale: number,
    origin: string,
    kind: ProseKind,
): MarkdownStyle {
    const monospace = monoFamily(Platform.OS);
    // Android's headings ignore fontWeight in the fork: a family with the weight in it (headingFamily).
    const headingFace = headingFamily(Platform.OS);
    const prose = proseOf(kind, Platform.OS);
    const { fontSize, lineHeight } = floored(prose, fontScale);
    const body = { color: colors.foreground, fontSize, lineHeight, marginTop: 0, marginBottom: prose.paragraphGap };
    // A list, a code block: the list's own line height.
    const blockLine = floored({ fontSize: prose.fontSize, lineHeight: prose.listLineHeight }, fontScale).lineHeight;
    const block = {
        marginTop: 4,
        marginBottom: 12,
        borderRadius: 8,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: colors.border,
    };
    const heading = (style: ProseHeading) => ({
        ...body,
        ...floored(style, fontScale),
        fontWeight: fontWeight(style.weight),
        ...(headingFace === undefined ? {} : { fontFamily: headingFace }),
        marginTop: style.marginTop,
        marginBottom: style.marginBottom,
    });
    // h4 to h6 as the body's size in the heading's weight, under h3.
    const minor = heading({ ...prose.h3, fontSize: prose.fontSize, lineHeight: prose.lineHeight });
    return {
        paragraph: body,
        h1: heading(prose.h1),
        h2: heading(prose.h2),
        h3: heading(prose.h3),
        h4: minor,
        h5: minor,
        h6: minor,
        strong: { color: colors.foreground },
        link: { color: colors['chat-link'], underline: true },
        linkVariants: {
            [issueLinkPattern(origin)]: {
                color: colors['secondary-foreground'],
                backgroundColor: colors.secondary,
                underline: false,
                pill: { borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2, borderWidth: 0 },
            },
            // The web's StatusBadge beside an inline issue link: its status's tone, a hairline of it around.
            ...Object.fromEntries(
                ISSUE_STATUSES.map((status) => {
                    const tone = status === 'wont_fix' ? null : tones[STATUS_TONE[status]];
                    return [
                        statusLinkPattern(status),
                        {
                            color: tone?.foreground ?? colors['muted-foreground'],
                            backgroundColor: tone?.tint ?? colors.muted,
                            underline: false,
                            pill: {
                                borderRadius: 6,
                                paddingHorizontal: 6,
                                paddingVertical: 1,
                                borderWidth: 1,
                                borderColor: tone === null ? colors.border : `${tone.foreground}4d`,
                            },
                        },
                    ];
                }),
            ),
        },
        code: {
            fontFamily: monospace,
            color: colors.foreground,
            backgroundColor: colors.muted,
            borderColor: 'transparent',
            fontSize: fontSize * 0.9,
        },
        codeBlock: {
            ...body,
            ...block,
            color: colors.foreground,
            backgroundColor: colors.muted,
            fontFamily: monospace,
            fontSize: fontSize * 0.9,
            lineHeight: blockLine * 0.9,
            padding: 12,
            syntaxColors: dark
                ? {
                      keyword: '#ff7b72',
                      string: '#a5d6ff',
                      number: '#79c0ff',
                      constant: '#79c0ff',
                      comment: '#8b949e',
                      function: '#d2a8ff',
                      type: '#ffa657',
                      property: '#79c0ff',
                      tag: '#7ee787',
                      attribute: '#79c0ff',
                  }
                : {
                      keyword: '#cf222e',
                      string: '#0a3069',
                      number: '#0550ae',
                      constant: '#0550ae',
                      comment: '#6e7781',
                      function: '#8250df',
                      type: '#953800',
                      property: '#0550ae',
                      tag: '#116329',
                      attribute: '#0550ae',
                  },
        },
        blockquote: {
            ...body,
            color: colors['muted-foreground'],
            backgroundColor: 'transparent',
            borderColor: colors.border,
            borderWidth: 2,
            gapWidth: 12,
        },
        list: {
            ...body,
            lineHeight: blockLine,
            bulletColor: colors['muted-foreground'],
            markerColor: colors['muted-foreground'],
            gapWidth: 12 * fontScale,
            itemSpacing: prose.listItemGap,
        },
        thematicBreak: { color: colors.border, height: 1, marginTop: 8, marginBottom: 8 },
        table: {
            ...body,
            ...block,
            headerTextColor: colors.foreground,
            headerBackgroundColor: colors.muted,
            rowEvenBackgroundColor: 'transparent',
            rowOddBackgroundColor: 'transparent',
            cellPaddingHorizontal: 10,
            cellPaddingVertical: 6,
        },
        taskList: {
            checkedColor: colors.primary,
            checkedTextColor: colors.foreground,
            borderColor: colors['muted-foreground'],
            checkedStrikethrough: false,
        },
    };
}

/** A `socio-chart` fence: the web's InlineChart, drawn with react-native-svg (a page's dataset view's chart too). */
export function ReplyChart({ chart }: { chart: InlineChartData }) {
    const colors = colorsOf(useScheme());
    const { width: screen } = useWindowDimensions();
    // The transcript's 16 pt padding each side, then the card's 12.
    const width = Math.max(120, screen - 32 - 24);
    const layout = chartLayout(chart, width);
    return (
        <View testID="chat-chart" className="gap-1 rounded-lg border border-border bg-card p-3">
            <Text weight="medium">{chart.title}</Text>
            <Text variant="subheadline" tone="muted">
                {chart.description}
            </Text>
            <View accessible accessibilityRole="image" accessibilityLabel={chartSummary(chart)}>
                <Svg width={width} height={layout.height}>
                    {layout.ticks.map((tick) => (
                        <Line
                            key={`g${tick.label}`}
                            x1={layout.gridX[0]}
                            x2={layout.gridX[1]}
                            y1={tick.y}
                            y2={tick.y}
                            stroke={colors.border}
                            strokeWidth={1}
                        />
                    ))}
                    {layout.ticks.map((tick) => (
                        <SvgText
                            key={`t${tick.label}`}
                            x={layout.tickX}
                            y={tick.y + 4}
                            textAnchor="end"
                            fontSize={11}
                            fill={colors['muted-foreground']}
                        >
                            {tick.label}
                        </SvgText>
                    ))}
                    {layout.labels.map((label) => (
                        <SvgText
                            key={`x${label.x}`}
                            x={label.x}
                            y={layout.labelY}
                            textAnchor={label.anchor}
                            fontSize={11}
                            fill={colors['muted-foreground']}
                        >
                            {label.text}
                        </SvgText>
                    ))}
                    {layout.bars.map((d) => (
                        <Path key={d} d={d} fill={colors['chart-1']} />
                    ))}
                    {layout.line === '' ? null : (
                        <Path
                            d={layout.line}
                            fill="none"
                            stroke={colors['chart-1']}
                            strokeWidth={2}
                            strokeLinejoin="round"
                            strokeLinecap="round"
                        />
                    )}
                    {layout.dots.map((dot) => (
                        <Circle
                            key={`d${dot.x}`}
                            cx={dot.x}
                            cy={dot.y}
                            r={4}
                            fill={colors['chart-1']}
                            stroke={colors.card}
                            strokeWidth={2}
                        />
                    ))}
                    {layout.baseline === null ? null : (
                        <Line
                            x1={layout.gridX[0]}
                            x2={layout.gridX[1]}
                            y1={layout.baseline}
                            y2={layout.baseline}
                            stroke={colors['muted-foreground']}
                            strokeWidth={1}
                        />
                    )}
                </Svg>
            </View>
            <Text variant="footnote" tone="muted">
                {chartNote(chart)}
            </Text>
        </View>
    );
}

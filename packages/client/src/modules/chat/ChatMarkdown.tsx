import { createContext, memo, useContext, useMemo } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { completeInlineChartFence, INLINE_CHARTS_PER_MESSAGE, parseInlineChart } from '@socio/shared/inline-chart';

import { InlineChart } from '../../components/charts/InlineChart';
import { AppLink } from '../../shell/AppLink';
import { IssueCards, IssueCardStack, issueLinksOnly, ReplyLink } from '../issues/IssueLinkCard';

import { cn } from '@/lib/utils';

// Shared by bubbles and reasoning: GFM so a Dot's tables, task lists and
// strikethrough render, and a scroll wrapper so a wide table scrolls inside
// the bubble instead of widening the chat column. On the person's teal
// bubble a table takes the bubble's colors.
const remarkPlugins = [remarkGfm];
const tableComponents = (onBubble: boolean): Components => {
    const line = onBubble ? 'border-[#ffffff40]' : 'border-[#e3e5ee] dark:border-[#333438]';
    const cell = cn(
        'border-b px-2.5 py-1.5 text-left align-top [&+&]:border-l [tbody_tr:last-child>&]:border-b-0',
        line,
    );
    return {
        table: ({ children }) => (
            <div className={cn('mb-3 max-w-full overflow-x-auto rounded-[8px] border last:mb-0', line)} data-chat-table>
                <table className="min-w-full border-collapse leading-[1.5] tabular-nums [overflow-wrap:normal]">
                    {children}
                </table>
            </div>
        ),
        th: ({ children, style }) => (
            <th
                style={style}
                className={cn(
                    cell,
                    'font-semibold whitespace-nowrap',
                    onBubble
                        ? 'bg-transparent text-inherit'
                        : 'bg-[#f6f6f8] text-[#4a4f5e] dark:bg-[#242424] dark:text-[#bec4d6]',
                )}
            >
                {children}
            </th>
        ),
        td: ({ children, style }) => (
            <td style={style} className={cell}>
                {children}
            </td>
        ),
    };
};
const markdownComponents: Components = {
    img: ({ alt }) => <span>{alt}</span>,
    a: ({ href, children }) => <AppLink href={href}>{children}</AppLink>,
    ...tableComponents(false),
};
const bubbleComponents: Components = {
    ...markdownComponents,
    ...tableComponents(true),
};
/**
 * A Dot's reply also shows links to this app's issues as cards (CB-87); a
 * paragraph or list of nothing but such links is a stack of them. A link
 * in running text stays inline, with the issue's status (CB-104).
 */
const ChartSource = createContext({ source: '', starts: new Set<number>() });
const ReplyCodeBlock: NonNullable<Components['pre']> = ({ node, children }) => {
    const { source, starts } = useContext(ChartSource);
    const code = node?.children[0];
    const start = node?.position?.start.offset;
    const end = node?.position?.end.offset;
    if (
        code?.type === 'element' &&
        code.tagName === 'code' &&
        Array.isArray(code.properties.className) &&
        code.properties.className.includes('language-socio-chart') &&
        start !== undefined &&
        end !== undefined &&
        starts.has(start) &&
        completeInlineChartFence(source.slice(start, end)) &&
        code.children.every((child) => child.type === 'text')
    ) {
        const chart = parseInlineChart(
            code.children.map((child) => (child.type === 'text' ? child.value : '')).join(''),
        );
        if (chart) {
            return <InlineChart chart={chart} />;
        }
    }
    return <pre>{children}</pre>;
};
const replyComponents: Components = {
    ...markdownComponents,
    pre: ReplyCodeBlock,
    a: ({ href, children }) => <ReplyLink href={href}>{children}</ReplyLink>,
    p: ({ node, children }) => (issueLinksOnly(node) ? <IssueCardStack>{children}</IssueCardStack> : <p>{children}</p>),
    li: ({ node, children }) => <li>{issueLinksOnly(node) ? <IssueCards>{children}</IssueCards> : children}</li>,
    ul: ({ node, children }) => <ul className={issueLinksOnly(node) ? 'm-0 list-none p-0' : undefined}>{children}</ul>,
    ol: ({ node, children }) => <ol className={issueLinksOnly(node) ? 'm-0 list-none p-0' : undefined}>{children}</ol>,
};
export const Markdown = memo(function Markdown({
    children,
    reply = false,
    onBubble = false,
}: {
    children: string;
    /** A Dot's reply, not the person's message or the model's reasoning. */
    reply?: boolean;
    /** On the person's own (teal) bubble. */
    onBubble?: boolean;
}) {
    const chartSource = useMemo(() => {
        const starts = new Set<number>();
        if (reply) {
            for (const match of children.matchAll(/^```socio-chart[ \t]*\r?$/gm)) {
                starts.add(match.index);
                if (starts.size === INLINE_CHARTS_PER_MESSAGE) {
                    break;
                }
            }
        }
        return { source: reply ? children : '', starts };
    }, [children, reply]);
    return (
        <ChartSource value={chartSource}>
            <ReactMarkdown
                remarkPlugins={remarkPlugins}
                components={reply ? replyComponents : onBubble ? bubbleComponents : markdownComponents}
            >
                {children}
            </ReactMarkdown>
        </ChartSource>
    );
});

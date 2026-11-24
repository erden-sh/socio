import ReactMarkdown, { type Components, type Options } from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { remarkIssueKeys } from '../../lib/remark-issue-keys';
import { AppLink } from '../../shell/AppLink';

import { IssueRefChip } from './IssueRefChip';

import { cn } from '@/lib/utils';

// Elements get a data-slot so the legacy element rules (style.css) leave
// them alone; images show their alt text (attachments are listed apart).
const components: Components = {
    p: ({ children }) => (
        <p data-slot="md-p" className="my-2 first:mt-0 last:mb-0">
            {children}
        </p>
    ),
    h1: ({ children }) => (
        <h3 data-slot="md-h" className="mt-4 mb-2 text-base font-semibold">
            {children}
        </h3>
    ),
    h2: ({ children }) => (
        <h3 data-slot="md-h" className="mt-4 mb-2 text-base font-semibold">
            {children}
        </h3>
    ),
    h3: ({ children }) => (
        <h3 data-slot="md-h" className="mt-3 mb-1.5 text-sm font-semibold">
            {children}
        </h3>
    ),
    ul: ({ children }) => <ul className="my-2 list-disc pl-5">{children}</ul>,
    ol: ({ children }) => <ol className="my-2 list-decimal pl-5">{children}</ol>,
    li: ({ children }) => <li className="my-0.5">{children}</li>,
    blockquote: ({ children }) => (
        <blockquote className="my-2 border-l-2 pl-3 text-muted-foreground">{children}</blockquote>
    ),
    pre: ({ children }) => (
        <pre className="my-2 overflow-x-auto rounded-md bg-muted p-3 text-xs whitespace-pre-wrap">{children}</pre>
    ),
    code: ({ children, className }) => (
        <code
            className={cn(
                'rounded bg-muted px-1 py-0.5 font-mono text-[0.85em] [overflow-wrap:anywhere] [pre_&]:bg-transparent [pre_&]:p-0',
                className,
            )}
        >
            {children}
        </code>
    ),
    table: ({ children }) => (
        <div className="my-2 overflow-x-auto">
            <table className="w-full border-collapse text-xs">{children}</table>
        </div>
    ),
    th: ({ children }) => <th className="border px-2 py-1 text-left font-medium">{children}</th>,
    td: ({ children }) => <td className="border px-2 py-1">{children}</td>,
    img: ({ alt }) => <span className="text-muted-foreground">{alt}</span>,
    a: ({ href, children, node }) => {
        // "#12" or "CB-12" in an issue's text (CB-274): a chip, or the words.
        const ref = node?.properties.dataIssueRef;
        if (typeof ref === 'string' || typeof ref === 'number') {
            return <IssueRefChip number={Number(ref)}>{children}</IssueRefChip>;
        }
        return (
            <span className="text-primary underline underline-offset-2">
                <AppLink href={href}>{children}</AppLink>
            </span>
        );
    },
};

type Plugins = NonNullable<Options['remarkPlugins']>;
const PLAIN: Plugins = [remarkGfm];
const WITH_UPSTREAM_KEYS: Plugins = [remarkGfm, [remarkIssueKeys as Plugins[number], { upstream: true }]] as Plugins;
const WITH_CHIPS: Plugins = [remarkGfm, [remarkIssueKeys as Plugins[number], { hash: true, chips: true }]] as Plugins;

/**
 * An issue's description or a comment, as markdown. `upstreamIssueKeys`
 * links each "CB-n" in the text to its issue on Socio's own board (the
 * release notes, CB-381); `issueChips` shows
 * each "#n" and "CB-n" as a chip with the issue's key and title, when the
 * reader can have it (an issue's description and comments, CB-274).
 */
export function IssueMarkdown({
    text,
    className,
    upstreamIssueKeys,
    issueChips,
}: {
    text: string;
    className?: string;
    upstreamIssueKeys?: boolean;
    issueChips?: boolean;
}) {
    return (
        <div data-slot="issue-markdown" className={cn('text-sm leading-relaxed [overflow-wrap:anywhere]', className)}>
            <ReactMarkdown
                remarkPlugins={issueChips ? WITH_CHIPS : upstreamIssueKeys ? WITH_UPSTREAM_KEYS : PLAIN}
                components={components}
            >
                {text}
            </ReactMarkdown>
        </div>
    );
}

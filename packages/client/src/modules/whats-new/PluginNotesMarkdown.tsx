import ReactMarkdown, { type Components, type Options } from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { AppLink } from '../../shell/AppLink';

import { cn } from '@/lib/utils';

/**
 * Elements a plugin's notes may have. Raw HTML is dropped (`skipHtml`),
 * so are images and every other element not listed here (their text
 * stays), and each element below is drawn by `components`, which pass on
 * no attribute but a link's href. Links go through `AppLink`: an app path
 * opens in the app, an http(s) or mailto URL in a new tab with no
 * referrer, anything else (`javascript:`, `data:`) is plain text.
 */
const ALLOWED = [
    'p',
    'br',
    'strong',
    'em',
    'del',
    'code',
    'pre',
    'blockquote',
    'ul',
    'ol',
    'li',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'a',
    'hr',
    'table',
    'thead',
    'tbody',
    'tr',
    'th',
    'td',
];

const heading: Components['h1'] = ({ children }) => (
    <h4 data-slot="md-h" className="mt-3 mb-1.5 text-sm font-semibold">
        {children}
    </h4>
);

const components: Components = {
    p: ({ children }) => (
        <p data-slot="md-p" className="my-1.5 first:mt-0 last:mb-0">
            {children}
        </p>
    ),
    h1: heading,
    h2: heading,
    h3: heading,
    h4: heading,
    h5: heading,
    h6: heading,
    ul: ({ children }) => <ul className="my-1.5 list-disc pl-5">{children}</ul>,
    ol: ({ children }) => <ol className="my-1.5 list-decimal pl-5">{children}</ol>,
    li: ({ children }) => <li className="my-0.5">{children}</li>,
    blockquote: ({ children }) => (
        <blockquote className="my-1.5 border-l-2 pl-3 text-muted-foreground">{children}</blockquote>
    ),
    pre: ({ children }) => (
        <pre className="my-1.5 overflow-x-auto rounded-md bg-muted p-2 text-xs whitespace-pre-wrap">{children}</pre>
    ),
    code: ({ children }) => (
        <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em] [overflow-wrap:anywhere] [pre_&]:bg-transparent [pre_&]:p-0">
            {children}
        </code>
    ),
    table: ({ children }) => (
        <div className="my-1.5 overflow-x-auto">
            <table className="w-full border-collapse text-xs">{children}</table>
        </div>
    ),
    th: ({ children }) => <th className="border px-2 py-1 text-left font-medium">{children}</th>,
    td: ({ children }) => <td className="border px-2 py-1">{children}</td>,
    a: ({ href, children }) => (
        <span className="text-primary underline underline-offset-2">
            <AppLink href={href}>{children}</AppLink>
        </span>
    ),
};

const REMARK: NonNullable<Options['remarkPlugins']> = [remarkGfm];

/**
 * A plugin's release notes (CB-527), Markdown from its manifest rendered
 * sanitized: no raw HTML, no images or anything else that loads (they are
 * dropped), links with the usual outside-link handling.
 */
export function PluginNotesMarkdown({ text, className }: { text: string; className?: string }) {
    return (
        <div
            data-slot="plugin-notes-markdown"
            className={cn('text-sm leading-relaxed [overflow-wrap:anywhere]', className)}
        >
            <ReactMarkdown
                remarkPlugins={REMARK}
                components={components}
                skipHtml
                allowedElements={ALLOWED}
                unwrapDisallowed
            >
                {text}
            </ReactMarkdown>
        </div>
    );
}

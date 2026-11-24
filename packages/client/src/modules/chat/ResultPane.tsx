import { ArrowDownToLine, ArrowUpRight, BookOpen, ExternalLink, Monitor, X, type LucideIcon } from 'lucide-react';
import { useState } from 'react';
import ReactMarkdown from 'react-markdown';

import type { Dot, Result, Status } from '@socio/shared/types';

import { plainHover } from '../../lib/plain-button';
import { Mascot } from '../../locals/Mascot';
import { ComputerPanel, panel } from '../computers/ComputerPanel';

import { cn } from '@/lib/utils';

const iconButton = cn('shrink-0 border-0 bg-transparent p-1.5 text-[#989baa] dark:text-[#9da0af]', plainHover);
const tab = (selected: boolean) =>
    cn(
        'border-0 px-[9px] py-[7px] text-[13px]',
        selected
            ? 'bg-[#ededed] text-[#222] dark:bg-[#2a2a2a] dark:text-[#eeeeee]'
            : cn('bg-transparent text-[#666] dark:text-[#b2b2b2]', plainHover),
    );
/** A research brief's Markdown. */
const brief =
    'text-[12px] leading-[1.9] whitespace-pre-line text-[#737888] [overflow-wrap:anywhere] dark:text-[#9fa4b5] [&_:is(h1,h2,h3)]:leading-[1.45] [&_:is(h1,h2,h3)]:tracking-[-0.3px] [&_:is(h1,h2,h3)]:text-[#4f5565] dark:[&_:is(h1,h2,h3)]:text-[#b8bfd2] [&_h1]:text-[23px] [&_h2]:text-[18px] [&_h3]:text-[15px] [&_p]:mx-0 [&_p]:mt-0 [&_p]:mb-4.5 [&_p]:leading-[1.9] [&_:is(ul,ol)]:pl-4.5 [&_a]:text-[#7185c2] [&_a]:underline dark:[&_a]:text-[#8ba0df] [&_pre]:rounded-[7px] [&_pre]:bg-[#f1f2f5] [&_pre]:p-3 [&_pre]:whitespace-pre-wrap dark:[&_pre]:bg-[#262628]';
const sourceCard = 'mt-2.5 flex items-start gap-2.5 rounded-[8px] border border-border bg-white p-[13px] dark:bg-card';

/**
 * The findings panel beside a chat, or over the view (Show computer): a
 * Dot's computer, or the chat's research brief and its sources.
 */
export function ResultPane({
    latest,
    status,
    dotState,
    onClose,
    dots,
    defaultDotId,
    docked = false,
}: {
    /** Beside a chat, on the sidebar's surface; else over the view. */
    docked?: boolean;
    dots: Dot[];
    defaultDotId: string;
    latest?: Result | null;
    status?: Status;
    dotState: string;
    onClose: () => void;
}) {
    const [resultTab, setResultTab] = useState<'Brief' | 'Computer'>('Computer');
    const [computerDotId, setComputerDotId] = useState(defaultDotId);
    const computerDot =
        dots.find((dot) => dot.id === computerDotId) ?? dots.find((dot) => dot.id === defaultDotId) ?? dots[0];
    return (
        <aside
            className={cn(
                'min-w-0 border-l border-l-border max-[920px]:[border-left:0] max-[920px]:border-t max-[920px]:border-t-border',
                docked ? 'bg-sidebar' : 'bg-[#fdfcfb] dark:bg-[#20201f]',
            )}
        >
            <div className="sticky top-0 z-2 flex h-14 items-center justify-between border-b border-b-border bg-[#fafafa] px-4 py-3 max-[700px]:static dark:bg-[#212121]">
                <div className="flex gap-1.5">
                    <button className={tab(resultTab === 'Brief')} onClick={() => setResultTab('Brief')}>
                        <BookOpen size={15} />
                        Brief
                    </button>
                    <button className={tab(resultTab === 'Computer')} onClick={() => setResultTab('Computer')}>
                        <Monitor size={15} /> {computerDot?.name ?? 'Socio'}’s computer
                    </button>
                </div>
                <button className={iconButton} aria-label="Close result panel" onClick={() => onClose()}>
                    <X size={16} />
                </button>
            </div>
            {resultTab === 'Computer' ? (
                <>
                    <label className="flex items-center gap-3 border-b border-b-border px-4.5 py-2.5 text-[12px] text-[#666] dark:text-[#b2b2b2]">
                        Computer for
                        <select
                            className="w-full min-w-0 flex-1 rounded-[6px] border-0 bg-transparent p-[5px] text-[13px] text-[#273243] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#476ba0] dark:text-[#d2e0f6] dark:focus-visible:outline-[#80a6df]"
                            value={computerDot?.id ?? ''}
                            onChange={(event) => setComputerDotId(event.target.value)}
                            aria-label="Select socio computer"
                        >
                            {dots.map((dot) => (
                                <option key={dot.id} value={dot.id}>
                                    {dot.name}
                                </option>
                            ))}
                        </select>
                    </label>
                    {computerDot ? (
                        <ComputerPanel key={computerDot.id} dot={computerDot} />
                    ) : (
                        <p className={panel}>Create a socio to give it a computer.</p>
                    )}
                </>
            ) : latest ? (
                <div className="p-[29px] max-[1150px]:p-[23px] max-[920px]:m-auto max-[920px]:max-w-170">
                    <div className="mb-[15px] flex items-center justify-between">
                        <span className="text-[12px] font-semibold tracking-[1.7px] text-[#999ca8] dark:text-[#9ea1ad]">
                            {latest.sample ? 'FICTIONAL SAMPLE BRIEF' : 'RESEARCH BRIEF'}
                        </span>
                        <button
                            className={iconButton}
                            aria-label="Download brief"
                            onClick={() => {
                                const blob = new Blob(
                                    [
                                        latest.text +
                                            '\n\nSources\n' +
                                            latest.sources.map((s) => `${s.title}: ${s.url}`).join('\n'),
                                    ],
                                    { type: 'text/plain' },
                                );
                                const url = URL.createObjectURL(blob);
                                const anchor = document.createElement('a');
                                anchor.href = url;
                                anchor.download = 'socio-brief.txt';
                                anchor.click();
                                URL.revokeObjectURL(url);
                            }}
                        >
                            <ArrowDownToLine size={16} />
                        </button>
                    </div>
                    {latest.sample && (
                        <div className="mb-5.5 rounded-[7px] border border-[#e8e6f1] bg-[#f1f0f8] px-[13px] py-[11px] text-[10px] leading-[1.8] text-[#9790b0] dark:border-[#323136] dark:bg-[#27272a] dark:text-[#a49dbd]">
                            An example of what a socio can do. The findings and sources below are invented.
                        </div>
                    )}
                    <article className={brief}>
                        <ReactMarkdown
                            components={{
                                img: ({ alt }) => <span>{alt ? `[Image: ${alt}]` : '[Image omitted]'}</span>,
                                a: ({ children, href }) => (
                                    <a href={href} target="_blank" rel="noreferrer">
                                        {children}
                                    </a>
                                ),
                            }}
                        >
                            {latest.text}
                        </ReactMarkdown>
                    </article>
                    <section className="mt-7.5 border-t border-t-border pt-[23px]">
                        <h3 className="flex items-center gap-[7px] text-[12px] tracking-normal text-[#858998] dark:text-[#9ea2b2]">
                            {'Source notes '}
                            <span className="text-[12px] font-normal text-[#b1b3bf] dark:text-[#9c9eaa]">
                                {latest.sources.length}
                            </span>
                        </h3>
                        {latest.sources.map((source) =>
                            latest.sample ? (
                                <div className={sourceCard} key={source.url}>
                                    <SourceText
                                        icon={BookOpen}
                                        title={source.title}
                                        excerpt={source.excerpt}
                                        note="Fictional source · not a live link"
                                    />
                                </div>
                            ) : (
                                <a
                                    className={sourceCard}
                                    href={source.url}
                                    key={source.url}
                                    target="_blank"
                                    rel="noreferrer"
                                >
                                    <SourceText
                                        icon={ExternalLink}
                                        title={source.title}
                                        excerpt={source.excerpt}
                                        note={new URL(source.url).hostname}
                                    />
                                    <ArrowUpRight size={15} className="shrink-0 text-[#b2b8c9] dark:text-[#999eaf]" />
                                </a>
                            ),
                        )}
                    </section>
                </div>
            ) : (
                <div className="m-auto max-w-85 px-[25px] py-15 text-center">
                    <Mascot
                        identity={defaultDotId}
                        character={dots.find((dot) => dot.id === defaultDotId)?.character}
                        name={dots.find((dot) => dot.id === defaultDotId)?.name}
                        state={dotState}
                        className="size-32.5 opacity-70"
                    />
                    <h3 className="text-[17px] text-[#969cae] dark:text-[#9ba1b3]">
                        A little space for your findings.
                    </h3>
                    <p className="text-[11px] leading-[1.9] text-[#a7abb7] dark:text-[#9ca0ab]">
                        {status === 'failed'
                            ? 'Resolve the error and retry to create a research brief.'
                            : 'Your brief and sources will appear here after a successful run.'}
                    </p>
                </div>
            )}
        </aside>
    );
}

/** A source note's icon, title, excerpt and where it is from. */
function SourceText({
    icon: Icon,
    title,
    excerpt,
    note,
}: {
    icon: LucideIcon;
    title: string;
    excerpt: string;
    note: string;
}) {
    return (
        <>
            <span className="grid size-[29px] shrink-0 place-items-center rounded-[7px] bg-[#f0f2f8] text-[#94a1c2] dark:bg-[#252629] dark:text-[#93a0c1]">
                <Icon size={15} />
            </span>
            <div className="min-w-0 flex-1">
                <strong className="text-[10px] font-medium text-[#858c9e] [overflow-wrap:anywhere] dark:text-[#9ba2b5]">
                    {title}
                </strong>
                <p className="my-1.5 text-[10px] leading-[1.6] text-[#a0a4af] dark:text-[#9ca0ab]">{excerpt}</p>
                <small className="text-[12px] text-[#b0b3c0] dark:text-[#9c9fab]">{note}</small>
            </div>
        </>
    );
}

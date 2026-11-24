import { CircleAlert } from 'lucide-react';
import { useState, type ReactNode } from 'react';

import { formatNumber } from '@socio/shared/locale';
import { parseJson, type StepState, type ToolStep } from '@socio/shared/runs/turn-steps';
import { inlineImageType, toolImageOf } from '@socio/shared/tool-images';

import { CopyButton } from '../MessageActions';

import { useFullResult } from './full-result';
import { ToolImageThumb, type ShownToolImage } from './ToolImage';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/** Lines and characters a block shows before "Show all". */
const BLOCK_LINES = 24;
const BLOCK_CHARS = 2_400;
/** Items a list shows before "and N more". */
const LIST_ITEMS = 12;

/** Fields that hold code or output: always a code block. */
const CODE_FIELDS = new Set(['command', 'sql', 'code', 'script', 'source', 'contents', 'content', 'stdout', 'stderr']);
/** Field names where the words of the key would read badly. */
const FIELD_NAMES: Record<string, string> = {
    stdout: 'Output',
    stderr: 'Errors',
    sql: 'SQL',
    url: 'URL',
    id: 'ID',
    timeoutMs: 'Time limit (ms)',
};
const fieldName = (key: string) => {
    if (FIELD_NAMES[key]) {
        return FIELD_NAMES[key];
    }
    const words = key
        .replace(/[_-]+/g, ' ')
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .toLowerCase()
        .trim();
    return words.charAt(0).toUpperCase() + words.slice(1);
};

type Scalar = string | number | boolean;
const isScalar = (value: unknown): value is Scalar => ['string', 'number', 'boolean'].includes(typeof value);
const isRecord = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === 'object' && !Array.isArray(value);
/** Text that reads as a block, not a line: several lines, or long. */
const isBlock = (text: string) => text.includes('\n') || text.length > 160;
/** Base64 or similar: a screenshot, a file's bytes. */
const isBinary = (text: string) => text.length > 1_000 && /^[A-Za-z0-9+/=\s]+$/.test(text.slice(0, 2_000));
const kilobytes = (text: string | number) =>
    typeof text === 'number'
        ? `${formatNumber(Math.max(1, Math.round(text / 1024)))} KB`
        : `${formatNumber(Math.max(1, Math.round((text.length * 3) / 4 / 1024)))} KB`;
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
/** Search excerpts mark matches in Markdown bold. */
const plain = (text: string) => text.replace(/\*\*/g, '');

const head = 'flex items-center justify-between gap-2';
const mono = 'font-[ui-monospace,SFMono-Regular,Menlo,monospace]';
const note = 'm-0 [overflow-wrap:anywhere]';
const textLine = cn(note, 'whitespace-pre-wrap text-foreground');
/** "Show all", "Try again". */
const more = 'mx-1.5 mt-0 mb-1.5';

/**
 * Code, a script or its output (CB-72): monospace, with its own copy
 * button; a long one shows its first lines until "Show all".
 */
export function CodeBlock({ label, text, tone }: { label: string; text: string; tone?: 'error' }) {
    const [all, setAll] = useState(false);
    const lines = text.split('\n');
    const cut = !all && (lines.length > BLOCK_LINES || text.length > BLOCK_CHARS);
    const shown = cut ? lines.slice(0, BLOCK_LINES).join('\n').slice(0, BLOCK_CHARS) : text;
    return (
        <div
            className="min-w-0 overflow-hidden rounded-[8px] border border-border bg-muted"
            data-slot="trace-code"
            data-tone={tone}
        >
            <div className={cn(head, 'border-b border-b-border py-px pr-0.5 pl-2.5 text-[11px]')}>
                <span className={tone === 'error' ? 'text-destructive' : undefined} data-slot="trace-code-label">
                    {label}
                </span>
                <CopyButton text={text} />
            </div>
            <pre
                className={cn(
                    mono,
                    'm-0 max-h-90 overflow-auto px-2.5 py-2 text-[11.5px] leading-[1.55] whitespace-pre-wrap text-foreground [overflow-wrap:anywhere]',
                )}
            >
                {shown}
            </pre>
            {cut && (
                <Button type="button" variant="ghost" size="xs" className={more} onClick={() => setAll(true)}>
                    {lines.length > 1
                        ? `Show all ${formatNumber(lines.length)} lines`
                        : `Show all ${formatNumber(text.length)} characters`}
                </Button>
            )}
        </div>
    );
}

/**
 * A list of found things (search matches, rows): one line each, its title
 * first, a couple of short fields and an excerpt after it.
 */
function ItemList({ label, items }: { label: string; items: Record<string, unknown>[] }) {
    const shown = items.slice(0, LIST_ITEMS);
    return (
        <div data-slot="trace-items">
            <div className="mb-1 text-[11px]">
                {label} · {formatNumber(items.length)}
            </div>
            <ul className="m-0 flex list-none flex-col gap-1 p-0">
                {shown.map((item, index) => {
                    const titleKey = ['title', 'name', 'url', 'path', 'id'].find(
                        (key) => isScalar(item[key]) && String(item[key]).trim(),
                    );
                    const prefix = ['issue', 'key'].find((key) => isScalar(item[key]));
                    const used = new Set([titleKey, prefix]);
                    const excerptKey = ['excerpt', 'snippet', 'description'].find(
                        (key) => typeof item[key] === 'string',
                    );
                    const meta = Object.entries(item)
                        .filter(
                            ([key, value]) =>
                                !used.has(key) &&
                                key !== excerptKey &&
                                (typeof value === 'number' ||
                                    typeof value === 'boolean' ||
                                    (typeof value === 'string' && value && value.length <= 40)),
                        )
                        .slice(0, 2)
                        .map(([key, value]) => `${fieldName(key)} ${String(value)}`);
                    const title = [prefix && item[prefix], titleKey && item[titleKey]]
                        .filter((part) => part !== undefined && part !== '')
                        .join(' ');
                    return (
                        <li key={index}>
                            <span className="text-foreground" data-slot="trace-item-title">
                                {clip(title || `Item ${index + 1}`, 120)}
                            </span>
                            {meta.length > 0 && <span> · {meta.join(' · ')}</span>}
                            {excerptKey && <span className="block">{clip(plain(String(item[excerptKey])), 200)}</span>}
                        </li>
                    );
                })}
            </ul>
            {items.length > shown.length && (
                <p className={note}>and {formatNumber(items.length - shown.length)} more (copy for all)</p>
            )}
        </div>
    );
}

/**
 * An object's fields: short ones as name and value, code, long text, lists
 * and nested objects as blocks under their name. Empty fields are left out.
 */
function Fields({ fields }: { fields: Record<string, unknown> }) {
    const rows: [string, string][] = [];
    const blocks: ReactNode[] = [];
    for (const [key, value] of Object.entries(fields)) {
        if (value === undefined || value === null || value === '') {
            continue;
        }
        const name = fieldName(key);
        if (typeof value === 'string') {
            if (isBinary(value)) {
                rows.push([name, `Binary data, ${kilobytes(value)}`]);
            } else if (CODE_FIELDS.has(key) || isBlock(value)) {
                blocks.push(
                    <CodeBlock key={key} label={name} text={value} tone={key === 'stderr' ? 'error' : undefined} />,
                );
            } else {
                rows.push([name, value]);
            }
        } else if (isScalar(value)) {
            rows.push([name, String(value)]);
        } else if (Array.isArray(value) && value.every(isScalar)) {
            rows.push([name, clip(value.join(', '), 300)]);
        } else if (Array.isArray(value) && value.length && value.every(isRecord)) {
            blocks.push(<ItemList key={key} label={name} items={value} />);
        } else if (isRecord(value) && Object.values(value).every((entry) => typeof entry === 'string'))
        // Files by name (a job's files): one block each.
        {
            for (const [file, contents] of Object.entries(value)) {
                blocks.push(<CodeBlock key={`${key}/${file}`} label={file} text={contents as string} />);
            }
        } else {
            blocks.push(<CodeBlock key={key} label={name} text={JSON.stringify(value, null, 2)} />);
        }
    }
    return (
        <>
            {rows.length > 0 && (
                <dl className="m-0 grid grid-cols-[minmax(5rem,max-content)_minmax(0,1fr)] gap-x-3 gap-y-0.5">
                    {rows.map(([name, value]) => (
                        <div key={name} className="contents">
                            <dt>{name}</dt>
                            <dd className="m-0 text-foreground [overflow-wrap:anywhere]">{clip(value, 400)}</dd>
                        </div>
                    ))}
                </dl>
            )}
            {blocks}
        </>
    );
}

/** Any value a tool took or gave, readable: never a wall of JSON. */
function Value({ value, label }: { value: unknown; label: string }) {
    if (typeof value === 'string') {
        return isBlock(value) ? <CodeBlock label={label} text={value} /> : <p className={textLine}>{value}</p>;
    }
    if (Array.isArray(value) && value.length && value.every(isRecord)) {
        return <ItemList label={label} items={value} />;
    }
    if (isRecord(value)) {
        return <Fields fields={value} />;
    }
    return <p className={textLine}>{Array.isArray(value) ? value.join(', ') : String(value)}</p>;
}

function Section({
    label,
    copy,
    children,
}: {
    label: string;
    /** What its copy button copies: the raw value. */
    copy: string;
    children: ReactNode;
}) {
    return (
        <section className="flex min-w-0 flex-col gap-1.5" aria-label={label}>
            <div className={cn(head, '[&>span]:text-[11px] [&>span]:font-semibold')}>
                <span>{label}</span>
                <CopyButton text={copy} />
            </div>
            {children}
        </section>
    );
}

/**
 * A failed or stopped result without what its line above says: the
 * message, and the error status and reason code the runtime adds.
 */
function withoutSurfaced(result: unknown, outcome: { state: StepState; message?: string }) {
    if (!isRecord(result) || !['failed', 'stopped'].includes(outcome.state)) {
        return result;
    }
    const status = ['error', 'failed', 'stopped'].includes(String(result.status));
    return Object.fromEntries(
        Object.entries(result).filter(
            ([key, value]) =>
                !(
                    ((key === 'error' || key === 'message') && value === outcome.message) ||
                    (status && (key === 'status' || key === 'reason'))
                ),
        ),
    );
}

/**
 * The image a result names (CB-157), with the rest of the result: a
 * stored screenshot, or an older version's whole one as base64.
 */
function resultImage(
    callId: string,
    result: unknown,
    whole: boolean,
): { image: ShownToolImage; rest: Record<string, unknown> } | undefined {
    if (!isRecord(result)) {
        return undefined;
    }
    const name = typeof result.name === 'string' ? result.name : 'Screenshot';
    const ref = toolImageOf(result);
    if (ref) {
        const rest = { ...result };
        delete rest.image;
        return {
            image: {
                id: ref.id,
                name,
                mediaType: ref.mediaType,
                size: ref.size,
            },
            rest,
        };
    }
    const base64 = typeof result.base64 === 'string' ? result.base64 : '';
    const type = whole ? inlineImageType(base64) : undefined;
    if (!type) {
        return undefined;
    }
    const rest = { ...result };
    delete rest.base64;
    return {
        image: {
            id: `inline:${callId}`,
            name,
            mediaType: type,
            size: Math.floor((base64.length * 3) / 4),
            src: `data:${type};base64,${base64}`,
        },
        rest,
    };
}

const pretty = (text: string, value: unknown) => (value === undefined ? text : JSON.stringify(value, null, 2));

/**
 * What a tool step took and gave (CB-72), shown when the step is opened:
 * a failure first, then its input and result. What the failure line says
 * is not repeated in the result.
 */
export function ToolDetails({ step, outcome }: { step: ToolStep; outcome: { state: StepState; message?: string } }) {
    const raw = step.call.function.arguments;
    const args = parseJson(raw);
    // An older turn's long result is a preview until the whole one comes.
    const full = useFullResult(step.id, step.result);
    const text = full.result;
    const result = parseJson(text);
    // A screenshot shows as one (CB-157); an older inline one once it is whole.
    const pictured = resultImage(step.id, result, full.size === undefined);
    const shownResult = withoutSurfaced(pictured?.rest ?? result ?? text, outcome);
    const hasInput = raw.trim() !== '' && !(isRecord(args) && !Object.keys(args).length);
    const hasFields = !(isRecord(shownResult) && !Object.keys(shownResult).length);
    const hasResult = text !== undefined && (!!pictured || hasFields);
    return (
        <div className="mt-1 mr-0 mb-2.5 ml-7 flex min-w-0 flex-col gap-2.5" data-slot="trace-details">
            {outcome.state === 'failed' && (
                <p
                    className="m-0 flex items-start gap-1.5 rounded-[8px] border border-destructive/30 bg-destructive/8 px-2.5 py-1.5 text-destructive [overflow-wrap:anywhere]"
                    role="alert"
                >
                    <CircleAlert size={14} aria-hidden="true" className="mt-0.5 shrink-0" />
                    <span>{outcome.message ?? 'This step failed.'}</span>
                </p>
            )}
            {outcome.state === 'stopped' && (
                <p className={note} role="status">
                    {outcome.message ?? 'It stopped before it finished.'}
                </p>
            )}
            {hasInput && (
                <Section label="Input" copy={pretty(raw, args)}>
                    {args === undefined ? <CodeBlock label="Input" text={raw} /> : <Value value={args} label="Input" />}
                </Section>
            )}
            {outcome.state === 'running' && (
                <p className={note} role="status">
                    Waiting for the result…
                </p>
            )}
            {hasResult && (
                <Section label="Result" copy={pretty(text!, result)}>
                    {full.loading && (
                        <p className={note} role="status">
                            Loading the whole result ({kilobytes(full.size!)})…
                        </p>
                    )}
                    {full.failed && (
                        <p className={note} role="status">
                            Only part of this result is shown: the rest didn’t load.{' '}
                            <Button type="button" variant="ghost" size="xs" className={more} onClick={full.retry}>
                                Try again
                            </Button>
                        </p>
                    )}
                    {pictured && <ToolImageThumb image={pictured.image} />}
                    {hasFields && <Value value={shownResult} label="Result" />}
                </Section>
            )}
        </div>
    );
}

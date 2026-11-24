import { useCallback, useEffect, useRef, useState } from 'react';

import type { ComputerAction, ComputerStatus } from '@socio/shared/computers/computer-types';
import type { Dot } from '@socio/shared/types';

import { api } from '../../lib/api';
import { plainHover } from '../../lib/plain-button';
import { useIsAdmin } from '../../shell/current-user';
import { useFlag } from '../../shell/flags';
import { CodingSandboxList } from '../coding/CodingSandboxList';

import { cn } from '@/lib/utils';

type Screen = {
    base64: string;
    width: number;
    height: number;
    url: string;
    capturedAt: number;
};

/** The panel (also its "Create a Dot" line in ResultPane). */
export const panel = 'flex flex-col gap-0 px-4.5 py-3.5 text-[13px] leading-[1.5] text-[#333b49] dark:text-[#cdd7e9]';
const focusRing =
    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#476ba0] dark:focus-visible:outline-[#80a6df]';
const field = cn(
    'w-full min-w-0 rounded-[6px] [font:inherit] border border-[#c4c8d0] bg-white p-2 text-[#273243] dark:border-[#4c4e52] dark:bg-card dark:text-[#d2e0f6]',
    focusRing,
);
/** A field in a row: it takes the room the button leaves. */
const rowField = cn(field, 'flex-1');
const textarea = cn(field, 'block resize-y');
const button = cn(
    'rounded-[6px] border border-[#bac2cd] bg-white px-2.5 py-[7px] text-[#273243] disabled:cursor-default dark:border-[#51555b] dark:bg-card dark:text-[#d2e0f6]',
    plainHover,
    focusRing,
);
const rowButton = cn(button, 'shrink-0');
const para = 'mt-2 mb-3';
const summary = 'cursor-pointer py-[5px] font-semibold';
const label = 'my-2 block';
const rowLabel = cn(label, 'min-w-0 flex-1');
const hint = 'text-[11px] text-[#596373] dark:text-[#abb6c8]';
const row = 'my-2.5 flex items-center gap-2';
const actions = 'my-2.5 flex flex-wrap items-center gap-2';
const section = 'mt-4.5 border-t border-t-border pt-3.5';
const errorLine = cn(
    para,
    'rounded-[5px] bg-[#fff0f0] p-2.5 text-[#a32b32] [overflow-wrap:anywhere] dark:bg-[#2a2323] dark:text-[#ff9894]',
);
const tabButton = cn(
    'rounded-none border-0 border-b-2 border-b-transparent bg-transparent px-0.5 py-2 text-[#6a6a6a] aria-selected:border-b-[#222] aria-selected:text-[#222] dark:text-[#afafaf] dark:aria-selected:text-[#eeeeee]',
    plainHover,
    focusRing,
);

export function ComputerPanel({ dot }: { dot: Dot }) {
    const [tab, setTab] = useState<'Browser' | 'Files' | 'Terminal' | 'Activity' | 'Coding'>('Browser');
    // The socio's coding sandboxes (CB-239), with the flag on.
    const coding = useFlag('coding-sessions');
    const [status, setStatus] = useState<ComputerStatus>();
    const [screen, setScreen] = useState<Screen>();
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    const admin = useIsAdmin();
    const [url, setUrl] = useState('');
    const [text, setText] = useState('');
    const [key, setKey] = useState('Enter');
    const [point, setPoint] = useState({ x: 0, y: 0 });
    const [path, setPath] = useState('');
    const [contents, setContents] = useState('');
    const [command, setCommand] = useState('');
    const [output, setOutput] = useState('');
    const [outputError, setOutputError] = useState('');
    const [screenError, setScreenError] = useState('');
    const lifecycle = useRef({
        active: false,
        revision: 0,
        busy: false,
        loaded: false,
        running: false,
    });
    const controller = useRef<AbortController | null>(null);
    const base = `/dots/${encodeURIComponent(dot.id)}/computer`;
    const refresh = useCallback(async () => {
        const revision = lifecycle.current.revision;
        const current = () => lifecycle.current.active && revision === lifecycle.current.revision;
        try {
            const next = await api<ComputerStatus>(base, 'GET', undefined, controller.current?.signal);
            if (!current()) {
                return;
            }
            setStatus(next);
            lifecycle.current.loaded = true;
            lifecycle.current.running = next.state === 'running';
            setError('');
            if (next.state === 'running' && next.permissions.browser && next.permissions.enabled) {
                try {
                    const capture = await api<Screen>(
                        `${base}/actions`,
                        'POST',
                        { action: 'screenshot', input: {} },
                        controller.current?.signal,
                    );
                    if (current()) {
                        setScreen(capture);
                        setScreenError('');
                    }
                } catch (cause) {
                    if (current()) {
                        setScreen(undefined);
                        setScreenError(cause instanceof Error ? cause.message : 'Could not refresh the screen.');
                    }
                }
            } else {
                setScreen(undefined);
                setScreenError('');
            }
        } catch (cause) {
            if (current()) {
                setError(cause instanceof Error ? cause.message : 'Could not load the computer.');
                setScreen(undefined);
            }
        }
    }, [base]);
    useEffect(() => {
        // One object for the panel's life (never reassigned), so the cleanup
        // can hold it.
        const state = lifecycle.current;
        state.active = true;
        controller.current = new AbortController();
        let cancelled = false;
        let timer: ReturnType<typeof setTimeout>;
        const poll = async () => {
            if (
                !document.hidden &&
                !lifecycle.current.busy &&
                (!lifecycle.current.loaded || lifecycle.current.running)
            ) {
                await refresh();
            }
            if (!cancelled && lifecycle.current.active) {
                timer = setTimeout(() => void poll(), 4000);
            }
        };
        void poll();
        return () => {
            cancelled = true;
            state.active = false;
            state.revision++;
            controller.current?.abort();
            clearTimeout(timer);
        };
    }, [refresh]);
    const run = async (endpoint: string, body: unknown = {}, method = 'POST', showOutput = false) => {
        if (lifecycle.current.busy) {
            return;
        }
        lifecycle.current.busy = true;
        lifecycle.current.revision++;
        setBusy(true);
        setError('');
        if (showOutput) {
            setOutputError('');
        }
        try {
            const result = await api<unknown>(`${base}${endpoint}`, method, body, controller.current?.signal);
            if (!lifecycle.current.active) {
                return;
            }
            if (showOutput) {
                setOutput(typeof result === 'string' ? result : JSON.stringify(result, null, 2));
            }
            await refresh();
            return result;
        } catch (cause) {
            if (!lifecycle.current.active) {
                return;
            }
            const message = cause instanceof Error ? cause.message : 'Computer action failed.';
            // Status polling clears the panel error, so keep output action failures
            // next to the output they replace.
            if (showOutput) {
                setOutput('');
                setOutputError(message);
            } else {
                setError(message);
            }
        } finally {
            lifecycle.current.busy = false;
            if (lifecycle.current.active) {
                setBusy(false);
            }
        }
    };
    const action = (action: ComputerAction, input: unknown, showOutput = false) =>
        run('/actions', { action, input }, 'POST', showOutput);
    const running = status?.state === 'running' && status.permissions.enabled;
    const human = status?.control?.holder === 'human' && !status.control.transitioning;
    const browser = !!running && !!status?.permissions.browser;
    return (
        <section className={panel} aria-label={`${dot.name}'s computer`} aria-busy={busy}>
            {error && (
                <p className={errorLine} role="alert">
                    {error}
                </p>
            )}
            {!status ? (
                <p className={para} role="status">
                    {error ? 'Computer status unavailable.' : 'Loading computer…'}
                </p>
            ) : (
                <>
                    <div className="mb-3 flex items-center justify-between gap-2 text-[12px] text-[#666] capitalize dark:text-[#b2b2b2]">
                        <strong>{status.state.replaceAll('_', ' ')}</strong>
                        {status.state !== 'running' && (
                            <button className={button} disabled={busy} onClick={() => void refresh()}>
                                Refresh
                            </button>
                        )}
                        <span className="text-[11px]">
                            {busy ? 'Working…' : human ? 'You have control' : 'Socio control'}
                        </span>
                    </div>
                    {!status.configured && (
                        <div className="rounded-[8px] bg-[#f0f2f6] p-3.5 dark:bg-[#262628]">
                            <h3 className="mt-0 mb-2.5 text-[13px]">Connect a computer service</h3>
                            <p className={para}>
                                This socio does not have a computer service configured. Configure the server’s computer
                                service URL and token, then restart. Each socio gets its own browser; commands and files
                                are private to each person unless shared explicitly.
                            </p>
                        </div>
                    )}
                    {status.error && (
                        <p className={errorLine} role="alert">
                            {status.error}
                        </p>
                    )}
                    <div
                        className="flex gap-3 border-b border-b-[#ddd] dark:border-b-[#3b3b3b]"
                        role="tablist"
                        aria-label="Computer tools"
                    >
                        {(
                            [
                                'Browser',
                                'Files',
                                'Terminal',
                                'Activity',
                                ...(coding ? (['Coding'] as const) : []),
                            ] as const
                        ).map((name) => (
                            <button
                                className={tabButton}
                                role="tab"
                                aria-selected={tab === name}
                                key={name}
                                onClick={() => setTab(name)}
                            >
                                {name}
                            </button>
                        ))}
                    </div>
                    {status.configured && (
                        <>
                            <section className="mt-[5px]" hidden={tab !== 'Browser'}>
                                {!status.permissions.browser && (
                                    <p className={para}>Enable Browser permission to use the screen.</p>
                                )}
                                <form
                                    className={cn(row, 'rounded-[9px] bg-[#eeeeef] p-1.5 dark:bg-[#292929]')}
                                    onSubmit={(event) => {
                                        event.preventDefault();
                                        void action('navigate', { url });
                                    }}
                                >
                                    <input
                                        className={cn(
                                            rowField,
                                            'border-0 bg-[#fafafa] px-[9px] py-1.5 dark:bg-[#212121]',
                                        )}
                                        type="url"
                                        aria-label="Browser URL"
                                        placeholder="https://example.com"
                                        value={url}
                                        onChange={(event) => setUrl(event.target.value)}
                                        required
                                        disabled={!browser || busy || human}
                                    />
                                    <button className={rowButton} disabled={!browser || busy || human || !url.trim()}>
                                        Go
                                    </button>
                                </form>
                                {screenError && (
                                    <p className={errorLine} role="status">
                                        {screenError}
                                    </p>
                                )}
                                {screen ? (
                                    <>
                                        <div
                                            className="truncate rounded-t-[10px] border border-b-0 border-[#e0e0e0] bg-[#eee] px-2.5 py-[7px] text-[11px] text-[#646464] dark:border-[#383838] dark:bg-[#292929] dark:text-[#b3b3b3]"
                                            title={screen.url}
                                        >
                                            {screen.url || 'Browser screen'}
                                        </div>
                                        <button
                                            className={cn(
                                                button,
                                                'block w-full overflow-hidden rounded-t-none rounded-b-[10px] border-[#e0e0e0] p-0 leading-0 disabled:opacity-100 dark:border-[#383838]',
                                            )}
                                            aria-label={
                                                human
                                                    ? 'Click a point on the computer screen'
                                                    : 'Computer screen; take control to interact'
                                            }
                                            disabled={!browser || !human || busy}
                                            onClick={(event) => {
                                                const rect = event.currentTarget.getBoundingClientRect();
                                                void action('human_click', {
                                                    x: Math.min(
                                                        screen.width - 1,
                                                        Math.max(
                                                            0,
                                                            Math.floor(
                                                                ((event.clientX - rect.left) / rect.width) *
                                                                    screen.width,
                                                            ),
                                                        ),
                                                    ),
                                                    y: Math.min(
                                                        screen.height - 1,
                                                        Math.max(
                                                            0,
                                                            Math.floor(
                                                                ((event.clientY - rect.top) / rect.height) *
                                                                    screen.height,
                                                            ),
                                                        ),
                                                    ),
                                                });
                                            }}
                                        >
                                            <img
                                                className="block h-auto w-full"
                                                src={`data:image/png;base64,${screen.base64}`}
                                                alt={`Live browser screen for ${dot.name}`}
                                            />
                                        </button>
                                        <small className={hint}>
                                            Refreshed {new Date(screen.capturedAt).toLocaleTimeString()}. Screen updates
                                            while this panel is open.
                                        </small>
                                    </>
                                ) : (
                                    <p
                                        className={cn(
                                            para,
                                            'flex min-h-70 items-center justify-center rounded-[10px] border border-[#e0e0e0] bg-white px-3 py-6 text-center text-[#777] dark:border-[#383838] dark:bg-card dark:text-[#a5a5a5]',
                                        )}
                                    >
                                        {running && status.permissions.browser
                                            ? 'Waiting for the browser screen…'
                                            : 'Start the computer with Browser permission to see its screen.'}
                                    </p>
                                )}
                                <div className="mx-auto my-5 flex w-fit items-center justify-center gap-2.5 rounded-[25px] bg-[#eee] py-[5px] pr-[5px] pl-3.5 text-[12px] dark:bg-[#292929]">
                                    <span>{human ? 'You have control' : `${dot.name} has control`}</span>
                                    <button
                                        className={cn(
                                            button,
                                            'rounded-[20px] border-0 bg-[#222] text-[12px] text-white enabled:hover:bg-[#444] dark:bg-[#eaeaea] dark:text-background dark:enabled:hover:bg-[#dfdfdf]',
                                        )}
                                        disabled={(!human && !browser) || busy || status.control?.transitioning}
                                        onClick={() => void run(human ? '/release' : '/take')}
                                    >
                                        {human ? 'Return control' : 'Take over'}
                                    </button>
                                </div>
                                {status.control?.transitioning && (
                                    <p className={para} role="status">
                                        Transferring control…
                                    </p>
                                )}
                                {human && (
                                    <details className="border-t border-t-[#e5e5e5] pt-2 dark:border-t-[#343434]">
                                        <summary className={summary}>Keyboard & precise controls</summary>
                                        <p className={para}>
                                            Click the screen or enter coordinates below. Text goes directly to this
                                            browser, outside chat. Return control when finished.
                                        </p>
                                        <form
                                            className={row}
                                            onSubmit={(event) => {
                                                event.preventDefault();
                                                void action('human_click', point);
                                            }}
                                        >
                                            <label className={rowLabel}>
                                                X
                                                <input
                                                    className={field}
                                                    type="number"
                                                    min="0"
                                                    max={screen ? screen.width - 1 : undefined}
                                                    value={point.x}
                                                    onChange={(event) =>
                                                        setPoint({
                                                            ...point,
                                                            x: Number(event.target.value),
                                                        })
                                                    }
                                                />
                                            </label>
                                            <label className={rowLabel}>
                                                Y
                                                <input
                                                    className={field}
                                                    type="number"
                                                    min="0"
                                                    max={screen ? screen.height - 1 : undefined}
                                                    value={point.y}
                                                    onChange={(event) =>
                                                        setPoint({
                                                            ...point,
                                                            y: Number(event.target.value),
                                                        })
                                                    }
                                                />
                                            </label>
                                            <button className={rowButton} disabled={busy || !browser || !screen}>
                                                Click
                                            </button>
                                        </form>
                                        <form
                                            className={row}
                                            onSubmit={(event) => {
                                                event.preventDefault();
                                                const value = text;
                                                setText('');
                                                void action('human_type', { text: value });
                                            }}
                                        >
                                            <input
                                                className={rowField}
                                                type="password"
                                                aria-label="Text to type into computer"
                                                placeholder="Type into focused field"
                                                autoComplete="off"
                                                value={text}
                                                maxLength={20000}
                                                onChange={(event) => setText(event.target.value)}
                                            />
                                            <button className={rowButton} disabled={busy || !browser || !text}>
                                                Type
                                            </button>
                                        </form>
                                        <form
                                            className={row}
                                            onSubmit={(event) => {
                                                event.preventDefault();
                                                void action('human_key', { key });
                                            }}
                                        >
                                            <select
                                                className={rowField}
                                                aria-label="Key to press"
                                                value={key}
                                                onChange={(event) => setKey(event.target.value)}
                                            >
                                                {[
                                                    'Enter',
                                                    'Tab',
                                                    'Escape',
                                                    'Backspace',
                                                    'ArrowUp',
                                                    'ArrowDown',
                                                    'ArrowLeft',
                                                    'ArrowRight',
                                                ].map((name) => (
                                                    <option key={name}>{name}</option>
                                                ))}
                                            </select>
                                            <button className={rowButton} disabled={busy || !browser}>
                                                Press key
                                            </button>
                                        </form>
                                        <div className={actions}>
                                            <button
                                                className={button}
                                                disabled={busy || !browser}
                                                onClick={() => void action('human_scroll', { deltaY: -500 })}
                                            >
                                                Scroll up
                                            </button>
                                            <button
                                                className={button}
                                                disabled={busy || !browser}
                                                onClick={() => void action('human_scroll', { deltaY: 500 })}
                                            >
                                                Scroll down
                                            </button>
                                        </div>
                                    </details>
                                )}
                            </section>
                            <details className={section} open hidden={tab !== 'Files'}>
                                <summary className={summary}>Workspace files</summary>
                                <p className={para}>
                                    Paths are relative to your private home on this socio’s computer. Use shared/
                                    explicitly for company files.
                                </p>
                                <label className={label}>
                                    Path
                                    <input
                                        className={field}
                                        value={path}
                                        onChange={(event) => setPath(event.target.value)}
                                        placeholder="notes.txt"
                                        disabled={!running || !status.permissions.files || busy}
                                    />
                                </label>
                                <div className={actions}>
                                    <button
                                        className={button}
                                        disabled={!running || !status.permissions.files || busy}
                                        onClick={() => void action('files_list', { path }, true)}
                                    >
                                        List files
                                    </button>
                                    <button
                                        className={button}
                                        disabled={!running || !status.permissions.files || busy || !path.trim()}
                                        onClick={() =>
                                            void action('files_read', { path }, true).then((result) => {
                                                if (
                                                    lifecycle.current.active &&
                                                    result &&
                                                    typeof result === 'object' &&
                                                    'text' in result &&
                                                    typeof result.text === 'string'
                                                ) {
                                                    setContents(result.text);
                                                }
                                            })
                                        }
                                    >
                                        Read file
                                    </button>
                                </div>
                                <label className={label}>
                                    File contents
                                    <textarea
                                        className={textarea}
                                        aria-label="File contents to save"
                                        value={contents}
                                        onChange={(event) => setContents(event.target.value)}
                                        disabled={!running || !status.permissions.files || busy}
                                        maxLength={100000}
                                        rows={5}
                                    />
                                </label>
                                <button
                                    className={button}
                                    disabled={!running || !status.permissions.files || busy || !path.trim()}
                                    onClick={() => void action('files_write', { path, contents }, true)}
                                >
                                    Save file (replace contents)
                                </button>
                                {!status.permissions.files && (
                                    <p className={para}>Enable Workspace files permission to use these controls.</p>
                                )}
                            </details>
                            <details className={section} open hidden={tab !== 'Terminal'}>
                                <summary className={summary}>Terminal</summary>
                                <p className={para}>
                                    Runs inside this socio’s computer. Commands stop after 30 seconds.
                                </p>
                                <form
                                    onSubmit={(event) => {
                                        event.preventDefault();
                                        void action('exec', { command, timeoutMs: 30000 }, true);
                                    }}
                                >
                                    <textarea
                                        className={textarea}
                                        aria-label="Terminal command"
                                        value={command}
                                        onChange={(event) => setCommand(event.target.value)}
                                        maxLength={8000}
                                        rows={3}
                                        disabled={!running || !status.permissions.shell || busy}
                                        placeholder="pwd"
                                    />
                                    <button
                                        className={button}
                                        disabled={!running || !status.permissions.shell || busy || !command.trim()}
                                    >
                                        Run command
                                    </button>
                                </form>
                                {!status.permissions.shell && (
                                    <p className={para}>Enable Terminal commands permission to run commands.</p>
                                )}
                            </details>
                            {(output || outputError) && (tab === 'Files' || tab === 'Terminal') && (
                                <section className={section}>
                                    <h3 className="mt-0 mb-2.5 text-[13px]">Output</h3>
                                    {outputError && (
                                        <p className={errorLine} role="alert">
                                            {outputError}
                                        </p>
                                    )}
                                    {output && (
                                        <pre
                                            className="max-h-75 overflow-auto bg-[#eef0f4] p-2.5 text-[11px] whitespace-pre-wrap text-[#243044] [overflow-wrap:anywhere] dark:bg-[#27282a] dark:text-[#d2e2fc]"
                                            tabIndex={0}
                                        >
                                            {output}
                                        </pre>
                                    )}
                                    <button
                                        className={button}
                                        onClick={() => {
                                            setOutput('');
                                            setOutputError('');
                                        }}
                                    >
                                        Clear output
                                    </button>
                                </section>
                            )}
                        </>
                    )}
                    {coding && (
                        <section className={section} hidden={tab !== 'Coding'} aria-label="Coding sessions">
                            <CodingSandboxList dotId={dot.id} active={tab === 'Coding'} />
                        </section>
                    )}
                    <details className={section} open hidden={tab !== 'Activity'}>
                        <summary className={summary}>Recent activity</summary>
                        {status.audit.length ? (
                            <ol className="my-2 list-none p-0">
                                {status.audit
                                    .slice(-30)
                                    .reverse()
                                    .map((entry) => (
                                        <li key={entry.id} className="border-b border-b-border py-2">
                                            <strong>{entry.action.replaceAll('_', ' ')}</strong>
                                            <span className={cn('block', hint)}>
                                                {entry.actor} · {entry.outcome} ·{' '}
                                                {new Date(entry.createdAt).toLocaleTimeString()}
                                            </span>
                                        </li>
                                    ))}
                            </ol>
                        ) : (
                            <p className={para}>No computer actions yet.</p>
                        )}
                    </details>
                    <details className="mt-5 border-t border-t-[#e5e5e5] pt-2.5 text-[#666] dark:border-t-[#343434] dark:text-[#b2b2b2]">
                        <summary className={summary}>Computer settings</summary>{' '}
                        <details className="py-2" open={!status.permissions.enabled}>
                            <summary className={summary}>Computer permissions</summary>
                            <p className={para}>
                                {admin
                                    ? `Choose what ${dot.name} and the computer controls can access.`
                                    : 'Only an admin can change computer permissions.'}
                            </p>
                            {(['enabled', 'browser', 'files', 'shell'] as const).map((permission) => (
                                <label key={permission} className="my-2 flex items-center gap-2">
                                    <input
                                        className={cn(focusRing, 'size-4 flex-none p-0')}
                                        type="checkbox"
                                        checked={status.permissions[permission]}
                                        disabled={busy || !status.configured || !admin}
                                        onChange={(event) =>
                                            void run('/permissions', { [permission]: event.target.checked }, 'PATCH')
                                        }
                                    />
                                    {
                                        {
                                            enabled: 'Enable this computer',
                                            browser: 'Browser',
                                            files: 'Workspace files',
                                            shell: 'Terminal commands',
                                        }[permission]
                                    }
                                </label>
                            ))}
                        </details>
                        <div className={actions}>
                            <button
                                className={button}
                                disabled={
                                    busy ||
                                    !status.configured ||
                                    !status.permissions.enabled ||
                                    status.state === 'running'
                                }
                                onClick={() => void run('/start')}
                            >
                                Start computer
                            </button>
                            <button
                                className={button}
                                disabled={busy || status.state !== 'running'}
                                onClick={() => void run('/stop')}
                            >
                                Stop computer
                            </button>
                        </div>
                        <p className={cn(para, hint)}>
                            Stopping retains this socio’s workspace files. Browser sessions may require signing in
                            again.
                        </p>
                    </details>
                </>
            )}
        </section>
    );
}

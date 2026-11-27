import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';

import { useTranslation } from '@socio/i18n/react';
import {
    ROOM_PIN_CHARS,
    type RoomNotesView,
    type RoomPinOutcome,
    type RoomPinVersion,
    type RoomPinsState,
} from '@socio/shared/rooms/room-pins';

import { LocalTime } from '../../lib/local-time';
import { useShell } from '../../shell/shell-context';

import { failure, pinsApi } from './api';
import { openedOnDemand } from './RoomDialogs';
import { touchTarget } from './touch';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

/** How often an open panel reads the room's pins again. */
export const ROOM_PINS_POLL_MS = 10_000;

/** "Oct 12", in the reader's words once hydrated. */
function useDay() {
    const { t } = useTranslation(['rooms.pins']);
    return (value: number) => t('rooms.pins:day', { at: new Date(value) });
}

/**
 * A room's pinned facts while its panel is open (`GET /api/rooms/:id/pins`):
 * read as it opens, every `ROOM_PINS_POLL_MS` while the tab shows, and
 * after each change, whose answer is shown at once.
 */
export function useRoomPins(roomId: string, open: boolean) {
    const { t } = useTranslation(['rooms.pins']);
    const [state, setState] = useState<RoomPinsState>();
    const [error, setError] = useState('');
    const reads = useRef(0);
    const load = useCallback(async () => {
        const read = (reads.current += 1);
        try {
            const next = await pinsApi.state(roomId);
            if (read === reads.current) {
                setState(next);
                setError('');
            }
        } catch (cause) {
            if (read === reads.current) {
                setError(failure(cause, t('rooms.pins:load-failed')));
            }
        }
    }, [roomId, t]);
    useEffect(() => {
        if (!open) {
            return;
        }
        void load();
        const timer = setInterval(() => {
            if (!document.hidden) {
                void load();
            }
        }, ROOM_PINS_POLL_MS);
        return () => clearInterval(timer);
    }, [open, load]);
    const update = useCallback((next: RoomPinsState) => {
        reads.current += 1;
        setState(next);
    }, []);
    return { state, error, reload: load, update };
}

/** What a change did, for its toast. */
const SAID_KEYS = {
    pinned: 'rooms.pins:outcome.pinned',
    proposed: 'rooms.pins:outcome.proposed',
    unchanged: 'rooms.pins:outcome.unchanged',
    done: 'rooms.pins:outcome.done',
} as const satisfies Record<RoomPinOutcome['outcome'], string>;

/**
 * A room's pinned facts and notes (CB-217), in a panel beside the room
 * (the whole width on a phone). Pinned facts go with every message to the
 * room's socio, word for word. Room admins pin, edit and unpin; a pin's
 * original pinner edits and unpins their own; every member proposes, from
 * their own words or the facts the room's notes kept. Each pin's history
 * says who did what, and when. The notes Socio keeps as the room gets
 * long are shown as they are, with their versions.
 */
function Pins({
    roomId,
    open,
    onOpenChange,
    returnFocus,
}: {
    roomId: string;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    returnFocus?: () => HTMLElement | null | undefined;
}) {
    const { t } = useTranslation(['rooms.pins']);
    const { state, error, reload, update } = useRoomPins(roomId, open);
    const [busy, setBusy] = useState(false);
    const run = async (work: () => Promise<RoomPinOutcome>, fallback: string) => {
        setBusy(true);
        try {
            const answer = await work();
            update(answer.state);
            toast.success(t(SAID_KEYS[answer.outcome]));
            return true;
        } catch (cause) {
            toast.error(failure(cause, fallback));
            void reload();
            return false;
        } finally {
            setBusy(false);
        }
    };
    return (
        <Sheet open={open} onOpenChange={onOpenChange}>
            <SheetContent
                data-slot="room-pins"
                // Escape in a pin being edited cancels the edit only (FactForm);
                // the panel's own listener runs first, so it is told here
                // (CB-219).
                onEscapeKeyDown={(event) => {
                    if (event.target instanceof Element && event.target.closest('[data-pin-editing]')) {
                        event.preventDefault();
                    }
                }}
                onCloseAutoFocus={(event) => {
                    const target = returnFocus?.();
                    if (!target) {
                        return;
                    }
                    event.preventDefault();
                    target.focus();
                }}
                className="w-full gap-0 overflow-y-auto sm:max-w-md"
            >
                <SheetHeader className="border-b pr-12">
                    <SheetTitle>{t('rooms.pins:title')}</SheetTitle>
                    <SheetDescription>
                        {t('rooms.pins:description', {
                            context: !state
                                ? 'loading'
                                : state.can.manage
                                  ? 'manage'
                                  : state.can.propose
                                    ? 'propose'
                                    : undefined,
                        })}
                    </SheetDescription>
                </SheetHeader>
                {error && !state && (
                    <p role="alert" className="p-4 text-sm text-destructive">
                        {error}
                    </p>
                )}
                {!state && !error && <p className="p-4 text-sm text-muted-foreground">{t('rooms.pins:loading')}</p>}
                {state && (
                    <>
                        <Section title={t('rooms.pins:pinned', { pins: state.quota.pins, max: state.quota.maxPins })}>
                            {state.pins.length ? (
                                <ul className="grid gap-2" aria-label={t('rooms.pins:pinned-list')}>
                                    {state.pins.map((pin) => (
                                        <PinRow
                                            key={pin.id}
                                            roomId={roomId}
                                            pin={pin}
                                            state={state}
                                            busy={busy}
                                            run={run}
                                        />
                                    ))}
                                </ul>
                            ) : (
                                <p className="text-sm text-muted-foreground">{t('rooms.pins:nothing')}</p>
                            )}
                            <p className="text-xs text-muted-foreground">
                                {t('rooms.pins:chars', { chars: state.quota.chars, max: state.quota.maxChars })}
                            </p>
                        </Section>
                        {state.can.propose && (
                            <Section
                                title={state.can.manage ? t('rooms.pins:pin-a-fact') : t('rooms.pins:propose-a-fact')}
                            >
                                <FactForm
                                    label={state.can.manage ? t('rooms.pins:pin') : t('rooms.pins:propose')}
                                    busy={busy}
                                    onSubmit={(text) =>
                                        run(() => pinsApi.pin(roomId, text), t('rooms.pins:pin-failed'))
                                    }
                                />
                            </Section>
                        )}
                        {state.proposals.length > 0 && (
                            <Section title={t('rooms.pins:proposed', { n: state.proposals.length })}>
                                <ul className="grid gap-2" aria-label={t('rooms.pins:proposed-list')}>
                                    {state.proposals.map((proposal) => (
                                        <ProposalRow
                                            key={proposal.id}
                                            roomId={roomId}
                                            proposal={proposal}
                                            state={state}
                                            busy={busy}
                                            run={run}
                                        />
                                    ))}
                                </ul>
                            </Section>
                        )}
                        <NotesSection roomId={roomId} notes={state.notes} state={state} busy={busy} run={run} />
                    </>
                )}
            </SheetContent>
        </Sheet>
    );
}
export const PinsPanel = openedOnDemand(['rooms.pins'], Pins);

function Section({ title, children }: { title: string; children: ReactNode }) {
    const id = useId();
    return (
        <section aria-labelledby={id} className="grid gap-2 border-b p-4">
            <h3 id={id} className="text-sm font-semibold">
                {title}
            </h3>
            {children}
        </section>
    );
}

type Run = (work: () => Promise<RoomPinOutcome>, fallback: string) => Promise<boolean>;

/** The reader may edit and unpin this pin: a room admin, or its pinner. */
function mayChange(state: RoomPinsState, pin: RoomPinVersion, me: string) {
    return state.can.propose && (state.can.manage || pin.pinnedBy === me);
}

/** One pinned fact: its words, who pinned it, and what the reader may do. */
function PinRow({
    roomId,
    pin,
    state,
    busy,
    run,
}: {
    roomId: string;
    pin: RoomPinVersion;
    state: RoomPinsState;
    busy: boolean;
    run: Run;
}) {
    const { t } = useTranslation(['rooms.pins']);
    const day = useDay();
    const me = useShell().workspace.user.id;
    const [editing, setEditing] = useState(false);
    const [history, setHistory] = useState(false);
    const change = mayChange(state, pin, me);
    // An edit done or canceled: focus goes back to its Edit (CB-219).
    const editButton = useRef<HTMLButtonElement>(null);
    const edited = useRef(false);
    useEffect(() => {
        if (editing) {
            edited.current = true;
        } else if (edited.current) {
            edited.current = false;
            editButton.current?.focus();
        }
    }, [editing]);
    return (
        <li data-room-pin={pin.pinId} className="grid gap-1.5 rounded-md border bg-card px-3 py-2">
            {editing ? (
                <FactForm
                    label={change ? t('rooms.pins:pin-row.save') : t('rooms.pins:pin-row.propose-change')}
                    initial={pin.text}
                    autoFocus
                    busy={busy}
                    onCancel={() => setEditing(false)}
                    onSubmit={async (text) => {
                        const ok = await run(
                            () => pinsApi.edit(roomId, pin.pinId, text, pin.version ?? 1),
                            t('rooms.pins:pin-row.change-failed'),
                        );
                        if (ok) {
                            setEditing(false);
                        }
                        return ok;
                    }}
                />
            ) : (
                <p className="m-0 text-sm [overflow-wrap:anywhere]">{pin.text}</p>
            )}
            <p className="m-0 text-xs text-muted-foreground">
                {t('rooms.pins:pin-row.pinned-by', {
                    name: pin.pinnedByName ?? t('rooms.pins:former-member'),
                    context: pin.pinnedBy === me ? 'you' : undefined,
                })}
                {pin.version && pin.version > 1 ? (
                    <>
                        {' · '}
                        {t('rooms.pins:pin-row.version', { version: pin.version })}
                    </>
                ) : null}
                {pin.decidedAt ? (
                    <>
                        {' · '}
                        <LocalTime value={pin.decidedAt} format={day} />
                    </>
                ) : null}
                {pin.origin === 'notes' ? (
                    <>
                        {' · '}
                        {t('rooms.pins:pin-row.from-notes')}
                    </>
                ) : null}
            </p>
            {!editing && (
                <div className="flex flex-wrap gap-1.5">
                    {state.can.propose && (
                        <Button
                            ref={editButton}
                            size="sm"
                            variant="outline"
                            className={touchTarget}
                            disabled={busy}
                            onClick={() => setEditing(true)}
                        >
                            {change ? t('rooms.pins:pin-row.edit') : t('rooms.pins:pin-row.suggest')}
                        </Button>
                    )}
                    {change && (
                        <Button
                            size="sm"
                            variant="outline"
                            className={touchTarget}
                            disabled={busy}
                            onClick={() =>
                                void run(
                                    () => pinsApi.unpin(roomId, pin.pinId, pin.version ?? 1),
                                    t('rooms.pins:pin-row.unpin-failed'),
                                )
                            }
                        >
                            {t('rooms.pins:pin-row.unpin')}
                        </Button>
                    )}
                    <Button
                        size="sm"
                        variant="ghost"
                        className={touchTarget}
                        aria-expanded={history}
                        onClick={() => setHistory(!history)}
                    >
                        {history ? t('rooms.pins:pin-row.hide-history') : t('rooms.pins:pin-row.history')}
                    </Button>
                </div>
            )}
            {history && <PinHistory roomId={roomId} pinId={pin.pinId} key={pin.id} />}
        </li>
    );
}

const STATUS_KEYS = {
    proposed: 'rooms.pins:status.proposed',
    pinned: 'rooms.pins:status.pinned',
    superseded: 'rooms.pins:status.superseded',
    unpinned: 'rooms.pins:status.unpinned',
    rejected: 'rooms.pins:status.rejected',
    withdrawn: 'rooms.pins:status.withdrawn',
} as const satisfies Record<RoomPinVersion['status'], string>;

/** Who did what to a version, in one line: its `versionLine`. */
export function useVersionLine() {
    const { t } = useTranslation(['rooms.pins']);
    return (row: RoomPinVersion) => {
        const who = (name: string | null) => name ?? t('rooms.pins:former-member');
        const parts: string[] = [
            row.decidedBy === row.proposedBy && row.version !== null
                ? row.version === 1
                    ? t('rooms.pins:line.pinned', { name: who(row.proposedByName) })
                    : t('rooms.pins:line.edited', { name: who(row.proposedByName) })
                : t('rooms.pins:line.proposed', { name: who(row.proposedByName) }),
        ];
        if (row.decidedBy && row.decidedBy !== row.proposedBy) {
            parts.push(
                row.status === 'rejected'
                    ? t('rooms.pins:line.turned-down', { name: who(row.decidedByName) })
                    : t('rooms.pins:line.approved', { name: who(row.decidedByName) }),
            );
        }
        if (row.endedBy && row.status !== 'withdrawn') {
            parts.push(
                row.status === 'unpinned'
                    ? t('rooms.pins:line.unpinned', { name: who(row.endedByName) })
                    : t('rooms.pins:line.replaced', { name: who(row.endedByName) }),
            );
        }
        return t('rooms.pins:line.joined', { parts });
    };
}

/** A pin's versions and proposals, newest first, with who and when. */
function PinHistory({ roomId, pinId }: { roomId: string; pinId: string }) {
    const { t } = useTranslation(['rooms.pins']);
    const day = useDay();
    const versionLine = useVersionLine();
    const [rows, setRows] = useState<RoomPinVersion[]>();
    const [error, setError] = useState('');
    useEffect(() => {
        const controller = new AbortController();
        pinsApi
            .history(roomId, pinId, controller.signal)
            .then((next) => !controller.signal.aborted && setRows(next))
            .catch((cause: unknown) => {
                if (!controller.signal.aborted) {
                    setError(failure(cause, t('rooms.pins:history.failed')));
                }
            });
        return () => controller.abort();
    }, [roomId, pinId, t]);
    if (error) {
        return (
            <p role="alert" className="m-0 text-xs text-destructive">
                {error}
            </p>
        );
    }
    if (!rows) {
        return <p className="m-0 text-xs text-muted-foreground">{t('rooms.pins:loading')}</p>;
    }
    return (
        <ol
            aria-label={t('rooms.pins:history.list')}
            data-slot="room-pin-history"
            className="m-0 grid list-none gap-1.5 border-t p-0 pt-2"
        >
            {rows.map((row) => (
                <li key={row.id} className="grid gap-0.5 text-xs">
                    <span className="flex flex-wrap items-center gap-1.5">
                        <Badge variant="outline">
                            {row.version
                                ? t('rooms.pins:history.version', { version: row.version })
                                : t('rooms.pins:history.proposal')}
                        </Badge>
                        <span className="text-muted-foreground">{t(STATUS_KEYS[row.status])}</span>
                        <LocalTime
                            className="ml-auto text-muted-foreground tabular-nums"
                            value={row.endedAt ?? row.decidedAt ?? row.proposedAt}
                            format={day}
                        />
                    </span>
                    <span className="[overflow-wrap:anywhere]">{row.text}</span>
                    <span className="text-muted-foreground">{versionLine(row)}</span>
                </li>
            ))}
        </ol>
    );
}

/** A proposal: room admins approve or turn it down, its proposer withdraws. */
function ProposalRow({
    roomId,
    proposal,
    state,
    busy,
    run,
}: {
    roomId: string;
    proposal: RoomPinVersion;
    state: RoomPinsState;
    busy: boolean;
    run: Run;
}) {
    const { t } = useTranslation(['rooms.pins']);
    const day = useDay();
    const me = useShell().workspace.user.id;
    const changes = proposal.supersedes ? state.pins.find((pin) => pin.pinId === proposal.pinId) : undefined;
    const decide = (action: 'approve' | 'reject' | 'withdraw', fallback: string) =>
        void run(() => pinsApi.decide(roomId, proposal.id, action), fallback);
    return (
        <li data-room-pin-proposal={proposal.id} className="grid gap-1.5 rounded-md border border-dashed px-3 py-2">
            <p className="m-0 text-sm [overflow-wrap:anywhere]">{proposal.text}</p>
            <p className="m-0 text-xs text-muted-foreground">
                {t('rooms.pins:proposal.proposed-by', {
                    name: proposal.proposedByName ?? t('rooms.pins:former-member'),
                    context: proposal.proposedBy === me ? 'you' : undefined,
                })}
                {proposal.supersedes ? (
                    <>
                        {' · '}
                        {changes
                            ? t('rooms.pins:proposal.changes', { text: changes.text })
                            : t('rooms.pins:proposal.changes-stale')}
                    </>
                ) : null}
                {' · '}
                <LocalTime value={proposal.proposedAt} format={day} />
            </p>
            {state.can.propose && (
                <div className="flex flex-wrap gap-1.5">
                    {state.can.manage && (
                        <>
                            <Button
                                size="sm"
                                className={touchTarget}
                                disabled={busy}
                                onClick={() => decide('approve', t('rooms.pins:proposal.approve-failed'))}
                            >
                                {t('rooms.pins:proposal.approve')}
                            </Button>
                            <Button
                                size="sm"
                                variant="outline"
                                className={touchTarget}
                                disabled={busy}
                                onClick={() => decide('reject', t('rooms.pins:proposal.turn-down-failed'))}
                            >
                                {t('rooms.pins:proposal.turn-down')}
                            </Button>
                        </>
                    )}
                    {proposal.proposedBy === me && (
                        <Button
                            size="sm"
                            variant="outline"
                            className={touchTarget}
                            disabled={busy}
                            onClick={() => decide('withdraw', t('rooms.pins:proposal.withdraw-failed'))}
                        >
                            {t('rooms.pins:proposal.withdraw')}
                        </Button>
                    )}
                </div>
            )}
        </li>
    );
}

/**
 * One fact's words: Enter submits (a fact is one line), Escape cancels an
 * edit.
 */
function FactForm({
    label,
    initial = '',
    autoFocus,
    busy,
    onSubmit,
    onCancel,
}: {
    label: string;
    initial?: string;
    /** An edit: its words take the focus as it opens. */
    autoFocus?: boolean;
    busy: boolean;
    onSubmit: (text: string) => Promise<boolean>;
    onCancel?: () => void;
}) {
    const { t } = useTranslation(['rooms.pins']);
    const [text, setText] = useState(initial);
    const id = useId();
    const submit = async () => {
        const trimmed = text.trim();
        if (!trimmed || busy) {
            return;
        }
        if ((await onSubmit(trimmed)) && !onCancel) {
            setText('');
        }
    };
    return (
        <form
            className="grid gap-2"
            data-pin-editing={onCancel ? '' : undefined}
            onSubmit={(event) => {
                event.preventDefault();
                void submit();
            }}
        >
            <label htmlFor={id} className="sr-only">
                {t('rooms.pins:fact.label')}
            </label>
            <Textarea
                id={id}
                autoFocus={autoFocus}
                rows={2}
                maxLength={ROOM_PIN_CHARS}
                placeholder={t('rooms.pins:fact.placeholder')}
                value={text}
                onChange={(event) => setText(event.target.value)}
                onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                        event.preventDefault();
                        void submit();
                    }
                    if (event.key === 'Escape' && onCancel) {
                        event.preventDefault();
                        event.stopPropagation();
                        onCancel();
                    }
                }}
            />
            <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 text-xs text-muted-foreground">
                    {t('rooms.pins:fact.limit', { max: ROOM_PIN_CHARS })}
                </span>
                {onCancel && (
                    <Button type="button" size="sm" variant="ghost" className={touchTarget} onClick={onCancel}>
                        {t('rooms.pins:fact.cancel')}
                    </Button>
                )}
                <Button type="submit" size="sm" className={touchTarget} disabled={busy || !text.trim()}>
                    {label}
                </Button>
            </div>
        </form>
    );
}

/**
 * The notes Socio keeps on the room's earlier part, once it is long: the
 * summary and facts every socio in the room reads, and their versions.
 * Each fact can be pinned (or proposed), as it is.
 */
function NotesSection({
    roomId,
    notes,
    state,
    busy,
    run,
}: {
    roomId: string;
    notes: RoomNotesView;
    state: RoomPinsState;
    busy: boolean;
    run: Run;
}) {
    const { t } = useTranslation(['rooms.pins']);
    const day = useDay();
    const current = notes.current;
    const pinned = new Set(state.pins.map((pin) => pin.text.toLowerCase()));
    return (
        <Section title={t('rooms.pins:notes.title')}>
            {!current ? (
                <p className="text-sm text-muted-foreground">{t('rooms.pins:notes.none')}</p>
            ) : (
                <>
                    <p className="m-0 text-xs text-muted-foreground">
                        {t('rooms.pins:notes.current', { version: current.version, count: current.turns })}
                        {' · '}
                        <LocalTime value={current.updatedAt} format={day} />
                    </p>
                    <p
                        data-slot="room-notes-summary"
                        className="m-0 text-sm whitespace-pre-wrap [overflow-wrap:anywhere]"
                    >
                        {current.summary}
                    </p>
                    {current.facts.length > 0 && (
                        <ul className="m-0 grid list-none gap-1 p-0" aria-label={t('rooms.pins:notes.facts')}>
                            {current.facts.map((fact) => (
                                <li key={fact} className="flex items-start gap-2 text-sm [overflow-wrap:anywhere]">
                                    <span className="min-w-0 flex-1">{fact}</span>
                                    {state.can.propose && !pinned.has(fact.toLowerCase()) && (
                                        <Button
                                            size="sm"
                                            variant="ghost"
                                            className={cn('h-7 shrink-0', touchTarget)}
                                            disabled={busy}
                                            aria-label={
                                                state.can.manage
                                                    ? t('rooms.pins:notes.pin-fact', { fact })
                                                    : t('rooms.pins:notes.propose-fact', { fact })
                                            }
                                            onClick={() =>
                                                void run(
                                                    () => pinsApi.pin(roomId, fact, 'notes'),
                                                    t('rooms.pins:pin-failed'),
                                                )
                                            }
                                        >
                                            {state.can.manage ? t('rooms.pins:pin') : t('rooms.pins:propose')}
                                        </Button>
                                    )}
                                </li>
                            ))}
                        </ul>
                    )}
                </>
            )}
            {notes.versions.length > 0 && (
                <details data-slot="room-notes-versions">
                    {/* 44 px tall on a touch screen, keeping its marker. */}
                    <summary className="cursor-pointer text-xs font-medium pointer-coarse:py-3.5">
                        {t('rooms.pins:notes.versions', { n: notes.versions.length })}
                    </summary>
                    <ol className="m-0 mt-2 grid list-none gap-1 p-0 text-xs text-muted-foreground">
                        {notes.versions.map((version) => (
                            <li key={version.version}>
                                {t('rooms.pins:notes.version-turns', {
                                    version: version.version,
                                    from: version.fromTurns + 1,
                                    to: version.turns,
                                })}
                                {version.dotName ? (
                                    <>
                                        {' · '}
                                        {t('rooms.pins:notes.by', { name: version.dotName })}
                                    </>
                                ) : null}
                                {version.actingName ? (
                                    <> {t('rooms.pins:notes.in-turn', { name: version.actingName })}</>
                                ) : null}
                                {version.method === 'fallback' ? (
                                    <>
                                        {' · '}
                                        {t('rooms.pins:notes.fallback')}
                                    </>
                                ) : null}
                                {' · '}
                                <LocalTime value={version.at} format={day} />
                            </li>
                        ))}
                    </ol>
                </details>
            )}
        </Section>
    );
}

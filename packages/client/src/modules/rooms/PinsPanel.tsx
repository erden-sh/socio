import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';

import { formatNumber } from '@socio/shared/locale';
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
import { touchTarget } from './touch';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

/** How often an open panel reads the room's pins again. */
export const ROOM_PINS_POLL_MS = 10_000;

/** "Oct 12", in the reader's words once hydrated. */
const day = (value: number) =>
    new Date(value).toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
    });

/**
 * A room's pinned facts while its panel is open (`GET /api/rooms/:id/pins`):
 * read as it opens, every `ROOM_PINS_POLL_MS` while the tab shows, and
 * after each change, whose answer is shown at once.
 */
export function useRoomPins(roomId: string, open: boolean) {
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
                setError(failure(cause, 'Could not load the pinned facts.'));
            }
        }
    }, [roomId]);
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
const said: Record<RoomPinOutcome['outcome'], string> = {
    pinned: 'Pinned. The socio reads it from the next message.',
    proposed: 'Proposed. A room admin decides whether to pin it.',
    unchanged: 'That is pinned or proposed already.',
    done: 'Done.',
};

/**
 * A room's pinned facts and notes (CB-217), in a panel beside the room
 * (the whole width on a phone). Pinned facts go with every message to the
 * room's socio, word for word. Room admins pin, edit and unpin; a pin's
 * original pinner edits and unpins their own; every member proposes, from
 * their own words or the facts the room's notes kept. Each pin's history
 * says who did what, and when. The notes Socio keeps as the room gets
 * long are shown as they are, with their versions.
 */
export function PinsPanel({
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
    const { state, error, reload, update } = useRoomPins(roomId, open);
    const [busy, setBusy] = useState(false);
    const run = async (work: () => Promise<RoomPinOutcome>, fallback: string) => {
        setBusy(true);
        try {
            const answer = await work();
            update(answer.state);
            toast.success(said[answer.outcome]);
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
                    <SheetTitle>Pinned facts</SheetTitle>
                    <SheetDescription>
                        {!state
                            ? 'Facts the room’s socio reads with every message.'
                            : state.can.manage
                              ? 'The socio reads these with every message. As a room admin you pin, edit and unpin them, and decide what others propose.'
                              : state.can.propose
                                ? 'The socio reads these with every message. Propose a fact and a room admin decides; you can edit or unpin the ones you pinned.'
                                : 'The socio reads these with every message. This room is read-only now, so nothing changes here.'}
                    </SheetDescription>
                </SheetHeader>
                {error && !state && (
                    <p role="alert" className="p-4 text-sm text-destructive">
                        {error}
                    </p>
                )}
                {!state && !error && <p className="p-4 text-sm text-muted-foreground">Loading…</p>}
                {state && (
                    <>
                        <Section title={`Pinned (${state.quota.pins} of ${state.quota.maxPins})`}>
                            {state.pins.length ? (
                                <ul className="grid gap-2" aria-label="Pinned facts">
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
                                <p className="text-sm text-muted-foreground">Nothing pinned yet.</p>
                            )}
                            <p className="text-xs text-muted-foreground">
                                {`${formatNumber(state.quota.chars)} of ${formatNumber(state.quota.maxChars)} characters used.`}
                            </p>
                        </Section>
                        {state.can.propose && (
                            <Section title={state.can.manage ? 'Pin a fact' : 'Propose a fact'}>
                                <FactForm
                                    label={state.can.manage ? 'Pin' : 'Propose'}
                                    busy={busy}
                                    onSubmit={(text) => run(() => pinsApi.pin(roomId, text), 'Could not pin that.')}
                                />
                            </Section>
                        )}
                        {state.proposals.length > 0 && (
                            <Section title={`Proposed (${state.proposals.length})`}>
                                <ul className="grid gap-2" aria-label="Proposed facts">
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
                    label={change ? 'Save' : 'Propose change'}
                    initial={pin.text}
                    autoFocus
                    busy={busy}
                    onCancel={() => setEditing(false)}
                    onSubmit={async (text) => {
                        const ok = await run(
                            () => pinsApi.edit(roomId, pin.pinId, text, pin.version ?? 1),
                            'Could not change it.',
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
                {`Pinned by ${pin.pinnedBy === me ? 'you' : (pin.pinnedByName ?? 'a former member')}`}
                {pin.version && pin.version > 1 ? ` · version ${pin.version}` : ''}
                {pin.decidedAt ? (
                    <>
                        {' · '}
                        <LocalTime value={pin.decidedAt} format={day} />
                    </>
                ) : null}
                {pin.origin === 'notes' ? ' · from the notes' : ''}
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
                            {change ? 'Edit' : 'Suggest a change'}
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
                                    'Could not unpin it.',
                                )
                            }
                        >
                            Unpin
                        </Button>
                    )}
                    <Button
                        size="sm"
                        variant="ghost"
                        className={touchTarget}
                        aria-expanded={history}
                        onClick={() => setHistory(!history)}
                    >
                        {history ? 'Hide history' : 'History'}
                    </Button>
                </div>
            )}
            {history && <PinHistory roomId={roomId} pinId={pin.pinId} key={pin.id} />}
        </li>
    );
}

const statusWord: Record<RoomPinVersion['status'], string> = {
    proposed: 'Proposed',
    pinned: 'In use',
    superseded: 'Replaced',
    unpinned: 'Unpinned',
    rejected: 'Not pinned',
    withdrawn: 'Withdrawn',
};

/** Who did what to a version, in one line. */
export function versionLine(row: RoomPinVersion) {
    const who = (name: string | null) => name ?? 'a former member';
    const parts = [
        row.decidedBy === row.proposedBy && row.version !== null
            ? `${row.version === 1 ? 'Pinned' : 'Edited'} by ${who(row.proposedByName)}`
            : `Proposed by ${who(row.proposedByName)}`,
    ];
    if (row.decidedBy && row.decidedBy !== row.proposedBy) {
        parts.push(`${row.status === 'rejected' ? 'turned down' : 'approved'} by ${who(row.decidedByName)}`);
    }
    if (row.endedBy && row.status !== 'withdrawn') {
        parts.push(`${row.status === 'unpinned' ? 'unpinned' : 'replaced'} by ${who(row.endedByName)}`);
    }
    return parts.join(', ');
}

/** A pin's versions and proposals, newest first, with who and when. */
function PinHistory({ roomId, pinId }: { roomId: string; pinId: string }) {
    const [rows, setRows] = useState<RoomPinVersion[]>();
    const [error, setError] = useState('');
    useEffect(() => {
        const controller = new AbortController();
        pinsApi
            .history(roomId, pinId, controller.signal)
            .then((next) => !controller.signal.aborted && setRows(next))
            .catch((cause: unknown) => {
                if (!controller.signal.aborted) {
                    setError(failure(cause, 'Could not load its history.'));
                }
            });
        return () => controller.abort();
    }, [roomId, pinId]);
    if (error) {
        return (
            <p role="alert" className="m-0 text-xs text-destructive">
                {error}
            </p>
        );
    }
    if (!rows) {
        return <p className="m-0 text-xs text-muted-foreground">Loading…</p>;
    }
    return (
        <ol aria-label="History" data-slot="room-pin-history" className="m-0 grid list-none gap-1.5 border-t p-0 pt-2">
            {rows.map((row) => (
                <li key={row.id} className="grid gap-0.5 text-xs">
                    <span className="flex flex-wrap items-center gap-1.5">
                        <Badge variant="outline">{row.version ? `v${row.version}` : 'proposal'}</Badge>
                        <span className="text-muted-foreground">{statusWord[row.status]}</span>
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
    const me = useShell().workspace.user.id;
    const changes = proposal.supersedes ? state.pins.find((pin) => pin.pinId === proposal.pinId) : undefined;
    const decide = (action: 'approve' | 'reject' | 'withdraw', fallback: string) =>
        void run(() => pinsApi.decide(roomId, proposal.id, action), fallback);
    return (
        <li data-room-pin-proposal={proposal.id} className="grid gap-1.5 rounded-md border border-dashed px-3 py-2">
            <p className="m-0 text-sm [overflow-wrap:anywhere]">{proposal.text}</p>
            <p className="m-0 text-xs text-muted-foreground">
                {`Proposed by ${proposal.proposedBy === me ? 'you' : (proposal.proposedByName ?? 'a former member')}`}
                {proposal.supersedes
                    ? changes
                        ? ` · changes “${changes.text}”`
                        : ' · changes a pin that has changed since'
                    : ''}
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
                                onClick={() => decide('approve', 'Could not pin it.')}
                            >
                                Approve
                            </Button>
                            <Button
                                size="sm"
                                variant="outline"
                                className={touchTarget}
                                disabled={busy}
                                onClick={() => decide('reject', 'Could not turn it down.')}
                            >
                                Turn down
                            </Button>
                        </>
                    )}
                    {proposal.proposedBy === me && (
                        <Button
                            size="sm"
                            variant="outline"
                            className={touchTarget}
                            disabled={busy}
                            onClick={() => decide('withdraw', 'Could not withdraw it.')}
                        >
                            Withdraw
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
                The fact
            </label>
            <Textarea
                id={id}
                autoFocus={autoFocus}
                rows={2}
                maxLength={ROOM_PIN_CHARS}
                placeholder="Decision: launch on 3 November"
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
                    {`One fact, up to ${ROOM_PIN_CHARS} characters.`}
                </span>
                {onCancel && (
                    <Button type="button" size="sm" variant="ghost" className={touchTarget} onClick={onCancel}>
                        Cancel
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
    const current = notes.current;
    const pinned = new Set(state.pins.map((pin) => pin.text.toLowerCase()));
    return (
        <Section title="Notes on earlier messages">
            {!current ? (
                <p className="text-sm text-muted-foreground">
                    None yet. When the room gets long, Socio keeps notes on its earlier messages for everyone in it,
                    with who said what. They never hold what a socio found with someone’s own access.
                </p>
            ) : (
                <>
                    <p className="m-0 text-xs text-muted-foreground">
                        {`Version ${current.version}, covering the first ${current.turns} turns · `}
                        <LocalTime value={current.updatedAt} format={day} />
                    </p>
                    <p
                        data-slot="room-notes-summary"
                        className="m-0 text-sm whitespace-pre-wrap [overflow-wrap:anywhere]"
                    >
                        {current.summary}
                    </p>
                    {current.facts.length > 0 && (
                        <ul className="m-0 grid list-none gap-1 p-0" aria-label="Facts">
                            {current.facts.map((fact) => (
                                <li key={fact} className="flex items-start gap-2 text-sm [overflow-wrap:anywhere]">
                                    <span className="min-w-0 flex-1">{fact}</span>
                                    {state.can.propose && !pinned.has(fact.toLowerCase()) && (
                                        <Button
                                            size="sm"
                                            variant="ghost"
                                            className={cn('h-7 shrink-0', touchTarget)}
                                            disabled={busy}
                                            aria-label={`${state.can.manage ? 'Pin' : 'Propose'}: ${fact}`}
                                            onClick={() =>
                                                void run(
                                                    () => pinsApi.pin(roomId, fact, 'notes'),
                                                    'Could not pin that.',
                                                )
                                            }
                                        >
                                            {state.can.manage ? 'Pin' : 'Propose'}
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
                        {`Versions (${notes.versions.length})`}
                    </summary>
                    <ol className="m-0 mt-2 grid list-none gap-1 p-0 text-xs text-muted-foreground">
                        {notes.versions.map((version) => (
                            <li key={version.version}>
                                {`v${version.version} · turns ${version.fromTurns + 1}–${version.turns}`}
                                {version.dotName ? ` · by ${version.dotName}` : ''}
                                {version.actingName ? ` in ${version.actingName}’s turn` : ''}
                                {version.method === 'fallback' ? ' · kept plainly (the notes’ model failed)' : ''}
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

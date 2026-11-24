import { useEffect, useId, useState, type FormEvent, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';

import { ROOM_CONVERT_TEXT, roomEligibleSocio, type RoomInvite, type RoomPerson } from '@socio/shared/rooms/rooms';
import { MAX_CHAT_TITLE, type Conversation } from '@socio/shared/types';

import { LocalTime } from '../../lib/local-time';
import { useShell } from '../../shell/shell-context';

import { failure, roomsApi } from './api';
import { useFocusReturn } from './focus-return';
import { touchTarget } from './touch';

import { dialogSelect } from '@/components/form-fields';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';

/** The path of a room (or any conversation): rooms keep chats' links. */
export const roomPath = (id: string) => `/chats/${encodeURIComponent(id)}`;
/** A room's path with its Members panel open. */
export const membersPath = (id: string) => `${roomPath(id)}?members=1`;

/** "Oct 12", in the reader's words once hydrated. */
const day = (value: number) =>
    new Date(value).toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
    });

/** An error under a dialog's fields, said once as it shows. */
export function Problem({ children }: { children: ReactNode }) {
    if (!children) {
        return null;
    }
    return (
        <p
            role="alert"
            data-slot="room-problem"
            className="rounded-md bg-destructive/10 p-2.5 text-sm text-destructive"
        >
            {children}
        </p>
    );
}

/**
 * A form dialog: its title, a line on what it does, the fields, then
 * Cancel and the action. Escape and Cancel keep everything as it was;
 * nothing typed is lost on an error (the dialog stays open with it).
 */
export function FormDialog({
    open,
    onOpenChange,
    title,
    description,
    slot,
    action,
    busy,
    disabled,
    problem,
    onSubmit,
    children,
    focus: given,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    title: string;
    description: ReactNode;
    slot: string;
    action: string;
    busy: boolean;
    disabled?: boolean;
    problem: string;
    onSubmit: () => void;
    children: ReactNode;
    /** A dialog with a step after this one gives its own, for both. */
    focus?: ReturnType<typeof useFocusReturn>;
}) {
    const own = useFocusReturn();
    const focus = given ?? own;
    return (
        <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
            <DialogContent
                onCloseAutoFocus={focus.onCloseAutoFocus}
                data-slot={slot}
                className="max-h-[90svh] overflow-y-auto sm:max-w-md"
            >
                {focus.mark}
                <form
                    className="grid gap-4"
                    onSubmit={(event: FormEvent) => {
                        event.preventDefault();
                        if (!busy && !disabled) {
                            onSubmit();
                        }
                    }}
                >
                    <DialogHeader>
                        <DialogTitle>{title}</DialogTitle>
                        <DialogDescription>{description}</DialogDescription>
                    </DialogHeader>
                    {children}
                    <Problem>{problem}</Problem>
                    <DialogFooter>
                        <Button
                            type="button"
                            variant="outline"
                            className={touchTarget}
                            disabled={busy}
                            onClick={() => onOpenChange(false)}
                        >
                            Cancel
                        </Button>
                        <Button type="submit" className={touchTarget} disabled={busy || disabled}>
                            {action}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}

/** A labeled field: the label above, a hint under it. */
function Field({
    label,
    hint,
    children,
}: {
    label: string;
    hint?: ReactNode;
    children: (id: string, hintId?: string) => ReactNode;
}) {
    const id = useId();
    const hintId = hint ? `${id}-hint` : undefined;
    return (
        <div className="grid gap-1.5">
            <label htmlFor={id} className="text-sm font-medium">
                {label}
            </label>
            {children(id, hintId)}
            {hint && (
                <p id={hintId} className="text-xs text-muted-foreground">
                    {hint}
                </p>
            )}
        </div>
    );
}

/** A checkbox the action waits for: "I understand…". */
export function Confirm({
    checked,
    onChange,
    children,
}: {
    checked: boolean;
    onChange: (checked: boolean) => void;
    children: ReactNode;
}) {
    return (
        // The whole line is the checkbox's target: 44 px tall on a touch
        // screen (CB-219).
        <label className="flex cursor-pointer items-start gap-2.5 text-sm pointer-coarse:min-h-11 pointer-coarse:py-2.5">
            <Checkbox className="mt-0.5" checked={checked} onCheckedChange={(value) => onChange(value === true)} />
            <span>{children}</span>
        </label>
    );
}

/**
 * A multi-select checklist (CB-278): each row is a checkbox the size of a
 * finger on a touch screen, with the choice's name. Used for the further
 * socios and the initial people in the create-room dialog.
 */
function Checklist({
    choices,
    selected,
    onToggle,
    empty,
    renderLabel,
}: {
    choices: readonly { id: string; name: string }[];
    selected: readonly string[];
    onToggle: (id: string) => void;
    empty?: ReactNode;
    renderLabel?: (choice: { id: string; name: string }) => ReactNode;
}) {
    if (!choices.length) {
        return empty ? <p className="text-xs text-muted-foreground">{empty}</p> : null;
    }
    const set = new Set(selected);
    return (
        <ul className="grid max-h-48 gap-1 overflow-y-auto scroll-padding-bottom-8" data-slot="checklist">
            {choices.map((choice) => (
                <li key={choice.id}>
                    <label className="flex cursor-pointer items-start gap-2.5 text-sm pointer-coarse:min-h-11 pointer-coarse:py-2.5">
                        <Checkbox
                            className="mt-0.5"
                            checked={set.has(choice.id)}
                            onCheckedChange={() => onToggle(choice.id)}
                        />
                        <span>{renderLabel ? renderLabel(choice) : choice.name}</span>
                    </label>
                </li>
            ))}
        </ul>
    );
}

/**
 * A new room (CB-212, CB-278): its name, the company socio that answers in
 * it (the lead, and any further company socios), optional people to invite,
 * and an optional description. The maker is its first admin; then they
 * invite people.
 */
export function CreateRoomDialog({
    open,
    onOpenChange,
    onNavigate,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** Before it opens the new room (closes the mobile sidebar). */
    onNavigate?: () => void;
}) {
    const shell = useShell();
    const navigate = useNavigate();
    const socios = shell.workspace.dots.filter((dot) => roomEligibleSocio(dot));
    const [title, setTitle] = useState('');
    const [dotId, setDotId] = useState('');
    const [moreDotIds, setMoreDotIds] = useState<string[]>([]);
    const [people, setPeople] = useState<RoomPerson[]>([]);
    const [userIds, setUserIds] = useState<string[]>([]);
    const [description, setDescription] = useState('');
    const [busy, setBusy] = useState(false);
    const [problem, setProblem] = useState('');
    const chosen = socios.some((dot) => dot.id === dotId) ? dotId : (socios[0]?.id ?? '');
    // The further socios the maker may ask for: everyone eligible except the
    // lead. The lead is picked above; these start as `requested` for a
    // workspace admin to let in (CB-278).
    const further = socios.filter((dot) => dot.id !== chosen);
    // Load the people the maker may invite as the dialog opens (CB-278): a
    // workspace-wide list, since no room exists yet to call `/invitable` on.
    useEffect(() => {
        if (!open) {
            return;
        }
        const controller = new AbortController();
        roomsApi
            .inviteCandidates(controller.signal)
            .then(setPeople)
            .catch(() => {
                /* closed, or the request was aborted; nothing to do */
            });
        return () => controller.abort();
    }, [open]);
    const close = (next: boolean) => {
        onOpenChange(next);
        if (!next) {
            setProblem('');
            setMoreDotIds([]);
            setUserIds([]);
            setDescription('');
        }
    };
    return (
        <FormDialog
            open={open}
            onOpenChange={close}
            title="New room"
            slot="create-room"
            description="A room is one conversation for several people and company socios. Each message runs as the person who sent it; nobody’s private memories or data are shared."
            action={busy ? 'Creating…' : 'Create room'}
            busy={busy}
            disabled={!title.trim() || !chosen}
            problem={problem}
            onSubmit={async () => {
                setBusy(true);
                setProblem('');
                try {
                    const room = await roomsApi.create(chosen, title.trim(), {
                        dotIds: moreDotIds,
                        userIds,
                        description,
                    });
                    await shell.refresh();
                    onOpenChange(false);
                    setTitle('');
                    toast.success(`Created “${room.title}”. Invite people from Members.`);
                    onNavigate?.();
                    void navigate(membersPath(room.id));
                } catch (error) {
                    setProblem(failure(error, 'Could not create the room.'));
                } finally {
                    setBusy(false);
                }
            }}
        >
            <Field label="Name">
                {(id) => (
                    <Input
                        id={id}
                        value={title}
                        autoFocus
                        maxLength={MAX_CHAT_TITLE}
                        placeholder="Launch planning"
                        onChange={(event) => setTitle(event.target.value)}
                    />
                )}
            </Field>
            <Field
                label="Lead socio"
                hint={
                    socios.length
                        ? 'Company socios only. A room admin can ask for more later.'
                        : 'There is no company socio yet: ask an admin to add one.'
                }
            >
                {(id, hint) => (
                    <select
                        id={id}
                        data-slot="native-select"
                        aria-describedby={hint}
                        className={dialogSelect}
                        value={chosen}
                        disabled={!socios.length}
                        onChange={(event) => {
                            setDotId(event.target.value);
                            // The lead changed: drop any further pick that is now the lead.
                            setMoreDotIds((ids) => ids.filter((id) => id !== event.target.value));
                        }}
                    >
                        {socios.map((dot) => (
                            <option key={dot.id} value={dot.id}>
                                {dot.name}
                            </option>
                        ))}
                    </select>
                )}
            </Field>
            {further.length > 0 && (
                <Field label="More socios (optional)" hint="Each starts as a request a workspace admin approves.">
                    {() => (
                        <Checklist
                            choices={further.map((dot) => ({ id: dot.id, name: dot.name }))}
                            selected={moreDotIds}
                            onToggle={(id) =>
                                setMoreDotIds((ids) => (ids.includes(id) ? ids.filter((i) => i !== id) : [...ids, id]))
                            }
                        />
                    )}
                </Field>
            )}
            {people.length > 0 && (
                <Field
                    label="Invite people (optional)"
                    hint="You are a member and admin already. Invited people get an invite to accept."
                >
                    {() => (
                        <Checklist
                            choices={people.map((person) => ({
                                id: person.userId,
                                name: person.name,
                            }))}
                            selected={userIds}
                            onToggle={(id) =>
                                setUserIds((ids) => (ids.includes(id) ? ids.filter((i) => i !== id) : [...ids, id]))
                            }
                        />
                    )}
                </Field>
            )}
            <Field label="Description / purpose (optional)" hint="Shown to the room’s members. What is this room for?">
                {(id) => (
                    <Textarea
                        id={id}
                        value={description}
                        rows={3}
                        maxLength={2_000}
                        placeholder="What this room is for, in a sentence or two"
                        // On mobile the virtual keyboard can cover a field at the
                        // bottom of a scrolling dialog (CB-278): scroll it into view
                        // as it is focused, so the field stays visible above the
                        // keyboard. `block: 'nearest'` avoids a jump when there is
                        // already room.
                        onFocus={(event) => {
                            const target = event.currentTarget;
                            window.requestAnimationFrame(() =>
                                target.scrollIntoView({ block: 'nearest', behavior: 'smooth' }),
                            );
                        }}
                        onChange={(event) => setDescription(event.target.value)}
                    />
                )}
            </Field>
        </FormDialog>
    );
}

/**
 * A private chat as a room (CB-212): the owner confirms that everyone
 * they invite will read its whole history. Nothing is shared until they
 * invite someone, who is told so again before joining.
 */
export function ConvertRoomDialog({ thread, onClose }: { thread: Conversation; onClose: () => void }) {
    const shell = useShell();
    const [confirmed, setConfirmed] = useState(false);
    const [busy, setBusy] = useState(false);
    const [problem, setProblem] = useState('');
    return (
        <FormDialog
            open
            onOpenChange={(open) => !open && onClose()}
            title="Share this chat as a room?"
            slot="convert-room"
            description={`“${thread.title}” becomes a room you are the admin of, with the same link and history. You can then invite people.`}
            action={busy ? 'Sharing…' : 'Make it a room'}
            busy={busy}
            disabled={!confirmed}
            problem={problem}
            onSubmit={async () => {
                setBusy(true);
                setProblem('');
                try {
                    await roomsApi.convert(thread.id);
                    await shell.refresh();
                    toast.success('This chat is now a room. Invite people from Members.');
                    onClose();
                } catch (error) {
                    setProblem(failure(error, 'Could not make it a room.'));
                } finally {
                    setBusy(false);
                }
            }}
        >
            <p className="rounded-md border bg-muted/50 p-3 text-sm">{ROOM_CONVERT_TEXT}</p>
            <Confirm checked={confirmed} onChange={setConfirmed}>
                I understand: everyone I invite reads this whole chat.
            </Confirm>
        </FormDialog>
    );
}

/** A room's new name (room admins). */
export function RenameRoomDialog({
    thread,
    onClose,
}: {
    thread: Pick<Conversation, 'id' | 'title'>;
    onClose: () => void;
}) {
    const shell = useShell();
    const [title, setTitle] = useState(thread.title);
    const [busy, setBusy] = useState(false);
    const [problem, setProblem] = useState('');
    return (
        <FormDialog
            open
            onOpenChange={(open) => !open && onClose()}
            title="Rename room"
            slot="rename-room"
            description="Everyone in the room sees the new name."
            action={busy ? 'Saving…' : 'Save'}
            busy={busy}
            disabled={!title.trim() || title.trim() === thread.title}
            problem={problem}
            onSubmit={async () => {
                setBusy(true);
                setProblem('');
                try {
                    await roomsApi.rename(thread.id, title.trim());
                    await shell.refresh();
                    onClose();
                } catch (error) {
                    setProblem(failure(error, 'Could not rename the room.'));
                } finally {
                    setBusy(false);
                }
            }}
        >
            <Field label="Name">
                {(id) => (
                    <Input
                        id={id}
                        value={title}
                        autoFocus
                        maxLength={MAX_CHAT_TITLE}
                        onFocus={(event) => event.currentTarget.select()}
                        onChange={(event) => setTitle(event.target.value)}
                    />
                )}
            </Field>
        </FormDialog>
    );
}

/**
 * Leaving a room: it leaves the reader's lists and they stop reading it.
 * The last admin hands the role on first (the server refuses otherwise,
 * `last_admin`): they pick who, and both happen here.
 */
export function LeaveRoomDialog({
    thread,
    lastAdmin,
    successors = [],
    onClose,
    onLeft,
}: {
    thread: Pick<Conversation, 'id' | 'title'>;
    /** The reader is the room's only admin: they hand the role on first. */
    lastAdmin: boolean;
    /** Active members who could take the admin role on. */
    successors?: readonly { userId: string; name: string }[];
    onClose: () => void;
    /** Before it leaves the room's page (closes the mobile sidebar). */
    onLeft?: () => void;
}) {
    const shell = useShell();
    const navigate = useNavigate();
    const [successor, setSuccessor] = useState(successors[0]?.userId ?? '');
    const [busy, setBusy] = useState(false);
    const [problem, setProblem] = useState('');
    const stuck = lastAdmin && !successors.length;
    return (
        <FormDialog
            open
            onOpenChange={(open) => !open && onClose()}
            title={`Leave “${thread.title}”?`}
            slot="leave-room"
            description={
                stuck
                    ? 'You are the only person in this room. Archive it instead: it is kept, and you can bring it back.'
                    : lastAdmin
                      ? 'A room always keeps an admin. Choose who takes the role on: you leave once they have it.'
                      : 'You stop reading the room and it leaves your sidebar. An admin can invite you again.'
            }
            action={busy ? 'Leaving…' : stuck ? 'Archive room' : lastAdmin ? 'Hand over and leave' : 'Leave room'}
            busy={busy}
            disabled={lastAdmin && !stuck && !successor}
            problem={problem}
            onSubmit={async () => {
                setBusy(true);
                setProblem('');
                try {
                    if (stuck) {
                        await roomsApi.archive(thread.id);
                        await shell.refresh();
                        toast.success(`Archived “${thread.title}”.`);
                        onClose();
                        return;
                    }
                    if (lastAdmin) {
                        await roomsApi.setRole(thread.id, successor, 'admin');
                    }
                    await roomsApi.leave(thread.id);
                    onClose();
                    onLeft?.();
                    toast.success(`You left “${thread.title}”.`);
                    void navigate('/');
                    await shell.refresh();
                } catch (error) {
                    setProblem(failure(error, 'Could not leave the room.'));
                } finally {
                    setBusy(false);
                }
            }}
        >
            {lastAdmin && !stuck && (
                <Field label="New admin">
                    {(id) => (
                        <select
                            id={id}
                            data-slot="native-select"
                            className={dialogSelect}
                            value={successor}
                            onChange={(event) => setSuccessor(event.target.value)}
                        >
                            {successors.map((person) => (
                                <option key={person.userId} value={person.userId}>
                                    {person.name}
                                </option>
                            ))}
                        </select>
                    )}
                </Field>
            )}
        </FormDialog>
    );
}

/**
 * The reader's invitations (CB-212): each room's name, who asked, how
 * many are in it and until when the invite works, never its messages.
 * Joining shows what it shares (`disclosure`) and waits for the reader
 * to say they understand; declining needs nothing.
 */
export function InvitesDialog({
    open,
    onOpenChange,
    invites,
    onChanged,
    onNavigate,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    invites: readonly RoomInvite[];
    /** After an accept or a decline: read the invites again. */
    onChanged: () => void;
    /** Before it opens a room just joined (closes the mobile sidebar). */
    onNavigate?: () => void;
}) {
    const focus = useFocusReturn();
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent
                onCloseAutoFocus={focus.onCloseAutoFocus}
                data-slot="room-invites"
                className="max-h-[90svh] overflow-y-auto sm:max-w-lg"
            >
                {focus.mark}
                <DialogHeader>
                    <DialogTitle>Room invitations</DialogTitle>
                    <DialogDescription>
                        Join to read and write in a room, or decline. Nobody sees the room’s messages before they join.
                    </DialogDescription>
                </DialogHeader>
                {invites.length === 0 ? (
                    <p className="text-sm text-muted-foreground">You have no invitations.</p>
                ) : (
                    <ul className="grid gap-3" aria-label="Invitations">
                        {invites.map((invite) => (
                            <InviteCard
                                key={invite.roomId}
                                invite={invite}
                                onDone={() => {
                                    onChanged();
                                }}
                                onJoined={() => {
                                    onOpenChange(false);
                                    onNavigate?.();
                                }}
                            />
                        ))}
                    </ul>
                )}
            </DialogContent>
        </Dialog>
    );
}

function InviteCard({ invite, onDone, onJoined }: { invite: RoomInvite; onDone: () => void; onJoined: () => void }) {
    const shell = useShell();
    const navigate = useNavigate();
    const [understood, setUnderstood] = useState(false);
    const [busy, setBusy] = useState<'accept' | 'decline'>();
    const [problem, setProblem] = useState('');
    const headingId = useId();
    const act = async (which: 'accept' | 'decline') => {
        setBusy(which);
        setProblem('');
        try {
            if (which === 'accept') {
                await roomsApi.accept(invite.roomId, invite.disclosure.version);
                await shell.refresh();
                onJoined();
                toast.success(`You joined “${invite.title}”.`);
                void navigate(roomPath(invite.roomId));
            } else {
                await roomsApi.decline(invite.roomId);
                toast(`Declined “${invite.title}”.`);
                await shell.refresh();
            }
            onDone();
        } catch (error) {
            setProblem(failure(error, 'That didn’t work. Try again.'));
            onDone();
        } finally {
            setBusy(undefined);
        }
    };
    const people = invite.memberCount === 1 ? 'person' : 'people';
    return (
        <li aria-labelledby={headingId} data-room-invite={invite.roomId} className="grid gap-3 rounded-lg border p-3">
            <div className="grid gap-0.5">
                <h3 id={headingId} className="font-medium break-words">
                    {invite.title}
                </h3>
                <p className="text-xs text-muted-foreground">
                    {invite.invitedByName ? `${invite.invitedByName} invited you` : 'You were invited'}
                    {invite.role === 'admin' ? ' as an admin' : ''} · {invite.memberCount} {people} in it
                    {invite.inviteExpiresAt ? (
                        <>
                            {' '}
                            · until <LocalTime value={invite.inviteExpiresAt} format={day} />
                        </>
                    ) : null}
                </p>
            </div>
            <p className="rounded-md bg-muted/60 p-2.5 text-sm">{invite.disclosure.text}</p>
            <Confirm checked={understood} onChange={setUnderstood}>
                I understand what joining shares.
            </Confirm>
            <Problem>{problem}</Problem>
            <div className="flex flex-wrap justify-end gap-2">
                <Button
                    variant="outline"
                    className={touchTarget}
                    disabled={!!busy}
                    aria-label={`Decline ${invite.title}`}
                    onClick={() => void act('decline')}
                >
                    {busy === 'decline' ? 'Declining…' : 'Decline'}
                </Button>
                <Button
                    className={touchTarget}
                    disabled={!!busy || !understood}
                    // Its name starts with the words it shows (CB-219), so "Join
                    // room" said aloud finds it.
                    aria-label={`Join room ${invite.title}`}
                    onClick={() => void act('accept')}
                >
                    {busy === 'accept' ? 'Joining…' : 'Join room'}
                </Button>
            </div>
        </li>
    );
}

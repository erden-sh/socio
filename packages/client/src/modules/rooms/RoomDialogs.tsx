import { useEffect, useId, useState, type ComponentType, type FormEvent, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';

import { Trans, useTranslation } from '@socio/i18n/react';
import { ROOM_CONVERT_TEXT, roomEligibleSocio, type RoomInvite, type RoomPerson } from '@socio/shared/rooms/rooms';
import { MAX_CHAT_TITLE, type Conversation } from '@socio/shared/types';

import { onDemand } from '../../i18n/on-demand';
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

/** The words these dialogs show: loaded as one first opens (docs/I18N.md). */
export const ROOM_DIALOG_NAMESPACES = ['rooms.dialogs'] as const satisfies Parameters<typeof onDemand>[0];

/**
 * `Component` once its words are in (`onDemand`), mounted the first time
 * it opens and kept after, so it closes with its animation and gives the
 * focus back (`useFocusReturn`). A dialog that is always on the page with
 * `open={false}` (the sidebar's, Home's) loads nothing until it opens.
 */
export function openedOnDemand<P extends { open: boolean }>(
    namespaces: Parameters<typeof onDemand>[0],
    Component: ComponentType<P>,
) {
    const Loaded = onDemand(namespaces, Component);
    function OpenedOnDemand(props: P) {
        const [opened, setOpened] = useState(props.open);
        if (props.open && !opened) {
            setOpened(true);
        }
        return opened ? <Loaded {...props} /> : null;
    }
    OpenedOnDemand.displayName = `OpenedOnDemand(${Component.displayName ?? Component.name})`;
    return OpenedOnDemand;
}

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
    const { t } = useTranslation(['rooms.dialogs']);
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
                            {t('rooms.dialogs:cancel')}
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
function CreateRoom({
    open,
    onOpenChange,
    onNavigate,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** Before it opens the new room (closes the mobile sidebar). */
    onNavigate?: () => void;
}) {
    const { t } = useTranslation(['rooms.dialogs']);
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
            title={t('rooms.dialogs:create.title')}
            slot="create-room"
            description={t('rooms.dialogs:create.description')}
            action={busy ? t('rooms.dialogs:create.busy') : t('rooms.dialogs:create.action')}
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
                    toast.success(t('rooms.dialogs:create.created', { title: room.title }));
                    onNavigate?.();
                    void navigate(membersPath(room.id));
                } catch (error) {
                    setProblem(failure(error, t('rooms.dialogs:create.failed')));
                } finally {
                    setBusy(false);
                }
            }}
        >
            <Field label={t('rooms.dialogs:create.name')}>
                {(id) => (
                    <Input
                        id={id}
                        value={title}
                        autoFocus
                        maxLength={MAX_CHAT_TITLE}
                        placeholder={t('rooms.dialogs:create.name-placeholder')}
                        onChange={(event) => setTitle(event.target.value)}
                    />
                )}
            </Field>
            <Field
                label={t('rooms.dialogs:create.lead')}
                hint={t('rooms.dialogs:create.lead-hint', { context: socios.length ? undefined : 'none' })}
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
                <Field label={t('rooms.dialogs:create.more')} hint={t('rooms.dialogs:create.more-hint')}>
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
                <Field label={t('rooms.dialogs:create.people')} hint={t('rooms.dialogs:create.people-hint')}>
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
            <Field label={t('rooms.dialogs:create.purpose')} hint={t('rooms.dialogs:create.purpose-hint')}>
                {(id) => (
                    <Textarea
                        id={id}
                        value={description}
                        rows={3}
                        maxLength={2_000}
                        placeholder={t('rooms.dialogs:create.purpose-placeholder')}
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
export const CreateRoomDialog = openedOnDemand([...ROOM_DIALOG_NAMESPACES], CreateRoom);

/**
 * A private chat as a room (CB-212): the owner confirms that everyone
 * they invite will read its whole history. Nothing is shared until they
 * invite someone, who is told so again before joining.
 */
function ConvertRoom({ thread, onClose }: { thread: Conversation; onClose: () => void }) {
    const { t } = useTranslation(['rooms.dialogs']);
    const shell = useShell();
    const [confirmed, setConfirmed] = useState(false);
    const [busy, setBusy] = useState(false);
    const [problem, setProblem] = useState('');
    return (
        <FormDialog
            open
            onOpenChange={(open) => !open && onClose()}
            title={t('rooms.dialogs:convert.title')}
            slot="convert-room"
            description={t('rooms.dialogs:convert.description', { title: thread.title })}
            action={busy ? t('rooms.dialogs:convert.busy') : t('rooms.dialogs:convert.action')}
            busy={busy}
            disabled={!confirmed}
            problem={problem}
            onSubmit={async () => {
                setBusy(true);
                setProblem('');
                try {
                    await roomsApi.convert(thread.id);
                    await shell.refresh();
                    toast.success(t('rooms.dialogs:convert.done'));
                    onClose();
                } catch (error) {
                    setProblem(failure(error, t('rooms.dialogs:convert.failed')));
                } finally {
                    setBusy(false);
                }
            }}
        >
            <p className="rounded-md border bg-muted/50 p-3 text-sm">{ROOM_CONVERT_TEXT}</p>
            <Confirm checked={confirmed} onChange={setConfirmed}>
                {t('rooms.dialogs:convert.confirm')}
            </Confirm>
        </FormDialog>
    );
}
export const ConvertRoomDialog = onDemand([...ROOM_DIALOG_NAMESPACES], ConvertRoom);

/** A room's new name (room admins). */
function RenameRoom({ thread, onClose }: { thread: Pick<Conversation, 'id' | 'title'>; onClose: () => void }) {
    const { t } = useTranslation(['rooms.dialogs']);
    const shell = useShell();
    const [title, setTitle] = useState(thread.title);
    const [busy, setBusy] = useState(false);
    const [problem, setProblem] = useState('');
    return (
        <FormDialog
            open
            onOpenChange={(open) => !open && onClose()}
            title={t('rooms.dialogs:rename.title')}
            slot="rename-room"
            description={t('rooms.dialogs:rename.description')}
            action={busy ? t('rooms.dialogs:rename.busy') : t('rooms.dialogs:rename.action')}
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
                    setProblem(failure(error, t('rooms.dialogs:rename.failed')));
                } finally {
                    setBusy(false);
                }
            }}
        >
            <Field label={t('rooms.dialogs:rename.name')}>
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
export const RenameRoomDialog = onDemand([...ROOM_DIALOG_NAMESPACES], RenameRoom);

/**
 * Leaving a room: it leaves the reader's lists and they stop reading it.
 * The last admin hands the role on first (the server refuses otherwise,
 * `last_admin`): they pick who, and both happen here.
 */
function LeaveRoom({
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
    const { t } = useTranslation(['rooms.dialogs']);
    const shell = useShell();
    const navigate = useNavigate();
    const [successor, setSuccessor] = useState(successors[0]?.userId ?? '');
    const [busy, setBusy] = useState(false);
    const [problem, setProblem] = useState('');
    const stuck = lastAdmin && !successors.length;
    const context = stuck ? 'stuck' : lastAdmin ? 'handover' : undefined;
    return (
        <FormDialog
            open
            onOpenChange={(open) => !open && onClose()}
            title={t('rooms.dialogs:leave.title', { title: thread.title })}
            slot="leave-room"
            description={t('rooms.dialogs:leave.description', { context })}
            action={busy ? t('rooms.dialogs:leave.busy') : t('rooms.dialogs:leave.action', { context })}
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
                        toast.success(t('rooms.dialogs:leave.archived', { title: thread.title }));
                        onClose();
                        return;
                    }
                    if (lastAdmin) {
                        await roomsApi.setRole(thread.id, successor, 'admin');
                    }
                    await roomsApi.leave(thread.id);
                    onClose();
                    onLeft?.();
                    toast.success(t('rooms.dialogs:leave.left', { title: thread.title }));
                    void navigate('/');
                    await shell.refresh();
                } catch (error) {
                    setProblem(failure(error, t('rooms.dialogs:leave.failed')));
                } finally {
                    setBusy(false);
                }
            }}
        >
            {lastAdmin && !stuck && (
                <Field label={t('rooms.dialogs:leave.new-admin')}>
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
export const LeaveRoomDialog = onDemand([...ROOM_DIALOG_NAMESPACES], LeaveRoom);

/**
 * The reader's invitations (CB-212): each room's name, who asked, how
 * many are in it and until when the invite works, never its messages.
 * Joining shows what it shares (`disclosure`) and waits for the reader
 * to say they understand; declining needs nothing.
 */
function Invites({
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
    const { t } = useTranslation(['rooms.dialogs']);
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
                    <DialogTitle>{t('rooms.dialogs:invites.title')}</DialogTitle>
                    <DialogDescription>{t('rooms.dialogs:invites.description')}</DialogDescription>
                </DialogHeader>
                {invites.length === 0 ? (
                    <p className="text-sm text-muted-foreground">{t('rooms.dialogs:invites.none')}</p>
                ) : (
                    <ul className="grid gap-3" aria-label={t('rooms.dialogs:invites.list')}>
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
export const InvitesDialog = openedOnDemand([...ROOM_DIALOG_NAMESPACES], Invites);

function InviteCard({ invite, onDone, onJoined }: { invite: RoomInvite; onDone: () => void; onJoined: () => void }) {
    const { t } = useTranslation(['rooms.dialogs']);
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
                toast.success(t('rooms.dialogs:invites.joined', { title: invite.title }));
                void navigate(roomPath(invite.roomId));
            } else {
                await roomsApi.decline(invite.roomId);
                toast(t('rooms.dialogs:invites.declined', { title: invite.title }));
                await shell.refresh();
            }
            onDone();
        } catch (error) {
            setProblem(failure(error, t('rooms.dialogs:invites.failed')));
            onDone();
        } finally {
            setBusy(undefined);
        }
    };
    const day = (value: number) => t('rooms.dialogs:day', { at: new Date(value) });
    const role = invite.role === 'admin' ? 'admin' : undefined;
    return (
        <li aria-labelledby={headingId} data-room-invite={invite.roomId} className="grid gap-3 rounded-lg border p-3">
            <div className="grid gap-0.5">
                <h3 id={headingId} className="font-medium break-words">
                    {invite.title}
                </h3>
                <p className="text-xs text-muted-foreground">
                    {invite.invitedByName
                        ? t('rooms.dialogs:invites.invited-by', { name: invite.invitedByName, context: role })
                        : t('rooms.dialogs:invites.invited', { context: role })}
                    {' · '}
                    {t('rooms.dialogs:invites.members', { count: invite.memberCount })}
                    {invite.inviteExpiresAt ? (
                        <>
                            {' · '}
                            <Trans
                                t={t}
                                i18nKey="rooms.dialogs:invites.until"
                                components={{ date: <LocalTime value={invite.inviteExpiresAt} format={day} /> }}
                            />
                        </>
                    ) : null}
                </p>
            </div>
            <p className="rounded-md bg-muted/60 p-2.5 text-sm">{invite.disclosure.text}</p>
            <Confirm checked={understood} onChange={setUnderstood}>
                {t('rooms.dialogs:invites.understood')}
            </Confirm>
            <Problem>{problem}</Problem>
            <div className="flex flex-wrap justify-end gap-2">
                <Button
                    variant="outline"
                    className={touchTarget}
                    disabled={!!busy}
                    aria-label={t('rooms.dialogs:invites.decline-label', { title: invite.title })}
                    onClick={() => void act('decline')}
                >
                    {busy === 'decline' ? t('rooms.dialogs:invites.declining') : t('rooms.dialogs:invites.decline')}
                </Button>
                <Button
                    className={touchTarget}
                    disabled={!!busy || !understood}
                    // Its name starts with the words it shows (CB-219), so "Join
                    // room" said aloud finds it.
                    aria-label={t('rooms.dialogs:invites.join-label', { title: invite.title })}
                    onClick={() => void act('accept')}
                >
                    {busy === 'accept' ? t('rooms.dialogs:invites.joining') : t('rooms.dialogs:invites.join')}
                </Button>
            </div>
        </li>
    );
}

import { MoreHorizontal } from 'lucide-react';
import { useEffect, useId, useState, type ReactNode } from 'react';
import { toast } from 'sonner';

import { personLabels } from '@socio/shared/rooms/room-speakers';
import {
    roomEligibleSocio,
    type RoomHandoffLimitView,
    type RoomMemberView,
    type RoomPerson,
    type RoomRole,
    type RoomSocioView,
    type RoomView,
} from '@socio/shared/rooms/rooms';

import { LocalTime } from '../../lib/local-time';
import { Mascot } from '../../locals/Mascot';
import { useShell } from '../../shell/shell-context';

import { failure, roomsApi } from './api';
import { LeaveRoomDialog } from './RoomDialogs';
import { PersonAvatar } from './RoomSpeaker';
import { RoomUsage } from './RoomUsage';
import { touchIcon, touchTarget } from './touch';

import { dialogSelect } from '@/components/form-fields';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { cn } from '@/lib/utils';

/** "Oct 12", in the reader's words once hydrated. */
const day = (value: number) =>
    new Date(value).toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
    });

/** Active admins, of the people listed. */
export const activeAdmins = (room: Pick<RoomView, 'members'>) =>
    room.members.filter((member) => member.status === 'active' && member.role === 'admin');

/** The reader is the room's only active admin. */
export const soleAdmin = (room: RoomView, userId: string) => {
    const admins = activeAdmins(room);
    return admins.length === 1 && admins[0]!.userId === userId;
};

/**
 * Who could take the admin role on from the reader: the other active
 * members, by name (with their number, when two share it).
 */
export const successorsOf = (room: RoomView, userId: string) => {
    const labels = personLabels(room.members);
    return room.members
        .filter((member) => member.status === 'active' && member.userId !== userId)
        .map(({ userId: id, name }) => ({
            userId: id,
            name: labels.get(id) ?? name,
        }));
};

/**
 * A room's people and socios (CB-212), in a panel beside the room (the
 * whole width on a phone). Everyone sees who is in it, each person's
 * role, pending invites and the socios. Room admins invite, remove,
 * change roles, ask for socios and pick the lead; a workspace admin who
 * is a member lets requested socios in or takes them out. Everyone can
 * leave; the last admin hands the role on as they do. Room admins, and
 * members when Settings → Rooms shows them, see its use and limits.
 */
export function MembersPanel({
    room,
    open,
    onOpenChange,
    onChanged,
    returnFocus,
    tones,
    labels,
}: {
    room: RoomView;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** A change's answer, or undefined: read the room again. */
    onChanged: (next?: RoomView) => void;
    /**
     * Where focus goes as it closes (the room's Members button): it may
     * have opened from a link or a menu, with no trigger to go back to.
     */
    returnFocus?: () => HTMLElement | null | undefined;
    /** Each person's avatar tone, as the room's messages show it (CB-212). */
    tones?: ReadonlyMap<string, string>;
    /**
     * Two active people with one name, in words, as the messages show them
     * (`personLabels`): "Ana Lima · 2".
     */
    labels?: ReadonlyMap<string, string>;
}) {
    const shell = useShell();
    const me = shell.workspace.user.id;
    const live = room.roomsEnabled && !room.archivedAt;
    const manage = live && room.role === 'admin';
    const [leaving, setLeaving] = useState(false);
    const active = room.members.filter((member) => member.status === 'active');
    const invited = room.members.filter((member) => member.status === 'invited');
    return (
        <Sheet open={open} onOpenChange={onOpenChange}>
            <SheetContent
                data-slot="room-members"
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
                    <SheetTitle>Members</SheetTitle>
                    <SheetDescription>
                        {room.archivedAt
                            ? 'This room is archived: nothing changes in it until an admin unarchives it.'
                            : !room.roomsEnabled
                              ? 'Rooms are turned off in Settings: this room is read-only.'
                              : room.role === 'admin'
                                ? 'You are an admin here: you invite and remove people, and choose the socios.'
                                : 'Room admins invite people and choose the socios.'}
                    </SheetDescription>
                </SheetHeader>
                <Section title={`People (${active.length})`}>
                    <ul className="grid gap-1" aria-label="People in the room">
                        {active.map((member) => (
                            <MemberRow
                                key={member.userId}
                                room={room}
                                member={member}
                                you={member.userId === me}
                                manage={manage}
                                onChanged={onChanged}
                                tone={tones?.get(member.userId)}
                                shownName={labels?.get(member.userId)}
                            />
                        ))}
                    </ul>
                </Section>
                {invited.length > 0 && (
                    <Section title={`Invited (${invited.length})`}>
                        <ul className="grid gap-1" aria-label="Invited people">
                            {invited.map((member) => (
                                <MemberRow
                                    key={member.userId}
                                    room={room}
                                    member={member}
                                    you={member.userId === me}
                                    manage={manage}
                                    onChanged={onChanged}
                                    tone={tones?.get(member.userId)}
                                />
                            ))}
                        </ul>
                    </Section>
                )}
                {manage && (
                    <Section title="Invite someone">
                        <InviteForm room={room} onChanged={onChanged} />
                    </Section>
                )}
                <Section title="Socios">
                    <SocioList room={room} manage={manage} onChanged={onChanged} />
                    <HandoffLimit room={room} manage={manage} />
                </Section>
                {room.usageVisible && (
                    <Section title="Use and limits">
                        <RoomUsage roomId={room.id} />
                    </Section>
                )}
                <div className="mt-auto border-t p-4">
                    <Button variant="outline" className={cn('w-full', touchTarget)} onClick={() => setLeaving(true)}>
                        Leave room
                    </Button>
                </div>
                {leaving && (
                    <LeaveRoomDialog
                        thread={room}
                        lastAdmin={soleAdmin(room, me)}
                        successors={successorsOf(room, me)}
                        onClose={() => setLeaving(false)}
                    />
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

/** Runs a change and says what went wrong; its answer goes to `onChanged`. */
function useChange(onChanged: (next?: RoomView) => void) {
    const shell = useShell();
    const [busy, setBusy] = useState(false);
    const run = async (work: () => Promise<RoomView | unknown>, done: string, fallback: string) => {
        setBusy(true);
        try {
            const next = await work();
            onChanged(next && typeof next === 'object' && 'members' in next ? (next as RoomView) : undefined);
            toast.success(done);
            await shell.refresh();
            return true;
        } catch (error) {
            toast.error(failure(error, fallback));
            onChanged();
            return false;
        } finally {
            setBusy(false);
        }
    };
    return { busy, run };
}

const roleWord: Record<RoomRole, string> = { admin: 'Admin', member: 'Member' };

/** One person: avatar, name, role, and the admin's ⋯ menu. */
function MemberRow({
    room,
    member,
    you,
    manage,
    onChanged,
    tone,
    shownName,
}: {
    room: RoomView;
    member: RoomMemberView;
    you: boolean;
    manage: boolean;
    onChanged: (next?: RoomView) => void;
    tone?: string;
    /** Their name with their number, when another shares it. */
    shownName?: string;
}) {
    const { busy, run } = useChange(onChanged);
    const name = shownName ?? member.name;
    const invited = member.status === 'invited';
    const lastAdmin = member.role === 'admin' && member.status === 'active' && activeAdmins(room).length === 1;
    const options = manage && !(you && lastAdmin);
    return (
        <li data-room-member={member.userId} className="flex min-h-10 items-center gap-2.5 rounded-md px-1">
            <PersonAvatar name={member.name} tone={tone} className="size-7" />
            <div className="grid min-w-0 flex-1">
                <span className="truncate text-sm font-medium">
                    {name}
                    {you && <span className="text-muted-foreground"> (you)</span>}
                </span>
                <span className="truncate text-xs text-muted-foreground">
                    {invited ? (
                        <>
                            Invited
                            {member.inviteExpiresAt ? (
                                <>
                                    {' '}
                                    · until <LocalTime value={member.inviteExpiresAt} format={day} />
                                </>
                            ) : null}
                        </>
                    ) : (
                        roleWord[member.role]
                    )}
                </span>
            </div>
            {options && (
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <Button
                            variant="ghost"
                            size="icon"
                            className={cn('size-9 shrink-0', touchIcon)}
                            disabled={busy}
                            aria-label={`Options for ${name}`}
                        >
                            <MoreHorizontal />
                        </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                        {!invited && member.role === 'member' && (
                            <DropdownMenuItem
                                className={touchTarget}
                                onSelect={() =>
                                    void run(
                                        () => roomsApi.setRole(room.id, member.userId, 'admin'),
                                        `${name} is now an admin.`,
                                        'Could not change the role.',
                                    )
                                }
                            >
                                Make admin
                            </DropdownMenuItem>
                        )}
                        {!invited && member.role === 'admin' && !lastAdmin && (
                            <DropdownMenuItem
                                className={touchTarget}
                                onSelect={() =>
                                    void run(
                                        () => roomsApi.setRole(room.id, member.userId, 'member'),
                                        you ? 'You are no longer an admin.' : `${name} is no longer an admin.`,
                                        'Could not change the role.',
                                    )
                                }
                            >
                                {you ? 'Step down as admin' : 'Make member'}
                            </DropdownMenuItem>
                        )}
                        {!you && (
                            <DropdownMenuItem
                                variant="destructive"
                                className={touchTarget}
                                onSelect={() =>
                                    void run(
                                        () => roomsApi.remove(room.id, member.userId),
                                        invited ? `Invite to ${name} taken back.` : `${name} was removed.`,
                                        'Could not remove them.',
                                    )
                                }
                            >
                                {invited ? 'Take back invite' : 'Remove from room'}
                            </DropdownMenuItem>
                        )}
                    </DropdownMenuContent>
                </DropdownMenu>
            )}
        </li>
    );
}

/**
 * Invite a person (room admins): those who may be invited, by name, and
 * their role. They are told what joining shares before they accept.
 */
function InviteForm({ room, onChanged }: { room: RoomView; onChanged: (next?: RoomView) => void }) {
    const [people, setPeople] = useState<RoomPerson[]>();
    const [userId, setUserId] = useState('');
    const [role, setRole] = useState<RoomRole>('member');
    const [problem, setProblem] = useState('');
    const { busy, run } = useChange(onChanged);
    const personId = useId();
    const roleId = useId();
    // Again whenever the room changes (someone joined, an invite went).
    const members = room.members.map((member) => member.userId).join();
    useEffect(() => {
        const controller = new AbortController();
        roomsApi
            .invitable(room.id, controller.signal)
            .then((next) => {
                setPeople(next);
                setProblem('');
            })
            .catch((error) => {
                if (!controller.signal.aborted) {
                    setProblem(failure(error, 'Could not list people to invite.'));
                }
            });
        return () => controller.abort();
    }, [room.id, members]);
    const chosen = people?.some((person) => person.userId === userId) ? userId : (people?.[0]?.userId ?? '');
    if (!people) {
        return <p className="text-sm text-muted-foreground">{problem || 'Loading people…'}</p>;
    }
    if (!people.length) {
        return <p className="text-sm text-muted-foreground">Everyone who uses Socio is in this room or invited.</p>;
    }
    return (
        <form
            className="grid gap-2"
            onSubmit={(event) => {
                event.preventDefault();
                const person = people.find((item) => item.userId === chosen);
                if (!person || busy) {
                    return;
                }
                void run(
                    () => roomsApi.invite(room.id, person.userId, role),
                    `Invited ${person.name}. They join once they accept.`,
                    'Could not invite them.',
                );
            }}
        >
            <div className="grid gap-1.5">
                <label htmlFor={personId} className="text-xs font-medium">
                    Person
                </label>
                <select
                    id={personId}
                    data-slot="native-select"
                    className={cn(dialogSelect, touchTarget)}
                    value={chosen}
                    onChange={(event) => setUserId(event.target.value)}
                >
                    {people.map((person) => (
                        <option key={person.userId} value={person.userId}>
                            {person.name}
                        </option>
                    ))}
                </select>
            </div>
            <div className="flex items-end gap-2">
                <div className="grid min-w-0 flex-1 gap-1.5">
                    <label htmlFor={roleId} className="text-xs font-medium">
                        Role
                    </label>
                    <select
                        id={roleId}
                        data-slot="native-select"
                        className={cn(dialogSelect, touchTarget)}
                        value={role}
                        onChange={(event) => setRole(event.target.value as RoomRole)}
                    >
                        <option value="member">Member</option>
                        <option value="admin">Admin</option>
                    </select>
                </div>
                <Button type="submit" disabled={busy || !chosen} className={cn('h-10', touchTarget)}>
                    {busy ? 'Inviting…' : 'Invite'}
                </Button>
            </div>
            {problem && (
                <p role="alert" className="text-sm text-destructive">
                    {problem}
                </p>
            )}
            <p className="text-xs text-muted-foreground">
                An invite works for 7 days. Before joining they are told they will read the room’s whole history.
            </p>
        </form>
    );
}

const socioStatus: Record<RoomSocioView['status'], string> = {
    active: 'Answers in this room',
    requested: 'Waiting for a workspace admin to let it in',
    withdrawn: 'Taken out by a workspace admin',
    removed: 'Removed',
};

/**
 * The room's socios: the lead answers, others wait for a workspace
 * admin. Room admins ask for one, pick the lead and take one out; a
 * workspace admin lets a requested one in, or takes one out.
 */
function SocioList({
    room,
    manage,
    onChanged,
}: {
    room: RoomView;
    manage: boolean;
    onChanged: (next?: RoomView) => void;
}) {
    const shell = useShell();
    const { busy, run } = useChange(onChanged);
    const live = room.roomsEnabled && !room.archivedAt;
    const workspaceAdmin = shell.admin && live;
    const inRoom = new Set(room.socios.map((socio) => socio.dotId));
    const askable = shell.workspace.dots.filter((dot) => roomEligibleSocio(dot) && !inRoom.has(dot.id));
    const [ask, setAsk] = useState('');
    const askId = useId();
    const chosen = askable.some((dot) => dot.id === ask) ? ask : (askable[0]?.id ?? '');
    return (
        <div className="grid gap-3">
            <ul className="grid gap-1" aria-label="Socios in the room">
                {room.socios.map((socio) => {
                    const dot = shell.workspace.dots.find((item) => item.id === socio.dotId);
                    return (
                        <li
                            key={socio.dotId}
                            data-room-socio={socio.dotId}
                            className="flex min-h-10 flex-wrap items-center gap-2.5 rounded-md px-1"
                        >
                            <Mascot
                                identity={socio.dotId}
                                character={dot?.character}
                                name={socio.name}
                                small
                                decorative
                                className="size-7 shrink-0"
                            />
                            <div className="grid min-w-0 flex-1">
                                <span className="truncate text-sm font-medium">{socio.name}</span>
                                <span className="text-xs text-muted-foreground">{socioStatus[socio.status]}</span>
                            </div>
                            {socio.lead && (
                                <Badge variant="outline" className="shrink-0">
                                    Lead
                                </Badge>
                            )}
                            <div className="flex shrink-0 flex-wrap gap-1">
                                {workspaceAdmin && socio.status === 'requested' && (
                                    <Button
                                        size="sm"
                                        className={touchTarget}
                                        disabled={busy}
                                        onClick={() =>
                                            void run(
                                                () => roomsApi.authorizeSocio(room.id, socio.dotId),
                                                `${socio.name} can answer in this room.`,
                                                'Could not let it in.',
                                            )
                                        }
                                    >
                                        Let in
                                    </Button>
                                )}
                                {manage && socio.status === 'active' && !socio.lead && (
                                    <Button
                                        size="sm"
                                        variant="outline"
                                        className={touchTarget}
                                        disabled={busy}
                                        onClick={() =>
                                            void run(
                                                () => roomsApi.setLead(room.id, socio.dotId),
                                                `${socio.name} now leads this room.`,
                                                'Could not change the lead.',
                                            )
                                        }
                                    >
                                        Make lead
                                    </Button>
                                )}
                                {manage && !socio.lead && (
                                    <Button
                                        size="sm"
                                        variant="ghost"
                                        className={touchTarget}
                                        disabled={busy}
                                        aria-label={`Remove ${socio.name}`}
                                        onClick={() =>
                                            void run(
                                                () => roomsApi.removeSocio(room.id, socio.dotId),
                                                `${socio.name} left the room.`,
                                                'Could not remove it.',
                                            )
                                        }
                                    >
                                        Remove
                                    </Button>
                                )}
                                {workspaceAdmin &&
                                    socio.status === 'active' &&
                                    // A room admin removes a socio that doesn't lead; only
                                    // the lead needs a workspace admin to take it out.
                                    (socio.lead || !manage) && (
                                        <Button
                                            size="sm"
                                            variant="ghost"
                                            className={cn('text-destructive hover:text-destructive', touchTarget)}
                                            disabled={busy}
                                            aria-label={`Take ${socio.name} out`}
                                            onClick={() =>
                                                void run(
                                                    () => roomsApi.withdrawSocio(room.id, socio.dotId),
                                                    socio.lead
                                                        ? `${socio.name} was taken out: the room has no socio answering until another leads.`
                                                        : `${socio.name} was taken out.`,
                                                    'Could not take it out.',
                                                )
                                            }
                                        >
                                            Take out
                                        </Button>
                                    )}
                            </div>
                        </li>
                    );
                })}
            </ul>
            {manage && askable.length > 0 && (
                <form
                    className="flex items-end gap-2"
                    onSubmit={(event) => {
                        event.preventDefault();
                        const dot = askable.find((item) => item.id === chosen);
                        if (!dot || busy) {
                            return;
                        }
                        void run(
                            () => roomsApi.requestSocio(room.id, dot.id),
                            `Asked for ${dot.name}. A workspace admin lets it in.`,
                            'Could not ask for it.',
                        );
                    }}
                >
                    <div className="grid min-w-0 flex-1 gap-1.5">
                        <label htmlFor={askId} className="text-xs font-medium">
                            Ask for a company socio
                        </label>
                        <select
                            id={askId}
                            data-slot="native-select"
                            className={cn(dialogSelect, touchTarget)}
                            value={chosen}
                            onChange={(event) => setAsk(event.target.value)}
                        >
                            {askable.map((dot) => (
                                <option key={dot.id} value={dot.id}>
                                    {dot.name}
                                </option>
                            ))}
                        </select>
                    </div>
                    <Button type="submit" variant="outline" disabled={busy} className={cn('h-10', touchTarget)}>
                        Ask
                    </Button>
                </form>
            )}
        </div>
    );
}

/**
 * How many times one message's work may pass between the room's socios
 * (CB-206), when it has more than one: the workspace's limit (Settings →
 * General → Work per message), which a room admin may lower here, never
 * raise. Everyone in the room sees it, whether or not they see its use
 * and budget (its own read, `handoffLimit`).
 */
function HandoffLimit({ room, manage }: { room: RoomView; manage: boolean }) {
    const active = room.socios.filter((socio) => socio.status === 'active');
    const [view, setView] = useState<RoomHandoffLimitView>();
    const [busy, setBusy] = useState(false);
    const id = useId();
    const several = active.length > 1;
    useEffect(() => {
        if (!several) {
            return;
        }
        const controller = new AbortController();
        // Every member's to read, whether or not they see the room's use.
        roomsApi.handoffLimit(room.id, controller.signal).then(setView, () => {
            // Shown once it reads; nothing to say meanwhile.
        });
        return () => controller.abort();
    }, [room.id, several]);
    if (!several || !view) {
        return null;
    }
    const most = view.workspace;
    const own = view.room ?? undefined;
    const effective = view.effective;
    const save = async (value: number | undefined) => {
        setBusy(true);
        try {
            // The room's other limits as they are: the room's are saved whole
            // (its admins read them all).
            const limits = { ...(await roomsApi.limits(room.id)).room };
            delete limits.handoffsPerCycle;
            if (value !== undefined) {
                limits.handoffsPerCycle = value;
            }
            const saved = await roomsApi.setLimits(room.id, limits);
            setView({
                workspace: saved.workspace.handoffsPerCycle,
                room: saved.room.handoffsPerCycle ?? null,
                effective: saved.effective.handoffsPerCycle,
            });
            toast.success('Handoffs per message saved.');
        } catch (error) {
            toast.error(failure(error, 'Could not save the handoffs.'));
        } finally {
            setBusy(false);
        }
    };
    if (!manage || most < 1) {
        return (
            <p className="text-xs text-muted-foreground" data-slot="room-handoffs">
                {effective === 0
                    ? 'Socios here can’t hand a message’s work to each other.'
                    : `A message’s work can pass between socios up to ${effective} ${effective === 1 ? 'time' : 'times'}.`}
            </p>
        );
    }
    return (
        <div className="grid gap-1.5" data-slot="room-handoffs">
            <label htmlFor={id} className="text-xs font-medium">
                Handoffs per message
            </label>
            <select
                id={id}
                data-slot="native-select"
                className={cn(dialogSelect, touchTarget)}
                aria-describedby={`${id}-note`}
                disabled={busy}
                value={own === undefined || own >= most ? '' : String(own)}
                onChange={(event) => void save(event.target.value ? Number(event.target.value) : undefined)}
            >
                <option value="">{`The workspace’s (${most})`}</option>
                {Array.from({ length: most - 1 }, (_, at) => at + 1).map((value) => (
                    <option key={value} value={value}>
                        {value}
                    </option>
                ))}
            </select>
            <p id={`${id}-note`} className="text-xs text-muted-foreground">
                How many times one message’s work may pass between this room’s socios. You can only lower the
                workspace’s limit.
            </p>
        </div>
    );
}

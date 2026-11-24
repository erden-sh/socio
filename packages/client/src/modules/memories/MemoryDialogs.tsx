import { X } from 'lucide-react';
import { useState, type FormEvent, type ReactNode } from 'react';

import {
    MEMORY_TEXT_MAX,
    PROFILE_FIELD_MAX,
    PROFILE_FIELDS,
    PROFILE_LABELS,
    type MemoryItem,
    type ProfileField,
    type ProfileFields,
    type UserProfile,
} from '@socio/shared/memory';
import { ianaTimeZone } from '@socio/shared/time-zone';

import { PermissionRow } from '@/components/form-fields';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

// The shell's dialogs' type scale (WorkspaceDialog): 11 px labels and
// notes, 16 px fields below md so iOS doesn't zoom in.
const label = 'mt-[23px] mb-2 block text-[11px] font-medium text-muted-foreground';
const note = 'text-[11px] leading-[1.7] text-muted-foreground';
const field = 'h-10 rounded-[9px] px-3 md:text-xs';
const area = 'min-h-26 rounded-[9px] p-3 leading-[1.65] md:text-xs';
/** The dialogs' type scale, for other dialogs in their look (CB-181). */
export const memoryDialogStyles = { label, note, field, area };

const PLACEHOLDERS: Partial<Record<ProfileField, string>> = {
    name: 'Sam',
    pronouns: 'she/her',
    role: 'Design lead, growth team',
    timezone: 'Europe/Madrid',
    language: 'English, Spanish for chit-chat',
    style: 'Short answers, bullet points, no preamble.',
    instructions: 'Ask before scheduling anything on Fridays.',
};
const LONG = new Set<ProfileField>(['style', 'instructions']);

/** A dialog in the shell's look: eyebrow, title, the form and Save. */
export function MemoryDialog({
    title,
    slot,
    onClose,
    onSave,
    children,
}: {
    title: string;
    slot: string;
    onClose: () => void;
    /** Resolves to an error to show, or nothing once saved. */
    onSave: () => Promise<string | undefined>;
    children: ReactNode;
}) {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const submit = async (event: FormEvent) => {
        event.preventDefault();
        setBusy(true);
        setError('');
        const failed = await onSave();
        setBusy(false);
        if (failed) {
            setError(failed);
        } else {
            onClose();
        }
    };
    return (
        <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
            <DialogContent
                data-slot={slot}
                showCloseButton={false}
                aria-describedby={undefined}
                overlayClassName="bg-black/20 backdrop-blur-[4px] dark:bg-black/45"
                className="block max-h-[calc(100dvh-48px)] overflow-y-auto rounded-[13px] bg-card px-[23px] py-7.5 text-sm shadow-2xl sm:max-w-115 sm:rounded-[17px] sm:p-9"
            >
                <DialogClose asChild>
                    <Button
                        variant="ghost"
                        size="icon"
                        className="absolute top-[15px] right-[15px] size-7.5 text-muted-foreground"
                        aria-label="Close dialog"
                    >
                        <X className="size-4.5" />
                    </Button>
                </DialogClose>
                <span className="text-xs font-semibold tracking-[1.7px] text-muted-foreground">SOCIO</span>
                <DialogTitle className="mt-[13px] mb-2 text-[25px] leading-tight font-[550] tracking-[-0.04em] sm:text-[27px]">
                    {title}
                </DialogTitle>
                <form onSubmit={submit}>
                    {children}
                    {error && (
                        <p
                            className="mt-4 rounded-lg bg-destructive/10 p-3 text-[11px] leading-[1.8] text-destructive"
                            role="alert"
                        >
                            {error}
                        </p>
                    )}
                    <Button className="mt-[15px] w-full text-xs" disabled={busy}>
                        {busy ? 'Saving…' : 'Save'}
                    </Button>
                </form>
            </DialogContent>
        </Dialog>
    );
}

const TEAM_NOTE =
    'Chats with other people in them, such as a Telegram team topic, use it too. Off, it stays in your own chats.';

/** Add a memory, or edit one (a proposal too, before approving it). */
export function MemoryEditor({
    memory,
    onClose,
    onSave,
}: {
    memory?: MemoryItem;
    onClose: () => void;
    onSave: (body: { text: string; shareable: boolean }) => Promise<string | undefined>;
}) {
    const [text, setText] = useState(memory?.text ?? '');
    const [shareable, setShareable] = useState(memory?.shareable ?? false);
    return (
        <MemoryDialog
            title={memory ? 'Keep it accurate.' : 'Something to remember.'}
            slot="memory-editor"
            onClose={onClose}
            onSave={() => onSave({ text: text.trim(), shareable })}
        >
            <label className={label} htmlFor="memory-text">
                Preference or context
            </label>
            <Textarea
                id="memory-text"
                className={area}
                rows={4}
                maxLength={MEMORY_TEXT_MAX}
                required
                value={text}
                onChange={(event) => setText(event.target.value)}
            />
            <PermissionRow compact title="Use in team chats" checked={shareable} onCheckedChange={setShareable}>
                {TEAM_NOTE}
            </PermissionRow>
            <p className={cn(note, 'mt-2')}>
                Your socios get the memories that bear on what you ask, with your message. Avoid secrets: memories in
                use go to your model provider.
            </p>
        </MemoryDialog>
    );
}

/**
 * The profile's time zone (CB-159): a time zone name, with the browser's
 * zones to pick from, and whether it was detected from their browser.
 * Socios give the person times in it.
 */
function TimeZoneField({ detected, ...props }: Parameters<typeof Input>[0] & { detected: boolean }) {
    const [zones] = useState(() => Intl.supportedValuesOf('timeZone'));
    return (
        <>
            <Input className={field} list="profile-timezones" {...props} />
            <datalist id="profile-timezones">
                {zones.map((zone) => (
                    <option key={zone} value={zone} />
                ))}
            </datalist>
            <p className={cn(note, 'mt-2')} data-slot="profile-timezone-note">
                {detected
                    ? 'Detected from your browser. Change it if it’s wrong: your socios give you times in it.'
                    : props.value && !ianaTimeZone(props.value)
                      ? 'Not a time zone name your socios can use: they use your browser’s until you pick one, like Europe/Madrid.'
                      : 'A time zone name. Your socios give you times in it; empty, they use your browser’s.'}
            </p>
        </>
    );
}

/** The person's profile: how socios address them and work with them. */
export function ProfileEditor({
    profile,
    onClose,
    onSave,
}: {
    profile: UserProfile | null;
    onClose: () => void;
    onSave: (body: { fields: ProfileFields; shareable: boolean }) => Promise<string | undefined>;
}) {
    const [fields, setFields] = useState<ProfileFields>(profile?.fields ?? {});
    const [shareable, setShareable] = useState(profile?.shareable ?? false);
    return (
        <MemoryDialog
            title="Tell your socios about you."
            slot="profile-editor"
            onClose={onClose}
            onSave={() => onSave({ fields, shareable })}
        >
            <p className={note}>Everything is optional. Only your socios read it, in your chats.</p>
            {PROFILE_FIELDS.map((name) => {
                const props = {
                    id: `profile-${name}`,
                    maxLength: PROFILE_FIELD_MAX[name],
                    placeholder: PLACEHOLDERS[name],
                    value: fields[name] ?? '',
                    onChange: (event: { target: { value: string } }) =>
                        setFields((current) => ({
                            ...current,
                            [name]: event.target.value,
                        })),
                };
                return (
                    <div key={name}>
                        <label className={label} htmlFor={props.id}>
                            {PROFILE_LABELS[name]}
                        </label>
                        {LONG.has(name) ? (
                            <Textarea className={area} rows={3} {...props} />
                        ) : name === 'timezone' ? (
                            <TimeZoneField
                                {...props}
                                detected={!!profile?.timezoneDetected && fields.timezone === profile.fields.timezone}
                            />
                        ) : (
                            <Input className={field} {...props} />
                        )}
                    </div>
                );
            })}
            <PermissionRow compact title="Use in team chats" checked={shareable} onCheckedChange={setShareable}>
                {TEAM_NOTE}
            </PermissionRow>
            <p className={cn(note, 'mt-2')}>
                It shapes how socios talk with you. It can’t change what they may do: permissions and approvals stay as
                they are.
            </p>
        </MemoryDialog>
    );
}

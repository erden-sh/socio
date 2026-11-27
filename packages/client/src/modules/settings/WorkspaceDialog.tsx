import { Check, X } from 'lucide-react';
import { useState } from 'react';

import { Trans, useTranslation } from '@socio/i18n/react';
import type { ModelChoice } from '@socio/shared/inference';
import { characterOf, LOCAL_NAMES, LOCALS, type LocalId } from '@socio/shared/mascot';
import { isAdmin } from '@socio/shared/roles';
import type { Dot, Memory, State, WorkspaceState } from '@socio/shared/types';

import { Mascot } from '../../locals/Mascot';
import { ModelSelect, useModelOptions } from '../chat/ModelSelect';
import { SoulLink } from '../dots/SoulLink';
import { SpaceAudienceField } from '../spaces/SpaceAudienceField';

import { WebIdentityField, useWebIdentity } from './WebIdentityField';

import { DialogFieldset, dialogSelect, PermissionRow } from '@/components/form-fields';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog as DialogRoot, DialogClose, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

/** The dialogs the shell opens over any page. */
export type EntityDialog =
    | { type: 'space' }
    | { type: 'dot'; dot?: Dot; spaceId: string }
    | { type: 'memory'; memory?: Memory }
    | { type: 'schedule'; threadId: string };
/**
 * What `openDialog` takes. `settings` is the old Settings dialog: the shell
 * opens the settings pages (`/settings/workspace`) for it instead.
 */
export type Dialog = EntityDialog | { type: 'settings' };

// The dialogs' type scale (CB-95, kept from the legacy modal): 11 px labels
// and notes. Fields are 16 px below md, so iOS doesn't zoom in (CB-96).
const label = 'mt-[23px] mb-2 block text-[11px] font-medium text-muted-foreground';
const note = 'text-[11px] leading-[1.7] text-muted-foreground';
const field = 'h-10 rounded-[9px] px-3 md:text-xs';
export function WorkspaceDialog({
    dialog,
    state,
    workspace,
    onClose,
    mutate,
}: {
    dialog: EntityDialog;
    state: State;
    workspace: WorkspaceState;
    onClose: () => void;
    mutate: (path: string, method: string, body?: unknown) => Promise<boolean>;
}) {
    // Loaded on demand (route-namespaces.json inlines it nowhere): the
    // dialog opens only after a click.
    const { t, ready } = useTranslation(['settings', 'settings.dialogs']);
    const [name, setName] = useState(dialog.type === 'dot' ? (dialog.dot?.name ?? '') : '');
    const [text, setText] = useState(
        dialog.type === 'dot'
            ? (dialog.dot?.instructions ?? '')
            : dialog.type === 'memory'
              ? (dialog.memory?.text ?? '')
              : '',
    );
    const [research, setResearch] = useState(
        dialog.type === 'dot' ? (dialog.dot?.researchAllowed ?? true) : state.settings.researchAllowed,
    );
    const [memory, setMemory] = useState(
        dialog.type === 'dot' ? (dialog.dot?.memoryAllowed ?? true) : state.settings.memoryAllowed,
    );
    const [spaceIds, setSpaceIds] = useState(dialog.type === 'dot' ? (dialog.dot?.spaceIds ?? [dialog.spaceId]) : []);
    const [defaultSpace, setDefaultSpace] = useState(
        dialog.type === 'dot' ? (dialog.dot?.spaceId ?? dialog.spaceId) : '',
    );
    const [interval, setInterval] = useState('86400');
    const [learningContainer, setLearningContainer] = useState(
        dialog.type === 'dot' ? (dialog.dot?.learningContainerId ?? '') : '',
    );
    const [issues, setIssues] = useState(dialog.type === 'dot' ? (dialog.dot?.issuesAllowed ?? false) : false);
    const [skillDelivery, setSkillDelivery] = useState(
        dialog.type === 'dot' ? (dialog.dot?.skillDeliveryEnabled ?? false) : false,
    );
    const web = useWebIdentity(dialog.type === 'dot' ? dialog.dot?.id : undefined);
    const [model, setModel] = useState<ModelChoice | null>(
        dialog.type === 'dot' ? (dialog.dot?.inference ?? null) : null,
    );
    // An existing socio's look stays until changed; a new one suggests a
    // character none of the person's socios has yet (CB-256).
    const [character, setCharacter] = useState<LocalId>(() =>
        dialog.type === 'dot' && dialog.dot
            ? characterOf(dialog.dot)
            : (LOCALS.find((local) => !workspace.dots.some((dot) => characterOf(dot) === local)) ?? LOCALS[0]),
    );
    const models = useModelOptions();
    const [busy, setBusy] = useState(false);
    const [shared, setShared] = useState(false);
    // A new Space's audience (CB-181): an admin's is the whole workspace
    // unless they keep it private; anyone else's is private.
    const [privateSpace, setPrivateSpace] = useState(!isAdmin(workspace.user));
    const [error, setError] = useState('');
    // Board filing, web identity and Learning reach beyond one person: admins'.
    const admin = isAdmin(workspace.user);
    if (!ready) {
        return null;
    }
    const title =
        dialog.type === 'space'
            ? t('settings.dialogs:title.space')
            : dialog.type === 'dot'
              ? dialog.dot
                  ? t('settings.dialogs:title.dotEdit')
                  : t('settings.dialogs:title.dotNew')
              : dialog.type === 'memory'
                ? t('settings.dialogs:title.memory')
                : t('settings.dialogs:title.schedule');
    return (
        <DialogRoot open onOpenChange={(open) => !open && onClose()}>
            <DialogContent
                showCloseButton={false}
                aria-describedby={undefined}
                overlayClassName="bg-black/20 backdrop-blur-[4px] dark:bg-black/45"
                // The first field, not the close button, as before.
                onOpenAutoFocus={(event) => {
                    const first = (event.currentTarget as HTMLElement).querySelector<HTMLElement>(
                        'input,textarea,select',
                    );
                    if (!first) {
                        return;
                    }
                    event.preventDefault();
                    first.focus();
                }}
                className={cn(
                    'block max-h-[calc(100dvh-48px)] overflow-y-auto rounded-[13px] bg-card px-[23px] py-7.5 text-sm shadow-2xl sm:rounded-[17px] sm:p-9',
                    // A Dot's settings are long: as wide as the app's larger dialogs.
                    dialog.type === 'dot' ? 'sm:max-w-[42rem]' : 'sm:max-w-115',
                )}
            >
                <DialogClose asChild>
                    <Button
                        variant="ghost"
                        size="icon"
                        className="absolute top-[15px] right-[15px] size-7.5 text-muted-foreground"
                        aria-label={t('settings.dialogs:close')}
                    >
                        <X className="size-4.5" />
                    </Button>
                </DialogClose>
                {/* oxlint-disable-next-line socio/no-literal-text -- the brand's wordmark, not words */}
                <span className="text-xs font-semibold tracking-[1.7px] text-muted-foreground">SOCIO</span>
                <DialogTitle className="mt-[13px] mb-2 text-[25px] leading-tight font-[550] tracking-[-0.04em] sm:text-[27px]">
                    {title}
                </DialogTitle>
                <form
                    onSubmit={async (e) => {
                        e.preventDefault();
                        setBusy(true);
                        setError('');
                        let path = '',
                            method = 'POST',
                            body: unknown;
                        if (dialog.type === 'space') {
                            path = '/spaces';
                            body = { name, description: text, private: privateSpace };
                        }
                        if (dialog.type === 'dot') {
                            path = dialog.dot ? `/dots/${dialog.dot.id}` : '/dots';
                            method = dialog.dot ? 'PUT' : 'POST';
                            body = {
                                spaceId: defaultSpace,
                                spaceIds,
                                name,
                                // A socio's instructions are its Soul's (CB-179): set
                                // here when it's made, then on its Soul page.
                                ...(dialog.dot ? {} : { instructions: text }),
                                researchAllowed: research,
                                memoryAllowed: memory,
                                learningContainerId: learningContainer.trim() || null,
                                skillDeliveryEnabled: skillDelivery,
                                issuesAllowed: issues,
                                inference: model,
                                character,
                                ...(!dialog.dot ? { personal: !admin || !shared } : {}),
                            };
                        }
                        if (dialog.type === 'memory') {
                            path = dialog.memory ? `/memories/${dialog.memory.id}` : '/memories';
                            method = dialog.memory ? 'PUT' : 'POST';
                            body = { text };
                        }
                        if (dialog.type === 'schedule') {
                            path = '/tasks';
                            body = {
                                prompt: text,
                                threadId: dialog.threadId,
                                intervalSeconds: Number(interval),
                            };
                        }
                        if (await mutate(path, method, body)) {
                            try {
                                await web.save();
                                onClose();
                            } catch (cause) {
                                setError(cause instanceof Error ? cause.message : t('settings.dialogs:webSaveFailed'));
                            }
                        } else {
                            setError(t('settings:save.failed'));
                        }
                        setBusy(false);
                    }}
                >
                    {(dialog.type === 'space' || dialog.type === 'dot') && (
                        <>
                            <label className={label} htmlFor="entity-name">
                                {t('settings.dialogs:name')}
                            </label>
                            <Input
                                id="entity-name"
                                className={field}
                                value={name}
                                maxLength={40}
                                onChange={(e) => setName(e.target.value)}
                                required
                            />
                        </>
                    )}
                    {dialog.type === 'dot' && <CharacterPicker value={character} onChange={setCharacter} />}
                    {dialog.type === 'dot' && dialog.dot ? (
                        <SoulLink dot={dialog.dot} onOpen={onClose} />
                    ) : (
                        <>
                            <label className={label} htmlFor="entity-text">
                                {t(`settings.dialogs:text.${dialog.type}`)}
                            </label>
                            <Textarea
                                id="entity-text"
                                className="min-h-26 rounded-[9px] p-3 leading-[1.65] md:text-xs"
                                rows={4}
                                maxLength={dialog.type === 'schedule' ? 4000 : 2000}
                                required={dialog.type !== 'space'}
                                value={text}
                                onChange={(e) => setText(e.target.value)}
                                placeholder={dialog.type === 'dot' ? t('settings.dialogs:dotPlaceholder') : ''}
                            />
                        </>
                    )}
                    {dialog.type === 'space' && (
                        <SpaceAudienceField admin={admin} value={privateSpace} onChange={setPrivateSpace} />
                    )}
                    {dialog.type === 'dot' && (
                        <DialogFieldset legend={t('settings.dialogs:spaces.legend')}>
                            <p className={cn(note, 'mt-2')}>{t('settings.dialogs:spaces.note')}</p>
                            {workspace.spaces.map((space) => (
                                <label className="my-4 flex cursor-pointer items-center gap-3" key={space.id}>
                                    <Checkbox
                                        checked={spaceIds.includes(space.id)}
                                        onCheckedChange={(checked) => {
                                            const next =
                                                checked === true
                                                    ? [...spaceIds, space.id]
                                                    : spaceIds.filter((id) => id !== space.id);
                                            setSpaceIds(next);
                                            if (!next.includes(defaultSpace)) {
                                                setDefaultSpace(next[0] ?? '');
                                            }
                                        }}
                                    />
                                    <span>{space.name}</span>
                                </label>
                            ))}
                            <label className={label} htmlFor="default-space">
                                {t('settings.dialogs:spaces.default')}
                            </label>
                            <select
                                id="default-space"
                                data-slot="native-select"
                                className={dialogSelect}
                                value={defaultSpace}
                                required
                                onChange={(event) => setDefaultSpace(event.target.value)}
                            >
                                <option value="" disabled>
                                    {t('settings.dialogs:spaces.choose')}
                                </option>
                                {workspace.spaces
                                    .filter((space) => spaceIds.includes(space.id))
                                    .map((space) => (
                                        <option key={space.id} value={space.id}>
                                            {space.name}
                                        </option>
                                    ))}
                            </select>
                        </DialogFieldset>
                    )}
                    {dialog.type === 'dot' && (
                        <>
                            <PermissionRow
                                compact
                                title={t('settings.dialogs:research.title')}
                                checked={research}
                                onCheckedChange={setResearch}
                            >
                                {t('settings.dialogs:research.body')}
                            </PermissionRow>
                            <PermissionRow
                                compact
                                title={t('settings.dialogs:memories.title')}
                                checked={memory}
                                onCheckedChange={setMemory}
                            >
                                {t('settings.dialogs:memories.body')}
                            </PermissionRow>
                        </>
                    )}
                    {dialog.type === 'dot' && (
                        <>
                            {admin && !dialog.dot && (
                                <PermissionRow
                                    compact
                                    title={t('settings.dialogs:share.title')}
                                    checked={shared}
                                    onCheckedChange={setShared}
                                >
                                    {t('settings.dialogs:share.body')}
                                </PermissionRow>
                            )}
                            <p className={note} data-slot="dot-visibility">
                                {t('settings.dialogs:visibility', {
                                    context: (dialog.dot ? !dialog.dot.ownerId : admin && shared)
                                        ? 'workspace'
                                        : undefined,
                                })}
                            </p>
                        </>
                    )}
                    {dialog.type === 'dot' && admin && (
                        <PermissionRow
                            compact
                            title={t('settings.dialogs:issues.title')}
                            checked={issues}
                            onCheckedChange={setIssues}
                        >
                            {t('settings.dialogs:issues.body')}
                        </PermissionRow>
                    )}
                    {dialog.type === 'dot' && (
                        <div data-slot="dot-model">
                            <label className={label} htmlFor="dot-model">
                                {t('settings.dialogs:model.label')}
                            </label>
                            <ModelSelect
                                id="dot-model"
                                className={dialogSelect}
                                value={model}
                                onChange={setModel}
                                options={models?.options ?? []}
                                disabled={!models}
                                inheritLabel={t('settings.dialogs:model.inherit')}
                            />
                            <p className={note}>{t('settings.dialogs:model.note')}</p>
                        </div>
                    )}
                    {dialog.type === 'dot' && admin && (
                        <WebIdentityField status={web.status} choice={web.choice} onChange={web.setChoice} />
                    )}
                    {dialog.type === 'dot' && admin && (
                        <DialogFieldset legend={t('settings.dialogs:learning.legend')}>
                            <label className={label} htmlFor="learning-container">
                                {t('settings.dialogs:learning.container')}
                            </label>
                            <Input
                                id="learning-container"
                                className={field}
                                value={learningContainer}
                                maxLength={64}
                                pattern="[a-z0-9]+(-[a-z0-9]+)*"
                                placeholder={t('settings.dialogs:learning.placeholder')}
                                aria-describedby="learning-help"
                                onChange={(event) => {
                                    setLearningContainer(event.target.value);
                                    if (!event.target.value.trim()) {
                                        setSkillDelivery(false);
                                    }
                                }}
                            />
                            <p className={note} id="learning-help">
                                {t('settings.dialogs:learning.help')}
                            </p>
                            <PermissionRow
                                compact
                                title={t('settings.dialogs:learning.skillsTitle')}
                                checked={skillDelivery}
                                disabled={!learningContainer.trim()}
                                onCheckedChange={setSkillDelivery}
                            >
                                {t('settings.dialogs:learning.skillsBody')}
                            </PermissionRow>
                        </DialogFieldset>
                    )}
                    {dialog.type === 'dot' && dialog.dot && (admin || dialog.dot.ownerId === workspace.user.id) && (
                        <ArchiveDot dot={dialog.dot} mutate={mutate} onDone={onClose} />
                    )}
                    {dialog.type === 'dot' && dialog.dot && (
                        <p className={note} data-slot="dot-data-links">
                            <Trans
                                t={t}
                                i18nKey="settings.dialogs:dataLinks"
                                components={{
                                    approvals: (
                                        <a
                                            className="underline underline-offset-2 hover:text-foreground"
                                            href={`/approvals?dot=${encodeURIComponent(dialog.dot.id)}`}
                                        />
                                    ),
                                    grants: (
                                        <a
                                            className="underline underline-offset-2 hover:text-foreground"
                                            href="/data?tab=dots"
                                        />
                                    ),
                                }}
                            />
                        </p>
                    )}
                    {dialog.type === 'schedule' && (
                        <>
                            <label className={label} htmlFor="schedule-interval">
                                {t('settings.dialogs:schedule.label')}
                            </label>
                            <select
                                id="schedule-interval"
                                data-slot="native-select"
                                className={dialogSelect}
                                value={interval}
                                onChange={(e) => setInterval(e.target.value)}
                            >
                                <option value="60">{t('settings.dialogs:schedule.minute')}</option>
                                <option value="3600">{t('settings.dialogs:schedule.hour')}</option>
                                <option value="86400">{t('settings.dialogs:schedule.day')}</option>
                                <option value="604800">{t('settings.dialogs:schedule.week')}</option>
                            </select>
                            <p className={cn(note, 'mt-2')}>{t('settings.dialogs:schedule.note')}</p>
                        </>
                    )}
                    {dialog.type === 'memory' && <p className={cn(note, 'mt-2')}>{t('settings.dialogs:memoryNote')}</p>}
                    {error && (
                        <p
                            className="mt-4 rounded-lg bg-destructive/10 p-3 text-[11px] leading-[1.8] text-destructive"
                            role="alert"
                        >
                            {error}
                        </p>
                    )}
                    <Button className="mt-[15px] w-full text-xs" disabled={busy}>
                        {busy ? t('settings:save.saving') : t('settings.dialogs:save')}
                    </Button>
                </form>
            </DialogContent>
        </DialogRoot>
    );
}

/**
 * Archive (never delete) a Dot, or bring it back: its owner or an admin.
 * An archived Dot leaves every list; its chats stay readable and its
 * schedules and goals pause.
 */
/**
 * A socio's character (CB-256): one of the Locals, as radio buttons so
 * arrow keys move between them; two across on a phone, four from `sm`.
 * Several socios may share one.
 */
function CharacterPicker({ value, onChange }: { value: LocalId; onChange: (value: LocalId) => void }) {
    const { t } = useTranslation(['settings.dialogs']);
    return (
        <fieldset data-slot="dot-character" className="mt-[23px]">
            <legend className="mb-2 text-[11px] font-medium text-muted-foreground">
                {t('settings.dialogs:character.legend')}
            </legend>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {LOCALS.map((local) => (
                    <label
                        key={local}
                        className="group relative flex min-w-0 cursor-pointer flex-col items-center gap-1 rounded-[10px] border p-2 text-center transition-colors hover:bg-accent has-checked:border-primary has-checked:bg-accent has-focus-visible:ring-[3px] has-focus-visible:ring-ring/50"
                    >
                        <input
                            type="radio"
                            name="dot-character"
                            value={local}
                            checked={value === local}
                            onChange={() => onChange(local)}
                            aria-label={t('settings.dialogs:character.label', {
                                name: LOCAL_NAMES[local].name,
                                kind: LOCAL_NAMES[local].kind,
                            })}
                            className="sr-only"
                        />
                        {/* Not by color alone: a tick marks the choice. */}
                        <Check
                            aria-hidden
                            className="absolute top-1.5 right-1.5 hidden size-4 text-primary group-has-checked:block"
                        />
                        <Mascot identity={local} character={local} small decorative className="size-12!" />
                        <span className="text-sm font-medium">{LOCAL_NAMES[local].name}</span>
                        <span className="text-[11px] leading-tight text-muted-foreground">
                            {LOCAL_NAMES[local].kind}
                        </span>
                    </label>
                ))}
            </div>
            <p className={cn(note, 'mt-2')}>{t('settings.dialogs:character.note')}</p>
        </fieldset>
    );
}
function ArchiveDot({
    dot,
    mutate,
    onDone,
}: {
    dot: Dot;
    mutate: (path: string, method: string, body?: unknown) => Promise<boolean>;
    onDone: () => void;
}) {
    const { t } = useTranslation(['settings.dialogs']);
    const [confirming, setConfirming] = useState(false);
    const archived = !!dot.archivedAt;
    const run = async () => {
        if (await mutate(`/dots/${encodeURIComponent(dot.id)}/${archived ? 'unarchive' : 'archive'}`, 'POST')) {
            onDone();
        }
    };
    return (
        <div className="my-5.5 flex items-center gap-3" data-slot="dot-archive">
            <span className="grid flex-1 gap-1">
                <strong className="text-[11px] font-[550]">
                    {t('settings.dialogs:archive.title', { context: archived ? 'archived' : undefined })}
                </strong>
                <small className="text-[10px] leading-[1.7] text-muted-foreground">
                    {t('settings.dialogs:archive.body', { context: archived ? 'archived' : undefined })}
                </small>
            </span>
            <Button
                type="button"
                variant="outline"
                size="sm"
                className="shrink-0 text-xs"
                onClick={() => (archived || confirming ? void run() : setConfirming(true))}
            >
                {archived
                    ? t('settings.dialogs:archive.unarchive')
                    : confirming
                      ? t('settings.dialogs:archive.confirm')
                      : t('settings.dialogs:archive.archive')}
            </Button>
        </div>
    );
}

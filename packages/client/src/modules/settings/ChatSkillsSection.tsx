import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { toast } from 'sonner';

import { Trans, useTranslation } from '@socio/i18n/react';
import {
    CHAT_SKILL_MODES,
    CHAT_SKILL_NAME,
    RESERVED_SKILL_NAMES,
    SKILL_DESCRIPTION_MAX,
    SKILL_INSTRUCTIONS_MAX,
    IMPORTED_SKILL_DESCRIPTION_MAX,
    IMPORTED_SKILL_INSTRUCTIONS_MAX,
    type ChatSkillLock,
    type ChatSkillMode,
    type ChatSkillRevisionView,
    type ChatSkillView,
} from '@socio/shared/chat/chat-skills';

import { api } from '../../lib/api';
import { loadChatSkills } from '../chat/chat-skills';

import { nativeSelect } from './AccountSettings';
import { SkillImportSection } from './SkillImportSection';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';

const failed = (e: unknown, fallback: string) => toast.error(e instanceof Error ? e.message : fallback);

const empty = {
    name: '',
    description: '',
    instructions: '',
    mode: 'turn' as ChatSkillMode,
};

/** Where a skill came from, as its lock record says, in a line. */
function useLockLine() {
    const { t } = useTranslation(['settings.chat-skills']);
    return (lock: ChatSkillLock) => {
        const digest = t('settings.chat-skills:lock.digest', { hash: lock.sha256.slice(0, 12) });
        let parts: string[];
        if (lock.url) {
            // The repository path and commit, as git writes them: not words.
            const source = `${lock.url.replace(/^https:\/\/github\.com\//, '')}${lock.path ? `/${lock.path}` : ''}${lock.commit ? ` @ ${lock.commit.slice(0, 7)}` : ''}`;
            parts = [
                t('settings.chat-skills:lock.adapted', {
                    source,
                    license: lock.license ?? '',
                    context: lock.license ? 'license' : undefined,
                }),
                ...(lock.locallyModified ? [t('settings.chat-skills:lock.edited')] : []),
                digest,
            ];
        } else if (lock.source === 'builtin') {
            parts = [t('settings.chat-skills:lock.builtIn'), digest];
        } else {
            parts = [
                t('settings.chat-skills:lock.revision', { revision: lock.revision ?? '' }),
                digest,
                ...(lock.updatedAt ? [t('settings.chat-skills:when', { when: new Date(lock.updatedAt) })] : []),
            ];
        }
        return parts.join(' · ');
    };
}

/** A workspace skill's revisions, newest first, each one a rollback away. */
function History({ name, onRolledBack }: { name: string; onRolledBack: () => void }) {
    const { t } = useTranslation(['settings.chat-skills']);
    const [revisions, setRevisions] = useState<ChatSkillRevisionView[]>();
    const load = useCallback(
        () =>
            api<{ revisions: ChatSkillRevisionView[] }>(`/chat-skills/${encodeURIComponent(name)}/revisions`)
                .then((answer) => setRevisions(answer.revisions))
                .catch((e) => failed(e, t('settings.chat-skills:history.loadFailed'))),
        [name, t],
    );
    useEffect(() => void load(), [load]);
    const rollback = (revision: number) =>
        void api(`/chat-skills/${encodeURIComponent(name)}/rollback`, 'POST', {
            revision,
        })
            .then(() => {
                toast.success(t('settings.chat-skills:history.rolledBack', { name, revision }));
                onRolledBack();
                return load();
            })
            .catch((error) => failed(error, t('settings.chat-skills:history.rollBackFailed')));
    const current = revisions?.[0]?.revision;
    return (
        <ol
            className="grid basis-full gap-1 border-t pt-2"
            aria-label={t('settings.chat-skills:history.label', { name })}
        >
            {revisions?.map((revision) => (
                <li
                    key={revision.revision}
                    className="flex flex-wrap items-center gap-x-2"
                    data-revision={revision.revision}
                >
                    <span className="font-medium">
                        {t('settings.chat-skills:history.revision', { revision: revision.revision })}
                    </span>
                    <span className="min-w-0 flex-1 text-muted-foreground">
                        <Trans
                            t={t}
                            i18nKey="settings.chat-skills:history.line"
                            context={revision.restoredFrom ? 'restored' : undefined}
                            values={{
                                when: t('settings.chat-skills:when', { when: new Date(revision.createdAt) }),
                                who: revision.createdByName ?? revision.createdBy,
                                mode: t(`settings.chat-skills:mode.${revision.mode}`),
                                hash: revision.sha256.slice(0, 12),
                                restored: revision.restoredFrom ?? 0,
                            }}
                            components={{ hash: <code className="text-xs" /> }}
                        />
                    </span>
                    {revision.revision === current ? (
                        <span className="text-muted-foreground">{t('settings.chat-skills:history.current')}</span>
                    ) : (
                        <Button variant="ghost" size="sm" onClick={() => rollback(revision.revision)}>
                            {t('settings.chat-skills:history.rollBack')}
                        </Button>
                    )}
                </li>
            ))}
        </ol>
    );
}

/**
 * Admins: Settings → Chat skills (CB-143). The built-in skills, then the
 * workspace's own: each a name people type after `/`, a description the
 * `/` menu shows, the instructions the Dot follows, and how long they
 * apply (that message, or until the person is done). Every save keeps a
 * revision, with its lock record; any can be rolled back to. Saved at
 * once, for the next message.
 */
export function ChatSkillsSection() {
    const { t } = useTranslation(['settings', 'settings.chat-skills']);
    const lockLine = useLockLine();
    const [skills, setSkills] = useState<ChatSkillView[]>();
    // The skill being edited: its name, or '' for a new one.
    const [editing, setEditing] = useState<string>();
    // The skill whose history is open.
    const [history, setHistory] = useState<string>();
    const [form, setForm] = useState(empty);
    const load = useCallback(
        () =>
            api<{ skills: ChatSkillView[] }>('/chat-skills')
                .then((answer) => setSkills(answer.skills))
                .catch((e) => failed(e, t('settings.chat-skills:loadFailed'))),
        [t],
    );
    useEffect(() => void load(), [load]);
    const refresh = async () => {
        await load();
        // The composer's `/` menu reads them again.
        void loadChatSkills(true);
    };
    const done = async () => {
        setEditing(undefined);
        setForm(empty);
        await refresh();
    };
    const name = form.name.trim().toLowerCase();
    const imported = skills?.find((skill) => skill.name === editing)?.lock?.source === 'git';
    const nameError =
        editing === '' && name
            ? !CHAT_SKILL_NAME.test(name)
                ? t('settings.chat-skills:form.invalidName')
                : RESERVED_SKILL_NAMES.includes(name) || skills?.some((skill) => skill.name === name)
                  ? t('settings.chat-skills:form.takenName', { name })
                  : ''
            : '';
    const save = (e: FormEvent) => {
        e.preventDefault();
        void api(`/chat-skills/${encodeURIComponent(name)}`, 'PUT', {
            description: form.description,
            instructions: form.instructions,
            mode: form.mode,
        })
            .then(() => {
                toast.success(t('settings.chat-skills:saved', { name }));
                return done();
            })
            .catch((error) => failed(error, t('settings.chat-skills:saveFailed')));
    };
    const remove = (skill: ChatSkillView) => {
        if (!globalThis.confirm(t('settings.chat-skills:confirmRemove', { name: skill.name }))) {
            return;
        }
        void api(`/chat-skills/${encodeURIComponent(skill.name)}`, 'DELETE')
            .then(done)
            .catch((error) => failed(error, t('settings.chat-skills:removeFailed')));
    };
    const editor = (
        <form
            className="grid gap-2 rounded-md border border-dashed p-3"
            aria-label={
                editing ? t('settings.chat-skills:form.edit', { name: editing }) : t('settings.chat-skills:form.new')
            }
            onSubmit={save}
        >
            <label className="grid gap-1">
                <span className="font-medium">{t('settings.chat-skills:form.name')}</span>
                <span className="flex items-center gap-1">
                    {/* oxlint-disable-next-line socio/no-literal-text -- the slash that starts a command, not words */}
                    <span className="text-muted-foreground">/</span>
                    <Input
                        aria-label={t('settings.chat-skills:form.nameLabel')}
                        placeholder={t('settings.chat-skills:form.namePlaceholder')}
                        required
                        maxLength={32}
                        className="max-w-56"
                        disabled={editing !== ''}
                        value={form.name}
                        onChange={(e) => setForm({ ...form, name: e.target.value })}
                    />
                </span>
                {nameError && <span className="text-destructive">{nameError}</span>}
            </label>
            <label className="grid gap-1">
                <span className="font-medium">{t('settings.chat-skills:form.description')}</span>
                <Input
                    aria-label={t('settings.chat-skills:form.descriptionLabel')}
                    placeholder={t('settings.chat-skills:form.descriptionPlaceholder')}
                    required
                    maxLength={imported ? IMPORTED_SKILL_DESCRIPTION_MAX : SKILL_DESCRIPTION_MAX}
                    value={form.description}
                    onChange={(e) => setForm({ ...form, description: e.target.value })}
                />
            </label>
            <label className="grid gap-1">
                <span className="font-medium">{t('settings.chat-skills:form.instructions')}</span>
                <Textarea
                    aria-label={t('settings.chat-skills:form.instructionsLabel')}
                    placeholder={t('settings.chat-skills:form.instructionsPlaceholder')}
                    required
                    rows={5}
                    maxLength={imported ? IMPORTED_SKILL_INSTRUCTIONS_MAX : SKILL_INSTRUCTIONS_MAX}
                    value={form.instructions}
                    onChange={(e) => setForm({ ...form, instructions: e.target.value })}
                />
            </label>
            <label className="grid gap-1">
                <span className="font-medium">{t('settings.chat-skills:form.mode')}</span>
                <select
                    aria-label={t('settings.chat-skills:form.modeLabel')}
                    className={`${nativeSelect} w-fit`}
                    value={form.mode}
                    onChange={(e) => setForm({ ...form, mode: e.target.value as ChatSkillMode })}
                >
                    {CHAT_SKILL_MODES.map((mode) => (
                        <option key={mode} value={mode}>
                            {t(`settings.chat-skills:mode.${mode}`)}
                        </option>
                    ))}
                </select>
                <span className="text-muted-foreground">{t('settings.chat-skills:form.modeHelp')}</span>
            </label>
            <span className="flex gap-1">
                <Button
                    size="sm"
                    disabled={!name || !!nameError || !form.description.trim() || !form.instructions.trim()}
                >
                    {t('settings.chat-skills:form.save')}
                </Button>
                <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                        setEditing(undefined);
                        setForm(empty);
                    }}
                >
                    {t('settings.chat-skills:form.cancel')}
                </Button>
            </span>
        </form>
    );
    return (
        <section className="grid gap-3" data-slot="chat-skills">
            <div className="grid gap-1">
                <h3 className="font-medium">{t('settings:sections.chat-skills')}</h3>
                <p className="text-muted-foreground">
                    <Trans
                        t={t}
                        i18nKey="settings.chat-skills:intro"
                        components={{ code: <code className="text-xs" /> }}
                    />
                </p>
            </div>
            <SkillImportSection onSaved={refresh} />
            <ul className="grid gap-2" aria-label={t('settings:sections.chat-skills')}>
                {skills?.map((skill) =>
                    editing === skill.name ? (
                        <li key={skill.name}>{editor}</li>
                    ) : (
                        <li
                            key={skill.name}
                            className="flex flex-wrap items-start gap-2 rounded-md border p-3"
                            data-skill={skill.name}
                        >
                            <span className="grid min-w-0 flex-1 gap-0.5">
                                <span>
                                    <span className="font-medium">{`/${skill.name}`}</span>{' '}
                                    <span className="text-muted-foreground">
                                        {skill.builtIn
                                            ? t('settings.chat-skills:list.builtIn', {
                                                  context: skill.mode === 'until-done' ? 'untilDone' : undefined,
                                              })
                                            : t('settings.chat-skills:list.workspace', {
                                                  context: skill.mode === 'until-done' ? 'untilDone' : undefined,
                                              })}
                                    </span>
                                </span>
                                <span className="text-muted-foreground">{skill.description}</span>
                                {skill.lock && (
                                    <span className="text-xs text-muted-foreground" data-slot="skill-lock">
                                        {lockLine(skill.lock)}
                                    </span>
                                )}
                            </span>
                            {!skill.builtIn && (
                                <span className="flex gap-1">
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        aria-expanded={history === skill.name}
                                        onClick={() => setHistory(history === skill.name ? undefined : skill.name)}
                                    >
                                        {t('settings.chat-skills:list.history')}
                                    </Button>
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        onClick={() => {
                                            setEditing(skill.name);
                                            setForm({
                                                name: skill.name,
                                                description: skill.description,
                                                instructions: skill.instructions ?? '',
                                                mode: skill.mode ?? 'turn',
                                            });
                                        }}
                                    >
                                        {t('settings.chat-skills:list.edit')}
                                    </Button>
                                    <Button variant="ghost" size="sm" onClick={() => remove(skill)}>
                                        {t('settings.chat-skills:list.remove')}
                                    </Button>
                                </span>
                            )}
                            {history === skill.name && (
                                <History name={skill.name} onRolledBack={() => void refresh()} />
                            )}
                        </li>
                    ),
                )}
            </ul>
            {editing === '' ? (
                editor
            ) : (
                <span>
                    <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                            setEditing('');
                            setForm(empty);
                        }}
                    >
                        {t('settings.chat-skills:list.add')}
                    </Button>
                </span>
            )}
        </section>
    );
}

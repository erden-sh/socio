import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { toast } from 'sonner';

import {
    CHAT_SKILL_MODES,
    CHAT_SKILL_MODE_LABELS,
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
const when = (at: number) => new Date(at).toLocaleString();

/** Where a skill came from, as its lock record says, in a line. */
function lockLine(lock: ChatSkillLock) {
    const digest = `sha256 ${lock.sha256.slice(0, 12)}`;
    if (lock.url) {
        return `Adapted from ${lock.url.replace(/^https:\/\/github\.com\//, '')}${lock.path ? `/${lock.path}` : ''}${lock.commit ? ` @ ${lock.commit.slice(0, 7)}` : ''}${lock.license ? ` (${lock.license})` : ''}${lock.locallyModified ? ' · locally edited' : ''} · ${digest}`;
    }
    return lock.source === 'builtin'
        ? `Built in · ${digest}`
        : `Revision ${lock.revision} · ${digest}${lock.updatedAt ? ` · ${when(lock.updatedAt)}` : ''}`;
}

/** A workspace skill's revisions, newest first, each one a rollback away. */
function History({ name, onRolledBack }: { name: string; onRolledBack: () => void }) {
    const [revisions, setRevisions] = useState<ChatSkillRevisionView[]>();
    const load = useCallback(
        () =>
            api<{ revisions: ChatSkillRevisionView[] }>(`/chat-skills/${encodeURIComponent(name)}/revisions`)
                .then((answer) => setRevisions(answer.revisions))
                .catch((e) => failed(e, 'Could not load the history.')),
        [name],
    );
    useEffect(() => void load(), [load]);
    const rollback = (revision: number) =>
        void api(`/chat-skills/${encodeURIComponent(name)}/rollback`, 'POST', {
            revision,
        })
            .then(() => {
                toast.success(`/${name} is back to revision ${revision}`);
                onRolledBack();
                return load();
            })
            .catch((error) => failed(error, 'Could not roll back.'));
    const current = revisions?.[0]?.revision;
    return (
        <ol className="grid basis-full gap-1 border-t pt-2" aria-label={`History of /${name}`}>
            {revisions?.map((revision) => (
                <li
                    key={revision.revision}
                    className="flex flex-wrap items-center gap-x-2"
                    data-revision={revision.revision}
                >
                    <span className="font-medium">Revision {revision.revision}</span>
                    <span className="min-w-0 flex-1 text-muted-foreground">
                        {when(revision.createdAt)} · {revision.createdByName ?? revision.createdBy} ·{' '}
                        {CHAT_SKILL_MODE_LABELS[revision.mode]} ·{' '}
                        <code className="text-xs">{revision.sha256.slice(0, 12)}</code>
                        {revision.restoredFrom ? ` · restored revision ${revision.restoredFrom}` : ''}
                    </span>
                    {revision.revision === current ? (
                        <span className="text-muted-foreground">Current</span>
                    ) : (
                        <Button variant="ghost" size="sm" onClick={() => rollback(revision.revision)}>
                            Roll back
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
                .catch((e) => failed(e, 'Could not load the chat skills.')),
        [],
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
                ? 'Lowercase letters, digits and hyphens, up to 32.'
                : RESERVED_SKILL_NAMES.includes(name) || skills?.some((skill) => skill.name === name)
                  ? `/${name} is taken.`
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
                toast.success(`/${name} saved`);
                return done();
            })
            .catch((error) => failed(error, 'Could not save the skill.'));
    };
    const remove = (skill: ChatSkillView) => {
        if (
            !globalThis.confirm(
                `Remove /${skill.name}? People can no longer use it; chats that used it stay as they are.`,
            )
        ) {
            return;
        }
        void api(`/chat-skills/${encodeURIComponent(skill.name)}`, 'DELETE')
            .then(done)
            .catch((error) => failed(error, 'Could not remove the skill.'));
    };
    const editor = (
        <form
            className="grid gap-2 rounded-md border border-dashed p-3"
            aria-label={editing ? `Edit /${editing}` : 'New skill'}
            onSubmit={save}
        >
            <label className="grid gap-1">
                <span className="font-medium">Name</span>
                <span className="flex items-center gap-1">
                    <span className="text-muted-foreground">/</span>
                    <Input
                        aria-label="Skill name"
                        placeholder="standup"
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
                <span className="font-medium">Description</span>
                <Input
                    aria-label="Skill description"
                    placeholder="What it does, as the / menu shows it"
                    required
                    maxLength={imported ? IMPORTED_SKILL_DESCRIPTION_MAX : SKILL_DESCRIPTION_MAX}
                    value={form.description}
                    onChange={(e) => setForm({ ...form, description: e.target.value })}
                />
            </label>
            <label className="grid gap-1">
                <span className="font-medium">Instructions</span>
                <Textarea
                    aria-label="Skill instructions"
                    placeholder="What the socio does once a message starts with this skill."
                    required
                    rows={5}
                    maxLength={imported ? IMPORTED_SKILL_INSTRUCTIONS_MAX : SKILL_INSTRUCTIONS_MAX}
                    value={form.instructions}
                    onChange={(e) => setForm({ ...form, instructions: e.target.value })}
                />
            </label>
            <label className="grid gap-1">
                <span className="font-medium">Applies to</span>
                <select
                    aria-label="Skill applies to"
                    className={`${nativeSelect} w-fit`}
                    value={form.mode}
                    onChange={(e) => setForm({ ...form, mode: e.target.value as ChatSkillMode })}
                >
                    {CHAT_SKILL_MODES.map((mode) => (
                        <option key={mode} value={mode}>
                            {CHAT_SKILL_MODE_LABELS[mode]}
                        </option>
                    ))}
                </select>
                <span className="text-muted-foreground">
                    Until the person is done, the instructions go with every message until they send /done, end it above
                    the composer, or the socio ends it.
                </span>
            </label>
            <span className="flex gap-1">
                <Button
                    size="sm"
                    disabled={!name || !!nameError || !form.description.trim() || !form.instructions.trim()}
                >
                    Save skill
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
                    Cancel
                </Button>
            </span>
        </form>
    );
    return (
        <section className="grid gap-3" data-slot="chat-skills">
            <div className="grid gap-1">
                <h3 className="font-medium">Chat skills</h3>
                <p className="text-muted-foreground">
                    People start a message with a skill’s name, such as <code className="text-xs">/grill-me</code>, to
                    have the socio do that: typing <code className="text-xs">/</code> lists them, and on Telegram they
                    are commands. A skill’s instructions go with that message, or with every message until the person is
                    done.
                </p>
            </div>
            <SkillImportSection onSaved={refresh} />
            <ul className="grid gap-2" aria-label="Chat skills">
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
                                    <span className="font-medium">/{skill.name}</span>{' '}
                                    <span className="text-muted-foreground">
                                        {skill.builtIn ? '· built in' : '· this workspace'}
                                        {skill.mode === 'until-done' ? ' · until done' : ''}
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
                                        History
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
                                        Edit
                                    </Button>
                                    <Button variant="ghost" size="sm" onClick={() => remove(skill)}>
                                        Remove
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
                        Add a skill
                    </Button>
                </span>
            )}
        </section>
    );
}

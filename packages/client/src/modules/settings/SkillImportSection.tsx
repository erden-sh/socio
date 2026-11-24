import { useState, type FormEvent } from 'react';

import type { SkillImportPreview, SkillImportSource } from '@socio/shared/chat/chat-skills';

import { api } from '../../lib/api';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

/** A bounded linear diff: unchanged prefix/suffix collapsed to two context lines. */
export function skillImportDiff(before: string, after: string) {
    if (before === after) {
        return 'No instruction changes.';
    }
    const old = before.split('\n'),
        next = after.split('\n');
    let start = 0,
        oldEnd = old.length,
        nextEnd = next.length;
    while (start < oldEnd && start < nextEnd && old[start] === next[start]) {
        start++;
    }
    while (oldEnd > start && nextEnd > start && old[oldEnd - 1] === next[nextEnd - 1]) {
        oldEnd--;
        nextEnd--;
    }
    return [
        ...old.slice(Math.max(0, start - 2), start).map((line) => ` ${line}`),
        ...old.slice(start, oldEnd).map((line) => `- ${line}`),
        ...next.slice(start, nextEnd).map((line) => `+ ${line}`),
        ...next.slice(nextEnd, nextEnd + 2).map((line) => ` ${line}`),
    ].join('\n');
}

/** Import is an explicit preview followed by applying those exact bytes. */
export function SkillImportSection({ onSaved }: { onSaved: () => Promise<void> }) {
    const [source, setSource] = useState<SkillImportSource>({
        url: '',
        ref: 'main',
        path: 'SKILL.md',
    });
    const [preview, setPreview] = useState<SkillImportPreview>();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [saved, setSaved] = useState('');
    const change = (field: keyof SkillImportSource, value: string) => {
        setSource((current) => ({ ...current, [field]: value }));
        setPreview(undefined);
        setSaved('');
        setError('');
    };
    const load = async (event: FormEvent) => {
        event.preventDefault();
        setBusy(true);
        setPreview(undefined);
        setError('');
        setSaved('');
        try {
            setPreview(await api<SkillImportPreview>('/chat-skills/import/preview', 'POST', source));
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : 'Could not preview this source.');
        } finally {
            setBusy(false);
        }
    };
    const apply = async () => {
        if (!preview || busy) {
            return;
        }
        setBusy(true);
        setError('');
        try {
            await api('/chat-skills/import/apply', 'POST', {
                previewId: preview.id,
                sha256: preview.source.sha256,
            });
            setSaved(
                `/${preview.name} ${preview.previous ? 'updated' : 'installed'} from commit ${preview.source.commit.slice(0, 7)}.`,
            );
            setPreview(undefined);
            await onSaved();
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : 'Could not apply this import.');
        } finally {
            setBusy(false);
        }
    };
    return (
        <details className="min-w-0 rounded-md border p-3" data-slot="skill-import">
            <summary className="cursor-pointer font-medium">Import from GitHub</summary>
            <p className="mt-2 text-muted-foreground">
                Import a public repository’s SKILL.md as a workspace chat command. Review the pinned source before
                installing. Updates are manual; repository programs and tools are never installed.
            </p>
            <form className="mt-3 grid min-w-0 gap-2" onSubmit={load}>
                <label className="grid gap-1">
                    Repository URL
                    <Input
                        aria-label="Skill repository URL"
                        type="url"
                        required
                        maxLength={200}
                        placeholder="https://github.com/owner/repository"
                        value={source.url}
                        disabled={busy}
                        onChange={(event) => change('url', event.target.value)}
                    />
                </label>
                <label className="grid gap-1">
                    Branch, tag or commit
                    <Input
                        aria-label="Skill source ref"
                        required
                        maxLength={200}
                        value={source.ref}
                        disabled={busy}
                        onChange={(event) => change('ref', event.target.value)}
                    />
                </label>
                <label className="grid gap-1">
                    SKILL.md path
                    <Input
                        aria-label="Skill source path"
                        required
                        maxLength={500}
                        placeholder="skills/skill-name/SKILL.md"
                        value={source.path}
                        disabled={busy}
                        onChange={(event) => change('path', event.target.value)}
                    />
                </label>
                <Button className="justify-self-start" type="submit" disabled={busy}>
                    {busy ? 'Working…' : 'Preview import'}
                </Button>
            </form>
            {error && (
                <p className="mt-2 text-destructive" role="alert">
                    {error}
                </p>
            )}
            {saved && (
                <p className="mt-2" role="status">
                    {saved}
                </p>
            )}
            {preview && (
                <section className="mt-3 grid min-w-0 gap-2 rounded-md border p-3" aria-label="Skill import preview">
                    <h4 className="font-medium">/{preview.name}</h4>
                    <p className="whitespace-pre-wrap">{preview.description}</p>
                    <p className="break-words text-muted-foreground">
                        {preview.source.url} · {preview.source.path}
                        <br />
                        Ref {preview.source.ref} · Commit <code>{preview.source.commit}</code>
                    </p>
                    <p>License: {preview.source.license}</p>
                    {preview.source.licenseText && (
                        <details>
                            <summary className="cursor-pointer">License and attribution</summary>
                            <pre className="max-h-60 overflow-auto whitespace-pre-wrap text-xs">
                                {preview.source.licenseText}
                            </pre>
                        </details>
                    )}
                    <ul className="list-inside list-disc text-muted-foreground">
                        {preview.warnings.map((warning) => (
                            <li key={warning}>{warning}</li>
                        ))}
                    </ul>
                    {preview.previous && (
                        <details open>
                            <summary className="cursor-pointer">
                                Changes from revision {preview.previous.revision}
                            </summary>
                            <pre
                                className="max-h-80 overflow-auto whitespace-pre-wrap text-xs"
                                aria-label="Skill instruction changes"
                            >
                                {skillImportDiff(preview.previous.instructions, preview.instructions)}
                            </pre>
                        </details>
                    )}
                    {preview.previous && (
                        <details>
                            <summary className="cursor-pointer">
                                Current revision {preview.previous.revision}: compare before updating
                            </summary>
                            <p className="whitespace-pre-wrap">{preview.previous.description}</p>
                            <pre
                                className="max-h-80 overflow-auto whitespace-pre-wrap text-xs"
                                aria-label="Current skill instructions"
                            >
                                {preview.previous.instructions}
                            </pre>
                        </details>
                    )}
                    <details open>
                        <summary className="cursor-pointer">
                            Complete imported instructions ({preview.instructions.length.toLocaleString()} characters)
                        </summary>
                        <pre
                            className="max-h-80 overflow-auto whitespace-pre-wrap text-xs"
                            aria-label="Imported skill instructions"
                        >
                            {preview.instructions}
                        </pre>
                    </details>
                    <p className="text-muted-foreground">
                        This applies the shown commit. Preview again if the workspace skill changes or this review
                        expires.
                    </p>
                    <Button className="justify-self-start" type="button" disabled={busy} onClick={() => void apply()}>
                        {preview.previous ? 'Apply reviewed update' : 'Install reviewed skill'}
                    </Button>
                </section>
            )}
        </details>
    );
}

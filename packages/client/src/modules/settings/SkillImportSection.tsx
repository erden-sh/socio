import { useState, type FormEvent } from 'react';

import { Trans, useTranslation } from '@socio/i18n/react';
import type { SkillImportPreview, SkillImportSource } from '@socio/shared/chat/chat-skills';

import { api } from '../../lib/api';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

/**
 * A bounded linear diff: unchanged prefix/suffix collapsed to two context
 * lines; empty when nothing changed.
 */
export function skillImportDiff(before: string, after: string) {
    if (before === after) {
        return '';
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
    const { t } = useTranslation(['settings.chat-skills']);
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
            setError(cause instanceof Error ? cause.message : t('settings.chat-skills:import.previewFailed'));
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
                t('settings.chat-skills:import.installed', {
                    name: preview.name,
                    commit: preview.source.commit.slice(0, 7),
                    context: preview.previous ? 'update' : undefined,
                }),
            );
            setPreview(undefined);
            await onSaved();
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : t('settings.chat-skills:import.applyFailed'));
        } finally {
            setBusy(false);
        }
    };
    return (
        <details className="min-w-0 rounded-md border p-3" data-slot="skill-import">
            <summary className="cursor-pointer font-medium">{t('settings.chat-skills:import.title')}</summary>
            <p className="mt-2 text-muted-foreground">{t('settings.chat-skills:import.intro')}</p>
            <form className="mt-3 grid min-w-0 gap-2" onSubmit={load}>
                <label className="grid gap-1">
                    {t('settings.chat-skills:import.url')}
                    <Input
                        aria-label={t('settings.chat-skills:import.urlLabel')}
                        type="url"
                        required
                        maxLength={200}
                        // oxlint-disable-next-line socio/no-literal-text -- an example address, not words
                        placeholder="https://github.com/owner/repository"
                        value={source.url}
                        disabled={busy}
                        onChange={(event) => change('url', event.target.value)}
                    />
                </label>
                <label className="grid gap-1">
                    {t('settings.chat-skills:import.ref')}
                    <Input
                        aria-label={t('settings.chat-skills:import.refLabel')}
                        required
                        maxLength={200}
                        value={source.ref}
                        disabled={busy}
                        onChange={(event) => change('ref', event.target.value)}
                    />
                </label>
                <label className="grid gap-1">
                    {t('settings.chat-skills:import.path')}
                    <Input
                        aria-label={t('settings.chat-skills:import.pathLabel')}
                        required
                        maxLength={500}
                        // oxlint-disable-next-line socio/no-literal-text -- an example file path, not words
                        placeholder="skills/skill-name/SKILL.md"
                        value={source.path}
                        disabled={busy}
                        onChange={(event) => change('path', event.target.value)}
                    />
                </label>
                <Button className="justify-self-start" type="submit" disabled={busy}>
                    {busy ? t('settings.chat-skills:import.working') : t('settings.chat-skills:import.preview')}
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
                <section
                    className="mt-3 grid min-w-0 gap-2 rounded-md border p-3"
                    aria-label={t('settings.chat-skills:import.previewLabel')}
                >
                    <h4 className="font-medium">{`/${preview.name}`}</h4>
                    <p className="whitespace-pre-wrap">{preview.description}</p>
                    <p className="break-words text-muted-foreground">
                        {`${preview.source.url} · ${preview.source.path}`}
                        <br />
                        <Trans
                            t={t}
                            i18nKey="settings.chat-skills:import.source"
                            values={{ ref: preview.source.ref, commit: preview.source.commit }}
                            components={{ commit: <code /> }}
                        />
                    </p>
                    <p>{t('settings.chat-skills:import.license', { license: preview.source.license })}</p>
                    {preview.source.licenseText && (
                        <details>
                            <summary className="cursor-pointer">{t('settings.chat-skills:import.attribution')}</summary>
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
                                {t('settings.chat-skills:import.changes', { revision: preview.previous.revision })}
                            </summary>
                            <pre
                                className="max-h-80 overflow-auto whitespace-pre-wrap text-xs"
                                aria-label={t('settings.chat-skills:import.changesLabel')}
                            >
                                {skillImportDiff(preview.previous.instructions, preview.instructions) ||
                                    t('settings.chat-skills:import.noChanges')}
                            </pre>
                        </details>
                    )}
                    {preview.previous && (
                        <details>
                            <summary className="cursor-pointer">
                                {t('settings.chat-skills:import.current', { revision: preview.previous.revision })}
                            </summary>
                            <p className="whitespace-pre-wrap">{preview.previous.description}</p>
                            <pre
                                className="max-h-80 overflow-auto whitespace-pre-wrap text-xs"
                                aria-label={t('settings.chat-skills:import.currentLabel')}
                            >
                                {preview.previous.instructions}
                            </pre>
                        </details>
                    )}
                    <details open>
                        <summary className="cursor-pointer">
                            {t('settings.chat-skills:import.complete', { count: preview.instructions.length })}
                        </summary>
                        <pre
                            className="max-h-80 overflow-auto whitespace-pre-wrap text-xs"
                            aria-label={t('settings.chat-skills:import.completeLabel')}
                        >
                            {preview.instructions}
                        </pre>
                    </details>
                    <p className="text-muted-foreground">{t('settings.chat-skills:import.applies')}</p>
                    <Button className="justify-self-start" type="button" disabled={busy} onClick={() => void apply()}>
                        {preview.previous
                            ? t('settings.chat-skills:import.applyUpdate')
                            : t('settings.chat-skills:import.install')}
                    </Button>
                </section>
            )}
        </details>
    );
}

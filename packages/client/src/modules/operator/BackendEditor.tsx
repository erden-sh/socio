import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { toast } from 'sonner';

import type { BackendInput, InferenceBackendView } from '@socio/shared/inference';
import { formatNumber } from '@socio/shared/locale';

import { api } from '../../lib/api';
import { groupOf } from '../settings/sections';
import { SettingsLayout } from '../settings/SettingsLayout';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';

/** Where the Platform page is, and where the editor goes back to. */
export const PLATFORM_PATH = '/settings/operator';
/** The editor's page for a backend, or for a new one. */
export const backendPath = (id?: string) => `${PLATFORM_PATH}/backends/${id ? encodeURIComponent(id) : 'new'}`;

/** What a model's context is taken to be when its backend doesn't say. */
const DEFAULT_CONTEXT_WINDOW = 32_768;

/** A backend's saved settings, as the form edits them. */
export const inputOf = (backend: InferenceBackendView): BackendInput => ({
    label: backend.label,
    baseUrl: backend.config.baseUrl,
    model: backend.config.model,
    acceptsImages: backend.capabilities.acceptsImages,
    maxImages: backend.capabilities.maxImages ?? null,
    maxCompletionTokens: backend.capabilities.maxCompletionTokens ?? null,
    contextWindow: backend.capabilities.contextWindow ?? null,
    titleModelOptions: backend.config.titleModelOptions ?? null,
});

const optionalNumber = (value: string) => (value.trim() ? Number(value.trim()) : null);

/**
 * Adds or edits an OpenAI-compatible backend, on a page of its own
 * (`/settings/operator/backends/:id`, or `new`): a dialog's fixed height
 * left the lower fields under an iPhone's keyboard. The key field is
 * write-only. Saving or canceling goes back to the Platform page.
 */
export function BackendEditor({
    backend,
}: {
    /** The backend to edit; none adds one. */
    backend?: InferenceBackendView;
}) {
    const navigate = useNavigate();
    const initial = backend && inputOf(backend);
    const [label, setLabel] = useState(initial?.label ?? '');
    const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? '');
    const [model, setModel] = useState(initial?.model ?? '');
    const [apiKey, setApiKey] = useState('');
    const [removeKey, setRemoveKey] = useState(false);
    const [images, setImages] = useState(!!initial?.acceptsImages);
    const [maxImages, setMaxImages] = useState(initial?.maxImages ? String(initial.maxImages) : '');
    const [maxTokens, setMaxTokens] = useState(initial?.maxCompletionTokens ? String(initial.maxCompletionTokens) : '');
    const [contextWindow, setContextWindow] = useState(initial?.contextWindow ? String(initial.contextWindow) : '');
    const [titleOptions, setTitleOptions] = useState(
        initial?.titleModelOptions ? JSON.stringify(initial.titleModelOptions) : '',
    );
    const [saving, setSaving] = useState(false);
    const submit = async (event: FormEvent) => {
        event.preventDefault();
        let options: Record<string, unknown> | null = null;
        if (titleOptions.trim()) {
            try {
                options = JSON.parse(titleOptions);
                if (!options || typeof options !== 'object' || Array.isArray(options)) {
                    throw new Error();
                }
            } catch {
                toast.error('Title request options must be a JSON object.');
                return;
            }
        }
        const body: BackendInput = {
            label: label.trim(),
            baseUrl: baseUrl.trim(),
            model: model.trim(),
            acceptsImages: images,
            maxImages: images ? optionalNumber(maxImages) : null,
            maxCompletionTokens: optionalNumber(maxTokens),
            contextWindow: optionalNumber(contextWindow),
            titleModelOptions: options,
            ...(removeKey ? { apiKey: null } : apiKey.trim() ? { apiKey } : {}),
        };
        setSaving(true);
        try {
            if (backend) {
                await api(`/inference/backends/${backend.id}`, 'PUT', {
                    ...body,
                    enabled: backend.enabled,
                });
            } else {
                await api('/inference/backends', 'POST', body);
            }
            toast.success(backend ? 'Backend saved' : 'Backend added');
            void navigate(PLATFORM_PATH);
        } catch (e) {
            toast.error(e instanceof Error ? e.message : 'Could not save the backend.');
        } finally {
            setSaving(false);
        }
    };
    const field = 'grid gap-1.5 text-sm';
    const hint = 'text-xs text-muted-foreground';
    return (
        <SettingsLayout group={groupOf('operator')}>
            <Card className="max-w-xl">
                <CardHeader>
                    <CardTitle>{backend ? `Edit ${backend.label}` : 'Add a backend'}</CardTitle>
                    <CardDescription>
                        A self-hosted server that speaks the OpenAI Chat Completions API. Changes apply from the next
                        turn.
                    </CardDescription>
                </CardHeader>
                <CardContent>
                    <form className="grid gap-4" onSubmit={submit}>
                        <label className={field}>
                            Name
                            <Input
                                required
                                maxLength={80}
                                value={label}
                                onChange={(e) => setLabel(e.target.value)}
                                placeholder="Homelab"
                            />
                        </label>
                        <label className={field}>
                            Base URL
                            <Input
                                required
                                type="url"
                                value={baseUrl}
                                onChange={(e) => setBaseUrl(e.target.value)}
                                placeholder="http://localhost:8000/v1"
                            />
                        </label>
                        <label className={field}>
                            Model
                            <Input
                                required
                                maxLength={200}
                                value={model}
                                onChange={(e) => setModel(e.target.value)}
                                placeholder="qwen38-flash"
                            />
                        </label>
                        <label className={field}>
                            API key
                            <Input
                                type="password"
                                autoComplete="off"
                                value={apiKey}
                                disabled={removeKey}
                                onChange={(e) => setApiKey(e.target.value)}
                                placeholder={
                                    backend?.hasApiKey
                                        ? 'Stored; leave blank to keep it'
                                        : 'Optional; keyless servers need none'
                                }
                            />
                        </label>
                        {backend?.hasApiKey && (
                            <label className="flex items-center gap-2 text-sm">
                                <Switch checked={removeKey} onCheckedChange={setRemoveKey} />
                                Remove the stored key
                            </label>
                        )}
                        <label className="flex items-center gap-2 text-sm">
                            <Switch checked={images} onCheckedChange={setImages} />
                            The model takes images
                        </label>
                        {/* Only with images: a field that can't be used isn't shown. */}
                        {images && (
                            <label className={field}>
                                Images per request
                                <Input
                                    type="number"
                                    inputMode="numeric"
                                    min={1}
                                    max={32}
                                    value={maxImages}
                                    onChange={(e) => setMaxImages(e.target.value)}
                                    placeholder="4"
                                />
                            </label>
                        )}
                        <label className={field}>
                            Completion tokens per turn
                            <Input
                                type="number"
                                inputMode="numeric"
                                min={1}
                                value={maxTokens}
                                onChange={(e) => setMaxTokens(e.target.value)}
                                placeholder="2200"
                            />
                        </label>
                        <label className={field}>
                            Context window (tokens)
                            <Input
                                type="number"
                                inputMode="numeric"
                                min={1024}
                                value={contextWindow}
                                onChange={(e) => setContextWindow(e.target.value)}
                                placeholder={`Default: ${formatNumber(DEFAULT_CONTEXT_WINDOW)}`}
                            />
                            <span className={hint}>
                                {contextWindow.trim()
                                    ? 'Long chats are tidied to fit about 70% of it.'
                                    : `Blank uses ${formatNumber(DEFAULT_CONTEXT_WINDOW)} tokens. Long chats are tidied to fit about 70% of it.`}
                            </span>
                        </label>
                        <label className={field}>
                            Title request options (JSON, optional)
                            <Textarea
                                rows={2}
                                value={titleOptions}
                                onChange={(e) => setTitleOptions(e.target.value)}
                                placeholder='{"chat_template_kwargs":{"enable_thinking":false}}'
                            />
                        </label>
                        <div className="flex flex-wrap justify-end gap-2">
                            <Button type="button" variant="outline" asChild>
                                <Link to={PLATFORM_PATH}>Cancel</Link>
                            </Button>
                            <Button type="submit" disabled={saving}>
                                {saving ? 'Saving…' : backend ? 'Save' : 'Add backend'}
                            </Button>
                        </div>
                    </form>
                </CardContent>
            </Card>
        </SettingsLayout>
    );
}

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { toast } from 'sonner';

import { useTranslation } from '@socio/i18n/react';
import {
    DATA_API_TOKENS_PATH,
    type CreatedDataApiToken,
    type DataApiScope,
    type DataApiTokenList,
    type DataApiTokenView,
} from '@socio/shared/dataspace/api-tokens';

import { nativeSelect } from '../../components/form-fields';
import { api } from '../../lib/api';

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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';

/** `/api/data/api-tokens` as `api()` takes it (under `/api` already). */
const PATH = DATA_API_TOKENS_PATH.replace(/^\/api/, '');
const failed = (e: unknown, fallback: string) => toast.error(e instanceof Error ? e.message : fallback);
/** Each scope's description (the scope itself is an identifier, shown as is). */
const SCOPE_KEYS = {
    'data:read': 'settings.data-api:scopes.read',
    'data:write': 'settings.data-api:scopes.write',
    'data:admin': 'settings.data-api:scopes.admin',
} as const satisfies Record<DataApiScope, string>;
/** Lifetimes on offer, within the server's limit. */
const dayChoices = (list: DataApiTokenList) =>
    [...new Set([1, list.daysDefault, 14, list.daysMax])].filter((d) => d <= list.daysMax).sort((a, b) => a - b);

/** A new token: name, scopes, lifetime and budget; then its value, shown once. */
function NewTokenDialog({
    list,
    onClose,
    onCreated,
}: {
    list: DataApiTokenList;
    onClose: () => void;
    onCreated: () => void;
}) {
    const { t } = useTranslation(['settings.data-api']);
    const [name, setName] = useState('');
    const [scopes, setScopes] = useState<DataApiScope[]>(['data:read']);
    const [days, setDays] = useState(list.daysDefault);
    const [budget, setBudget] = useState(String(list.statementsPerMinuteDefault));
    const [created, setCreated] = useState<CreatedDataApiToken>();
    const [busy, setBusy] = useState(false);
    const submit = (e: FormEvent) => {
        e.preventDefault();
        setBusy(true);
        void api<CreatedDataApiToken>(PATH, 'POST', { name, scopes, days, statementsPerMinute: Number(budget) })
            .then((made) => {
                setCreated(made);
                onCreated();
            })
            .catch((error) => failed(error, t('settings.data-api:errors.make')))
            .finally(() => setBusy(false));
    };
    return (
        <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
            <DialogContent data-slot="new-data-api-token">
                <DialogHeader>
                    <DialogTitle>{t('settings.data-api:new.title')}</DialogTitle>
                    <DialogDescription>
                        {created ? t('settings.data-api:new.copyNow') : t('settings.data-api:new.description')}
                    </DialogDescription>
                </DialogHeader>
                {created ? (
                    <div className="grid gap-2 text-sm" data-slot="data-api-token-value">
                        <span>{t('settings.data-api:new.created', { name: created.apiToken.name })}</span>
                        <Input
                            aria-label={t('settings.data-api:new.title')}
                            readOnly
                            value={created.token}
                            onFocus={(e) => e.target.select()}
                        />
                        <DialogFooter>
                            <Button
                                variant="outline"
                                onClick={() => {
                                    void navigator.clipboard
                                        ?.writeText(created.token)
                                        .then(() => toast.success(t('settings.data-api:new.copied')));
                                }}
                            >
                                {t('settings.data-api:new.copy')}
                            </Button>
                            <Button onClick={onClose}>{t('settings.data-api:new.done')}</Button>
                        </DialogFooter>
                    </div>
                ) : (
                    <form className="grid gap-3" aria-label={t('settings.data-api:new.title')} onSubmit={submit}>
                        <span className="grid gap-2 sm:grid-cols-[1fr_auto]">
                            <Input
                                aria-label={t('settings.data-api:new.name')}
                                placeholder={t('settings.data-api:new.namePlaceholder')}
                                required
                                maxLength={60}
                                value={name}
                                onChange={(e) => setName(e.target.value)}
                            />
                            <select
                                data-slot="native-select"
                                aria-label={t('settings.data-api:new.lifetime')}
                                className={cn(nativeSelect, 'w-32')}
                                value={days}
                                onChange={(e) => setDays(Number(e.target.value))}
                            >
                                {dayChoices(list).map((value) => (
                                    <option key={value} value={value}>
                                        {t('settings.data-api:new.days', { count: value })}
                                    </option>
                                ))}
                            </select>
                        </span>
                        <span className="grid gap-1">
                            {list.scopes.map((scope) => (
                                <label key={scope} className="flex items-center gap-2 text-sm">
                                    <Checkbox
                                        checked={scopes.includes(scope)}
                                        onCheckedChange={(checked) =>
                                            setScopes((current) =>
                                                checked === true
                                                    ? [...current, scope]
                                                    : current.filter((entry) => entry !== scope),
                                            )
                                        }
                                    />
                                    <code className="text-xs">{scope}</code>
                                    <span className="text-muted-foreground">{t(SCOPE_KEYS[scope])}</span>
                                </label>
                            ))}
                        </span>
                        <label className="grid gap-1 text-sm">
                            <span>{t('settings.data-api:new.budget', { max: list.statementsPerMinuteMax })}</span>
                            <Input
                                aria-label={t('settings.data-api:new.budgetLabel')}
                                type="number"
                                min={1}
                                max={list.statementsPerMinuteMax}
                                required
                                value={budget}
                                onChange={(e) => setBudget(e.target.value)}
                            />
                        </label>
                        <DialogFooter>
                            <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
                                {t('settings.data-api:new.cancel')}
                            </Button>
                            <Button type="submit" disabled={busy || !name.trim() || !scopes.length}>
                                {t('settings.data-api:new.submit')}
                            </Button>
                        </DialogFooter>
                    </form>
                )}
            </DialogContent>
        </Dialog>
    );
}

/**
 * Settings → Data API: admins' tokens for the data API, on the company's
 * datasets. Each is shown once, has scopes, an expiry and a budget, and
 * may be revoked; what it writes is recorded as the token, for its maker.
 */
export function DataApiTokensSection() {
    const { t } = useTranslation(['settings.data-api']);
    /** Where a token stands: live until it expires or is revoked. */
    const tokenState = (token: DataApiTokenView, now: number) => {
        if (token.revokedAt) {
            return t('settings.data-api:token.revoked', {
                at: new Date(token.revokedAt),
                context: token.revokedBy === 'system' ? 'system' : undefined,
            });
        }
        return token.expiresAt > now
            ? t('settings.data-api:token.expires', { at: new Date(token.expiresAt) })
            : t('settings.data-api:token.expired', { at: new Date(token.expiresAt) });
    };
    const [list, setList] = useState<DataApiTokenList>();
    const [making, setMaking] = useState(false);
    const load = useCallback(
        () =>
            api<DataApiTokenList>(PATH)
                .then(setList)
                .catch((error) => failed(error, t('settings.data-api:errors.load'))),
        [t],
    );
    useEffect(() => void load(), [load]);
    const revoke = (token: DataApiTokenView) =>
        void api(`${PATH}/${encodeURIComponent(token.id)}`, 'DELETE')
            .then(() => {
                toast.success(t('settings.data-api:revoke.done', { name: token.name }));
                return load();
            })
            .catch((error) => failed(error, t('settings.data-api:errors.revoke')));
    const now = Date.now();
    return (
        <div className="grid gap-3" data-slot="data-api-tokens">
            <p className="text-sm text-muted-foreground">{t('settings.data-api:intro')}</p>
            {list && list.tokens.length ? (
                <Table aria-label={t('settings.data-api:list.label')}>
                    <TableHeader>
                        <TableRow>
                            <TableHead>{t('settings.data-api:list.token')}</TableHead>
                            <TableHead>{t('settings.data-api:list.madeBy')}</TableHead>
                            <TableHead>{t('settings.data-api:list.lastUsed')}</TableHead>
                            <TableHead>{t('settings.data-api:list.expiry')}</TableHead>
                            <TableHead>
                                <span className="sr-only">{t('settings.data-api:list.actions')}</span>
                            </TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {list.tokens.map((token) => {
                            const live = !token.revokedAt && token.expiresAt > now;
                            return (
                                <TableRow
                                    key={token.id}
                                    data-token={token.name}
                                    className={cn(!live && 'text-muted-foreground')}
                                >
                                    <TableCell className="whitespace-normal">
                                        <span className={cn('block', !live && 'line-through')}>
                                            {token.name}{' '}
                                            <code className="text-xs">
                                                {/* oxlint-disable-next-line socio/no-literal-text -- the token's prefix, an identifier */}
                                                cbdt_api_{token.hint}…
                                            </code>
                                        </span>
                                        <span className="text-xs text-muted-foreground">
                                            {t('settings.data-api:token.usage', {
                                                scopes: token.scopes.join(', '),
                                                perMinute: token.statementsPerMinute,
                                            })}
                                        </span>
                                    </TableCell>
                                    <TableCell className="whitespace-normal">
                                        {token.createdByName ?? t('settings.data-api:token.unknownMaker')}
                                        <span className="block text-xs text-muted-foreground">
                                            {t('settings.data-api:token.madeAt', { at: new Date(token.createdAt) })}
                                        </span>
                                    </TableCell>
                                    <TableCell className="whitespace-normal">
                                        {token.lastUsedAt
                                            ? t('settings.data-api:token.used', {
                                                  at: new Date(token.lastUsedAt),
                                                  count: token.uses,
                                              })
                                            : t('settings.data-api:token.neverUsed')}
                                    </TableCell>
                                    <TableCell>{tokenState(token, now)}</TableCell>
                                    <TableCell className="text-right">
                                        {live && (
                                            <Button
                                                variant="ghost"
                                                size="sm"
                                                aria-label={t('settings.data-api:revoke.label', { name: token.name })}
                                                onClick={() => revoke(token)}
                                            >
                                                {t('settings.data-api:revoke.action')}
                                            </Button>
                                        )}
                                    </TableCell>
                                </TableRow>
                            );
                        })}
                    </TableBody>
                </Table>
            ) : (
                list && <span className="text-sm text-muted-foreground">{t('settings.data-api:list.empty')}</span>
            )}
            <span>
                <Button disabled={!list} onClick={() => setMaking(true)}>
                    {t('settings.data-api:new.open')}
                </Button>
            </span>
            {making && list && (
                <NewTokenDialog list={list} onClose={() => setMaking(false)} onCreated={() => void load()} />
            )}
        </div>
    );
}

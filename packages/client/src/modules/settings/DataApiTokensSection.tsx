import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { toast } from 'sonner';

import {
    DATA_API_SCOPE_LABELS,
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
const when = (at: number) => new Date(at).toLocaleDateString();
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
            .catch((error) => failed(error, 'Could not make the token.'))
            .finally(() => setBusy(false));
    };
    return (
        <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
            <DialogContent data-slot="new-data-api-token">
                <DialogHeader>
                    <DialogTitle>New data API token</DialogTitle>
                    <DialogDescription>
                        {created
                            ? 'Copy it now: it isn’t shown again.'
                            : 'For a script of yours, such as an import. It reaches the company’s datasets only, never a person’s, a socio’s or a plugin’s.'}
                    </DialogDescription>
                </DialogHeader>
                {created ? (
                    <div className="grid gap-2 text-sm" data-slot="data-api-token-value">
                        <span>Token “{created.apiToken.name}”. Copy it now: it isn’t shown again.</span>
                        <Input
                            aria-label="New data API token"
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
                                        .then(() => toast.success('Token copied'));
                                }}
                            >
                                Copy
                            </Button>
                            <Button onClick={onClose}>Done</Button>
                        </DialogFooter>
                    </div>
                ) : (
                    <form className="grid gap-3" aria-label="New data API token" onSubmit={submit}>
                        <span className="grid gap-2 sm:grid-cols-[1fr_auto]">
                            <Input
                                aria-label="Token name"
                                placeholder="Token name, e.g. what runs it"
                                required
                                maxLength={60}
                                value={name}
                                onChange={(e) => setName(e.target.value)}
                            />
                            <select
                                data-slot="native-select"
                                aria-label="Token lifetime"
                                className={cn(nativeSelect, 'w-32')}
                                value={days}
                                onChange={(e) => setDays(Number(e.target.value))}
                            >
                                {dayChoices(list).map((value) => (
                                    <option key={value} value={value}>
                                        {value} {value === 1 ? 'day' : 'days'}
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
                                    <span className="text-muted-foreground">{DATA_API_SCOPE_LABELS[scope]}</span>
                                </label>
                            ))}
                        </span>
                        <label className="grid gap-1 text-sm">
                            <span>Operations a minute (at most {list.statementsPerMinuteMax.toLocaleString()})</span>
                            <Input
                                aria-label="Operations a minute"
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
                                Cancel
                            </Button>
                            <Button type="submit" disabled={busy || !name.trim() || !scopes.length}>
                                Make token
                            </Button>
                        </DialogFooter>
                    </form>
                )}
            </DialogContent>
        </Dialog>
    );
}

/** Where a token stands: live until it expires or is revoked. */
function tokenState(token: DataApiTokenView, now: number) {
    if (token.revokedAt) {
        return `revoked ${when(token.revokedAt)}${token.revokedBy === 'system' ? ' (its maker is no longer an admin)' : ''}`;
    }
    return token.expiresAt > now ? `expires ${when(token.expiresAt)}` : `expired ${when(token.expiresAt)}`;
}

/**
 * Settings → Data API: admins' tokens for the data API, on the company's
 * datasets. Each is shown once, has scopes, an expiry and a budget, and
 * may be revoked; what it writes is recorded as the token, for its maker.
 */
export function DataApiTokensSection() {
    const [list, setList] = useState<DataApiTokenList>();
    const [making, setMaking] = useState(false);
    const load = useCallback(
        () =>
            api<DataApiTokenList>(PATH)
                .then(setList)
                .catch((error) => failed(error, 'Could not load the data API tokens.')),
        [],
    );
    useEffect(() => void load(), [load]);
    const revoke = (token: DataApiTokenView) =>
        void api(`${PATH}/${encodeURIComponent(token.id)}`, 'DELETE')
            .then(() => {
                toast.success(`Revoked “${token.name}”`);
                return load();
            })
            .catch((error) => failed(error, 'Could not revoke the token.'));
    const now = Date.now();
    return (
        <div className="grid gap-3" data-slot="data-api-tokens">
            <p className="text-sm text-muted-foreground">
                Tokens for your own scripts, such as an import from another tool, to create and fill the company’s
                datasets through the data API. Each one is shown once.
            </p>
            {list && list.tokens.length ? (
                <Table aria-label="Data API tokens">
                    <TableHeader>
                        <TableRow>
                            <TableHead>Token</TableHead>
                            <TableHead>Made by</TableHead>
                            <TableHead>Last used</TableHead>
                            <TableHead>Expiry</TableHead>
                            <TableHead>
                                <span className="sr-only">Actions</span>
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
                                            {token.name} <code className="text-xs">cbdt_api_{token.hint}…</code>
                                        </span>
                                        <span className="text-xs text-muted-foreground">
                                            {token.scopes.join(', ')}; {token.statementsPerMinute} a minute
                                        </span>
                                    </TableCell>
                                    <TableCell className="whitespace-normal">
                                        {token.createdByName ?? 'Unknown'}
                                        <span className="block text-xs text-muted-foreground">
                                            {when(token.createdAt)}
                                        </span>
                                    </TableCell>
                                    <TableCell className="whitespace-normal">
                                        {token.lastUsedAt
                                            ? `${new Date(token.lastUsedAt).toLocaleString()} (${token.uses} request${token.uses === 1 ? '' : 's'})`
                                            : 'never used'}
                                    </TableCell>
                                    <TableCell>{tokenState(token, now)}</TableCell>
                                    <TableCell className="text-right">
                                        {live && (
                                            <Button
                                                variant="ghost"
                                                size="sm"
                                                aria-label={`Revoke ${token.name}`}
                                                onClick={() => revoke(token)}
                                            >
                                                Revoke
                                            </Button>
                                        )}
                                    </TableCell>
                                </TableRow>
                            );
                        })}
                    </TableBody>
                </Table>
            ) : (
                list && <span className="text-sm text-muted-foreground">No data API tokens yet.</span>
            )}
            <span>
                <Button disabled={!list} onClick={() => setMaking(true)}>
                    New token
                </Button>
            </span>
            {making && list && (
                <NewTokenDialog list={list} onClose={() => setMaking(false)} onCreated={() => void load()} />
            )}
        </div>
    );
}

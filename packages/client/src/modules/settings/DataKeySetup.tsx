import { useState } from 'react';

import { useTranslation } from '@socio/i18n/react';
import type { DataKeyStatus, RestoreDrillStatus } from '@socio/shared/types';

import { useHydrated } from '../../lib/client-only';
import { utcTime } from '../../lib/local-time';

import { useSetupLines } from './setup-lines';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

type Mutate = (path: string, method: string, body?: unknown) => Promise<boolean>;

/**
 * Service setup's data key lines (CB-62, CB-322): whether it's set, the
 * keys' ids (fingerprints, to check an escrowed copy against), what is
 * still sealed under SESSION_SECRET's key, and for admins "Re-seal under
 * the data key", which needs a data key and something to move.
 */
export function DataKeySetup({
    dataKey,
    readOnly,
    mutate,
}: {
    dataKey: DataKeyStatus;
    readOnly: boolean;
    mutate: Mutate;
}) {
    const { t } = useTranslation(['settings.workspace-setup']);
    const { dataKeyLine, keyIdsLine, legacySealedLine, resealLine } = useSetupLines();
    const [busy, setBusy] = useState(false);
    const when = useHydrated() ? undefined : utcTime;
    const running = !!dataKey.reseal?.running;
    const reseal = resealLine(dataKey, when);
    const due = dataKey.legacy + dataKey.previous > 0;
    return (
        <div className="grid justify-items-start gap-1" data-slot="setup-data-key-group">
            <p data-slot="setup-data-key">
                {t('settings.workspace-setup:lines.dataKey', { line: dataKeyLine(dataKey) })}
            </p>
            <p data-slot="setup-key-ids">{t('settings.workspace-setup:lines.keyIds', { line: keyIdsLine(dataKey) })}</p>
            <p data-slot="setup-legacy-sealed">
                {t('settings.workspace-setup:lines.legacy', { line: legacySealedLine(dataKey) })}
            </p>
            {reseal && <p data-slot="setup-reseal">{t('settings.workspace-setup:lines.reseal', { line: reseal })}</p>}
            {!readOnly && (dataKey.configured ? due || running : dataKey.legacy > 0) && (
                <div className="grid justify-items-start gap-1">
                    <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={busy || running || !dataKey.configured}
                        onClick={async () => {
                            setBusy(true);
                            await mutate('/data-key/reseal', 'POST');
                            setBusy(false);
                        }}
                    >
                        {running
                            ? t('settings.workspace-setup:reseal.busy')
                            : t('settings.workspace-setup:reseal.button')}
                    </Button>
                    {!dataKey.configured && <p className="text-xs">{t('settings.workspace-setup:reseal.needsKey')}</p>}
                </div>
            )}
        </div>
    );
}

/**
 * "Verify a recovery key" (CB-322): an admin pastes the data key from
 * escrow; the server restores the latest point and opens a sample of each
 * purpose's seals with it. The field is cleared as soon as it's sent, and
 * the key is never kept: only its id and the result come back.
 */
export function RecoveryKeyCheckSetup({ drill, mutate }: { drill: RestoreDrillStatus; mutate: Mutate }) {
    const { t } = useTranslation(['settings.workspace-setup']);
    const { keyCheckLine } = useSetupLines();
    const [key, setKey] = useState('');
    const [busy, setBusy] = useState(false);
    const when = useHydrated() ? undefined : utcTime;
    const check = drill.keyCheck;
    const running = !!check?.running;
    return (
        <form
            className="grid justify-items-start gap-2"
            data-slot="setup-recovery-key"
            autoComplete="off"
            onSubmit={async (event) => {
                event.preventDefault();
                const sent = key;
                setKey('');
                setBusy(true);
                await mutate('/backups/verify-key', 'POST', { key: sent });
                setBusy(false);
            }}
        >
            {check && (
                <p
                    data-slot="setup-recovery-key-result"
                    className={check.last && !check.last.ok && !running ? 'text-destructive' : undefined}
                >
                    {t('settings.workspace-setup:lines.keyCheck', { line: keyCheckLine(check, when) })}
                </p>
            )}
            <label className="grid gap-1" htmlFor="recovery-key">
                <span>{t('settings.workspace-setup:recovery.label')}</span>
                <span className="text-xs">{t('settings.workspace-setup:recovery.hint')}</span>
            </label>
            <div className="flex flex-wrap gap-2">
                <Input
                    id="recovery-key"
                    name="recovery-key"
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    className="w-80 max-w-full font-mono"
                    value={key}
                    disabled={busy || running}
                    onChange={(event) => setKey(event.target.value)}
                />
                <Button type="submit" variant="outline" size="sm" disabled={busy || running || !key.trim()}>
                    {running
                        ? t('settings.workspace-setup:recovery.checking')
                        : t('settings.workspace-setup:recovery.verify')}
                </Button>
            </div>
        </form>
    );
}

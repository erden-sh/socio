import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { toast } from 'sonner';

import type { GrantAccess, GrantView } from '@socio/shared/data-types';
import type { Dot } from '@socio/shared/types';

import { dotFolderId, fieldClass, listGrants, revokeGrant, saveGrant } from './media-api';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';

const failed = (e: unknown, fallback: string) => toast.error(e instanceof Error ? e.message : fallback);

/**
 * "Dot access" for a folder: the data space's folder grants on it (and on
 * the folders above it, which reach it too), changed through
 * `/api/data/grants` like on the Data page.
 */
export function FolderAccess({ folder, dots, onClose }: { folder: string; dots: readonly Dot[]; onClose: () => void }) {
    const [grants, setGrants] = useState<GrantView[]>();
    const load = useCallback(
        () =>
            listGrants()
                .then(setGrants)
                .catch((e) => failed(e, 'Could not load the grants.')),
        [],
    );
    useEffect(() => void load(), [load]);
    const here = grants?.filter((grant) => grant.folder === folder) ?? [];
    const above =
        grants?.filter((grant) => grant.folder && grant.folder !== folder && folder.startsWith(grant.folder)) ?? [];
    const owner = dotFolderId(folder);
    const save = async (dotId: string, access: GrantAccess) => {
        try {
            await saveGrant(dotId, folder, access);
            await load();
        } catch (e) {
            failed(e, 'Could not save the grant.');
        }
    };
    const revoke = async (id: string) => {
        try {
            await revokeGrant(id);
            await load();
        } catch (e) {
            failed(e, 'Could not remove the grant.');
        }
    };
    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent data-slot="media-folder-access">
                <DialogHeader>
                    <DialogTitle>Socio access to {folder}</DialogTitle>
                    <DialogDescription>
                        Which socios may read or change the files in this folder and its subfolders. A socio always
                        reads what you attach in its own conversation, and its own folder is always its own.
                    </DialogDescription>
                </DialogHeader>
                {!grants ? (
                    <Skeleton className="h-24" />
                ) : (
                    <div className="grid gap-3 text-sm">
                        {owner && (
                            <p className="text-muted-foreground">
                                {dots.find((dot) => dot.id === owner)?.name ?? 'Its socio'} owns this folder.
                            </p>
                        )}
                        {here.map((grant) => (
                            <div
                                key={grant.id}
                                className="flex flex-wrap items-center gap-2"
                                data-grant={grant.dotName}
                            >
                                <span className="min-w-32 font-medium">{grant.dotName}</span>
                                <select
                                    data-slot="grant-access"
                                    aria-label={`Access for ${grant.dotName}`}
                                    className={fieldClass}
                                    value={grant.access}
                                    onChange={(event) => void save(grant.dotId, event.target.value as GrantAccess)}
                                >
                                    <option value="read">Read</option>
                                    <option value="write">Read and write</option>
                                </select>
                                <Button variant="ghost" size="sm" onClick={() => void revoke(grant.id)}>
                                    Remove
                                </Button>
                            </div>
                        ))}
                        {!here.length && !owner && (
                            <p className="text-muted-foreground">No socio has a grant on this folder.</p>
                        )}
                        {above.map((grant) => (
                            <p key={grant.id} className="text-muted-foreground">
                                {grant.dotName} may {grant.access === 'write' ? 'change' : 'read'} it through{' '}
                                {grant.folder}.
                            </p>
                        ))}
                        <GrantForm
                            dots={dots.filter(
                                (dot) => dot.id !== owner && !here.some((grant) => grant.dotId === dot.id),
                            )}
                            onSave={save}
                        />
                    </div>
                )}
            </DialogContent>
        </Dialog>
    );
}

function GrantForm({
    dots,
    onSave,
}: {
    dots: readonly Dot[];
    onSave: (dotId: string, access: GrantAccess) => Promise<void>;
}) {
    const [dotId, setDotId] = useState('');
    const [access, setAccess] = useState<GrantAccess>('read');
    if (!dots.length) {
        return null;
    }
    const submit = (event: FormEvent) => {
        event.preventDefault();
        if (!dotId) {
            return;
        }
        void onSave(dotId, access).then(() => setDotId(''));
    };
    return (
        <form className="flex flex-wrap items-center gap-2" onSubmit={submit}>
            <select
                data-slot="grant-dot"
                aria-label="Socio"
                className={fieldClass}
                value={dotId}
                onChange={(event) => setDotId(event.target.value)}
            >
                <option value="">Give a socio access…</option>
                {dots.map((dot) => (
                    <option key={dot.id} value={dot.id}>
                        {dot.name}
                    </option>
                ))}
            </select>
            <select
                data-slot="grant-new-access"
                aria-label="Access"
                className={fieldClass}
                value={access}
                onChange={(event) => setAccess(event.target.value as GrantAccess)}
            >
                <option value="read">Read</option>
                <option value="write">Read and write</option>
            </select>
            <Button type="submit" size="sm" disabled={!dotId}>
                Grant
            </Button>
        </form>
    );
}

import { Sheet } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';

import { useTranslation } from '@socio/i18n/react';
import { isWorkspaceOwner, type DatasetView } from '@socio/shared/data-types';
import type { PrivateItemsResponse } from '@socio/shared/spaces/space-items';
import type { Space } from '@socio/shared/types';

import { onDemand } from '../../i18n/on-demand';
import { api } from '../../lib/api';
import { notifyPagesChanged } from '../pages/page-events';

import { datasetPath } from '@/components/nav-spaces';
import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';

/** A dataset "Add existing dataset" may place: the person's own, or (admins) the workspace's. */
interface Candidate {
    id: string;
    title: string;
    note?: string;
}

/**
 * A Space's "New dataset" and "Add existing dataset" (CB-451),
 * for its editors only: the server checks the role on every placement. New
 * makes one of the person's, placed at the Space's root; existing lists the
 * datasets they manage that no Space holds (their Private group, and for
 * admins the workspace's unplaced datasets) and places the one chosen.
 * Its words load on demand (spaces.dialogs).
 */
function PlaceDataset({
    space,
    mode,
    admin,
    onOpenChange,
    onPlaced,
}: {
    space: Pick<Space, 'id' | 'name'>;
    mode: 'new' | 'existing' | undefined;
    /** A workspace admin: the workspace's datasets are theirs to place too. */
    admin: boolean;
    onOpenChange: (open: boolean) => void;
    onPlaced: (datasetId: string) => void;
}) {
    const { t } = useTranslation(['spaces.dialogs']);
    const [name, setName] = useState('');
    const [candidates, setCandidates] = useState<Candidate[]>();
    const [chosen, setChosen] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    useEffect(() => {
        setName('');
        setChosen('');
        setError('');
        setCandidates(undefined);
        if (mode !== 'existing') {
            return;
        }
        let current = true;
        void (async () => {
            try {
                const own = await api<PrivateItemsResponse>('/data/private-items');
                const list: Candidate[] = own.items.map((item) => ({
                    id: item.id,
                    title: item.title,
                    ...(item.kind === 'dataset' && item.socio
                        ? { note: item.socio.name ?? t('spaces.dialogs:dataset.socio') }
                        : {}),
                }));
                if (admin) {
                    const all = await api<DatasetView[]>('/data/datasets');
                    for (const dataset of all) {
                        if (
                            isWorkspaceOwner(dataset.ownerUserId) &&
                            !dataset.sharedSpaceId &&
                            dataset.access === 'owner'
                        ) {
                            list.push({
                                id: dataset.id,
                                title: dataset.name,
                                note: dataset.plugin
                                    ? t('spaces.dialogs:dataset.written-by', { plugin: dataset.plugin.name })
                                    : t('spaces.dialogs:dataset.workspace'),
                            });
                        }
                    }
                }
                if (current) {
                    setCandidates(list);
                    setChosen(list[0]?.id ?? '');
                }
            } catch {
                if (current) {
                    setError(t('spaces.dialogs:dataset.load-failed'));
                }
            }
        })();
        return () => {
            current = false;
        };
    }, [mode, admin, t]);
    const place = async () => {
        setBusy(true);
        setError('');
        try {
            const placed =
                mode === 'new'
                    ? await api<DatasetView>('/data/datasets', 'POST', { name: name.trim(), sharedSpaceId: space.id })
                    : await api<DatasetView>(`/data/datasets/${encodeURIComponent(chosen)}`, 'PATCH', {
                          sharedSpaceId: space.id,
                      });
            toast.success(t('spaces.dialogs:dataset.placed', { dataset: placed.name, space: space.name }));
            notifyPagesChanged(space.id);
            onPlaced(placed.id);
        } catch (failure) {
            setError(failure instanceof Error ? failure.message : t('spaces.dialogs:dataset.failed'));
        } finally {
            setBusy(false);
        }
    };
    const ready = mode === 'new' ? !!name.trim() : !!chosen;
    return (
        <Dialog open={!!mode} onOpenChange={onOpenChange}>
            <DialogContent data-slot="place-dataset">
                <DialogHeader>
                    <DialogTitle>
                        {mode === 'new' ? t('spaces.dialogs:dataset.new') : t('spaces.dialogs:dataset.existing')}
                    </DialogTitle>
                    <DialogDescription>
                        {mode === 'new'
                            ? t('spaces.dialogs:dataset.description-new', { space: space.name })
                            : t('spaces.dialogs:dataset.description-existing', { space: space.name })}
                    </DialogDescription>
                </DialogHeader>
                {mode === 'new' ? (
                    <Input
                        aria-label={t('spaces.dialogs:dataset.name-label')}
                        placeholder={t('spaces.dialogs:dataset.name-placeholder')}
                        maxLength={80}
                        value={name}
                        onChange={(event) => setName(event.target.value)}
                        autoFocus
                    />
                ) : candidates === undefined ? (
                    !error && <p className="text-sm text-muted-foreground">{t('spaces.dialogs:dataset.loading')}</p>
                ) : candidates.length ? (
                    <select
                        aria-label={t('spaces.dialogs:dataset.choose-label')}
                        className="h-9 rounded-md border bg-background px-2 text-sm"
                        value={chosen}
                        onChange={(event) => setChosen(event.target.value)}
                    >
                        {candidates.map((candidate) => (
                            <option key={candidate.id} value={candidate.id}>
                                {candidate.note
                                    ? t('spaces.dialogs:dataset.option', {
                                          title: candidate.title,
                                          note: candidate.note,
                                      })
                                    : candidate.title}
                            </option>
                        ))}
                    </select>
                ) : (
                    <p className="text-sm text-muted-foreground">{t('spaces.dialogs:dataset.none')}</p>
                )}
                {error && (
                    <p role="alert" className="text-sm text-destructive">
                        {error}
                    </p>
                )}
                <DialogFooter>
                    <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
                        {t('spaces.dialogs:dataset.cancel')}
                    </Button>
                    <Button onClick={() => void place()} disabled={!ready || busy}>
                        {mode === 'new' ? t('spaces.dialogs:dataset.create') : t('spaces.dialogs:dataset.add')}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

/** The dataset dialog (`PlaceDataset`), once its words are in. */
export const PlaceDatasetDialog = onDemand(['spaces.dialogs'], PlaceDataset);

/**
 * A Space's dataset menu (CB-451): "New dataset" and "Add
 * existing dataset", shown to its editors only; a placed dataset opens.
 * Its words are the library's (spaces), so it renders on the server; the
 * dialog's load on demand (spaces.dialogs).
 */
export function SpaceDatasetActions({ space, admin }: { space: Pick<Space, 'id' | 'name'>; admin: boolean }) {
    const { t } = useTranslation(['spaces']);
    const navigate = useNavigate();
    const [placing, setPlacing] = useState<'new' | 'existing'>();
    return (
        <>
            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <Button size="sm" variant="outline" data-slot="space-new-dataset">
                        <Sheet /> {t('spaces:dataset-menu.button')}
                    </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={() => setPlacing('new')}>
                        {t('spaces:dataset-menu.new')}
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => setPlacing('existing')}>
                        {t('spaces:dataset-menu.existing')}
                    </DropdownMenuItem>
                </DropdownMenuContent>
            </DropdownMenu>
            <PlaceDatasetDialog
                space={space}
                mode={placing}
                admin={admin}
                onOpenChange={(open) => {
                    if (!open) {
                        setPlacing(undefined);
                    }
                }}
                onPlaced={(id) => {
                    setPlacing(undefined);
                    void navigate(datasetPath(id));
                }}
            />
        </>
    );
}

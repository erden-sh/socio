import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import type { CodingOptionsView } from '@socio/shared/coding/coding-gateway';

import { api } from '../../lib/api';
import { SettingsCard } from '../settings/AccountSettings';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';

/**
 * Settings → Coding → Personal plans (CB-239), for admins:
 * whether people may run their own coding sessions on their own ChatGPT
 * plan (connected under Account → Inference) instead of a listed model.
 * Off by default (over `CODING_PERSONAL_PLANS`); only ever for the
 * person's own sessions in their private chats, never in rooms, never for
 * anyone else's work. The server answers 404 while the flag
 * `coding-sessions` is off for the admin; then nothing shows.
 */
export function CodingPlansSection() {
    const [view, setView] = useState<CodingOptionsView>();
    const [busy, setBusy] = useState(false);
    useEffect(() => {
        const controller = new AbortController();
        api<CodingOptionsView>('/gateway/coding/options', 'GET', undefined, controller.signal)
            // Only a settings answer: anything else shows nothing.
            .then((next) => {
                if (typeof next?.personalPlans === 'boolean') {
                    setView(next);
                }
            })
            .catch(() => undefined);
        return () => controller.abort();
    }, []);
    if (!view) {
        return null;
    }
    const save = async (personalPlans: boolean | null) => {
        setBusy(true);
        try {
            setView(
                await api<CodingOptionsView>('/gateway/coding/options', 'PUT', {
                    personalPlans,
                }),
            );
            toast.success('Personal plans saved');
        } catch (error) {
            toast.error(error instanceof Error ? error.message : 'Could not save. Retry.');
        }
        setBusy(false);
    };
    return (
        <SettingsCard>
            <section className="grid gap-3" data-slot="coding-plans">
                <div className="grid gap-1">
                    <h3 className="font-medium">Personal plans</h3>
                    <p className="text-muted-foreground">
                        Let people run their own coding sessions on their own ChatGPT plan, the one they connected under
                        Account → Inference, instead of a model listed above. The repository’s code then goes to OpenAI
                        through that person’s plan, for any listed repository they may use; the session’s card says so.
                        Never in rooms, and never for anyone else’s sessions. Socio holds the person’s sign-in; the
                        sandbox never sees it.
                    </p>
                </div>
                <label className="flex items-center gap-2" htmlFor="coding-personal-plans">
                    <Checkbox
                        id="coding-personal-plans"
                        checked={view.personalPlans}
                        disabled={busy}
                        onCheckedChange={(value) => void save(value === true)}
                    />
                    People may use their own plan for their own coding sessions
                </label>
                <p className="text-xs text-muted-foreground">
                    Server default: {view.personalPlansDefault ? 'on' : 'off'}
                    {view.personalPlansSaved ? ' · changed here' : ''}
                </p>
                {view.personalPlansSaved && (
                    <div>
                        <Button size="sm" variant="outline" disabled={busy} onClick={() => void save(null)}>
                            Use the server default
                        </Button>
                    </div>
                )}
            </section>
        </SettingsCard>
    );
}

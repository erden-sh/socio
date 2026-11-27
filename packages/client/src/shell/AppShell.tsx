import { useCallback, useEffect, useState } from 'react';
import { Outlet, useLocation, useMatches, useNavigate } from 'react-router';

import { useTranslation } from '@socio/i18n/react';
import type { ModelChoice } from '@socio/shared/inference';
import type { AttachmentRef } from '@socio/shared/media-types';
import { isAdmin } from '@socio/shared/roles';
import type { Conversation, Dot, State, WorkspaceState } from '@socio/shared/types';

import { useVisibleHeight } from '../hooks/use-visible-height';
import { api, ApiError } from '../lib/api';
import { ClientOnly, useHydrated } from '../lib/client-only';
import { ResultPane } from '../modules/chat/ResultPane';
import { useDraftGuard } from '../modules/chat/use-draft-guard';
import { Onboarding } from '../modules/onboarding/Onboarding';
import { recordRender } from '../modules/settings/performance/recorder';
import { SETTINGS_HOME, settingsPath } from '../modules/settings/sections';
import { WorkspaceDialog, type Dialog, type EntityDialog } from '../modules/settings/WorkspaceDialog';
import type { ModuleTarget, NavDialog } from '../modules/types';

import { AppHeader } from './AppHeader';
import { navigateOrLoad, useBuildSkew } from './build-skew';
import { CommandPalette, usePaletteShortcut } from './CommandPalette';
import { GetTheAppBanner } from './GetTheApp';
import { useInAppNotices } from './in-app-notices';
import { useNoticeToasts } from './notice-toasts';
import type { Notices } from './poll-notice';
import { routeDot, ShellContext, usePageModuleId, useRouteParams, type RouteHandle, type Shell } from './shell-context';
import { useUiHints } from './ui-hints';

import { AppSidebar } from '@/components/app-sidebar';
import { readSidebarOpen, SidebarInset, SidebarProvider } from '@/components/ui/sidebar';
import { Toaster } from '@/components/ui/sonner';

export interface AppShellProps {
    state: State;
    workspace: WorkspaceState;
    configured: boolean;
    notices: Notices;
    setNotices: Shell['setNotices'];
    refresh: () => Promise<void>;
    /** Optimistic conversation patch (see App.tsx; Rooms follow-ups). */
    patchConversation: (id: string, patch: Partial<Conversation>) => void;
    onSwitchUser: () => void;
    /** The session was revoked already (sign out everywhere). */
    onSessionEnded?: () => void;
}

/**
 * The layout around every route: the sidebar, and the inset panel with the
 * `AppHeader` above the route's view; the command palette, toasts and
 * dialogs. It stays mounted across navigation, so the sidebar's collapse
 * state, the dialogs and the computer pane survive it.
 */
export function AppShell(props: AppShellProps) {
    useEffect(() => recordRender('shell'));
    const { state, workspace, configured, refresh, setNotices } = props;
    const { t } = useTranslation(['shell']);
    const hints = useUiHints();
    const hydrated = useHydrated();
    const navigate = useNavigate();
    const params = useRouteParams();
    const handle = useMatches()
        .map((match) => match.handle as RouteHandle | undefined)
        .filter(Boolean)
        .at(-1);
    const moduleId = usePageModuleId();
    const admin = isAdmin(workspace.user);
    const { setDirty, isDirty } = useDraftGuard();
    // After a deploy, the next navigation loads its page (build-skew.ts).
    useBuildSkew(isDirty);
    const go = navigateOrLoad((to) => void navigate(to));
    const [dialog, setDialog] = useState<EntityDialog>();
    const [pane, setPane] = useState(false);
    const [palette, setPalette] = useState(false);
    usePaletteShortcut(() => setPalette((open) => !open));
    useNoticeToasts(props.notices, setNotices);
    // Dots' notifications while the person is in the brain (CB-114).
    useInAppNotices(state.notices, go);
    useVisibleHeight(useLocation().pathname);
    const [busy, setBusy] = useState(false);
    const [pendingPrompt, setPendingPrompt] = useState<Shell['pendingPrompt']>();
    // A voice call to start on a just-created conversation (CB-302): voice as
    // the first message, before any text. The running chat starts it once
    // loaded, then consumes it.
    const [pendingVoice, setPendingVoice] = useState<Shell['pendingVoice']>();
    // The chat home shows the Dot last opened, as the old selected Dot did.
    const [lastDotId, setLastDotId] = useState('');
    const current = routeDot(workspace, params);
    const currentId = current?.id;
    useEffect(() => {
        if (currentId) {
            setLastDotId(currentId);
        }
    }, [currentId]);
    // Archived Dots (listed last, for their chats' names) are never a default.
    const inUse = workspace.dots.filter((item) => !item.archivedAt);
    const homeDot = inUse.find((item) => item.id === lastDotId) ?? inUse[0];
    const dot = (handle?.chat && current) || homeDot;
    const setError = useCallback(
        (action: string) => setNotices((notices) => (notices.action === action ? notices : { ...notices, action })),
        [setNotices],
    );
    const mutate = async (path: string, method: string, body?: unknown) => {
        setError('');
        try {
            await api(path, method, body);
            await refresh();
            return true;
        } catch (e) {
            if (e instanceof ApiError && e.status === 401) {
                await refresh();
            }
            setError(e instanceof Error ? e.message : t('shell:errors.save'));
            return false;
        }
    };
    const newConversation = async (
        withDot: Dot,
        text?: string,
        model?: ModelChoice | null,
        attachments: readonly AttachmentRef[] = [],
        options: { voice?: boolean } = {},
    ) => {
        if (!configured || busy) {
            return false;
        }
        setBusy(true);
        setError('');
        try {
            const next = await api<Conversation>('/conversations', 'POST', {
                dotId: withDot.id,
                title: text?.trim().slice(0, 80) || attachments[0]?.name.slice(0, 80) || t('shell:new-chat-title'),
                ...(model ? { inference: model } : {}),
            });
            await refresh();
            // The pending attachments are bound to the new thread by its first turn.
            setPendingPrompt(
                text?.trim() || attachments.length ? { threadId: next.id, text: text ?? '', attachments } : undefined,
            );
            // Voice as the first message (CB-302): start a call on the new thread
            // once the running chat loads it, instead of waiting for text.
            setPendingVoice(options.voice ? { threadId: next.id } : undefined);
            go(`/chats/${encodeURIComponent(next.id)}`);
            return true;
        } catch (e) {
            setError(e instanceof Error ? e.message : t('shell:errors.new-chat'));
            return false;
        } finally {
            setBusy(false);
        }
    };
    // Settings, the account and Telegram were dialogs; they are settings
    // pages now (CB-95), and what opened them opens those.
    const openSettings = useCallback((path: string) => void navigate(path), [navigate]);
    const openDialog = useCallback(
        (next: Dialog) => (next.type === 'settings' ? openSettings(SETTINGS_HOME) : setDialog(next)),
        [openSettings],
    );
    const openNavDialog = (next: NavDialog) =>
        go(
            next === 'telegram'
                ? settingsPath('telegram')
                : next === 'account'
                  ? settingsPath('account')
                  : SETTINGS_HOME,
        );
    const openTarget = (target: ModuleTarget) =>
        'path' in target
            ? target.reloadDocument
                ? window.location.assign(target.path)
                : go(target.path)
            : openNavDialog(target.dialog);
    const consumePrompt = useCallback(() => setPendingPrompt(undefined), []);
    const consumeVoice = useCallback(() => setPendingVoice(undefined), []);
    const closeDialog = () => setDialog(undefined);
    const shell: Shell = {
        state,
        workspace,
        admin,
        configured,
        refresh,
        patchConversation: props.patchConversation,
        mutate,
        setError,
        setNotices,
        openDialog,
        openTarget,
        setPalette,
        pane,
        setPane,
        homeDot,
        newConversation,
        busy,
        pendingPrompt,
        consumePrompt,
        pendingVoice,
        consumeVoice,
        setDirty,
        switchUser: props.onSwitchUser,
        sessionEnded: props.onSessionEnded,
    };
    const paneDot = (params.spaceId && inUse.find((item) => item.spaceIds.includes(params.spaceId!))?.id) || dot.id;
    return (
        <ShellContext.Provider value={shell}>
            {/* The saved state: from the page request while hydrating (the
          server rendered with it), from the cookie itself after. */}
            {/* As tall as what is visible, above an iPhone's keyboard too
          (CB-102); 100dvh until the browser has measured it. */}
            <SidebarProvider
                defaultOpen={hydrated ? readSidebarOpen() : hints.sidebarOpen}
                className="min-h-(--app-height,100dvh)"
            >
                <AppSidebar
                    context={{ admin, workspace, state, configured, homeDot }}
                    activeDotId={handle?.chat ? dot.id : undefined}
                    onNewChat={() => void newConversation(dot)}
                    onEditDot={(item) => setDialog({ type: 'dot', dot: item, spaceId: item.spaceId })}
                    onCreateDot={() => setDialog({ type: 'dot', spaceId: workspace.spaces[0].id })}
                    onCreateSpace={() => setDialog({ type: 'space' })}
                    onDialog={openNavDialog}
                    onSearch={() => setPalette(true)}
                    onSwitchUser={props.onSwitchUser}
                    moduleId={moduleId}
                />
                {/* Edge to edge when the keyboard leaves little room (CB-155). */}
                <SidebarInset className="h-(--app-height,100dvh) min-w-0 overflow-hidden keyboard-tight:m-0! md:h-[calc(var(--app-height,100dvh)-1rem)] keyboard-tight:md:h-(--app-height)">
                    <AppHeader dot={dot} />
                    {/* The inset's body: the view is its one scroll area, and views
              that own their height (chat, page editor) fill it. In
              .legacy-view plain elements get their browser defaults back
              (styles/legacy-reset.css); side panels and dialogs sit over
              it. The children don't shrink, and a page frame is full
              width, unless they say otherwise (zero specificity). */}
                    <div data-slot="app-body" data-tour="workspace-view" className="relative flex min-h-0 flex-1">
                        <div
                            className="legacy-view flex min-h-0 flex-1 flex-col overflow-y-auto bg-background [scrollbar-width:thin] [:where(&>*)]:shrink-0 [:where(&>.main-content)]:w-full"
                            data-view-canvas
                        >
                            <GetTheAppBanner />
                            {state.settings.paused && (
                                <div className="border-b border-b-paused-banner-border bg-paused-banner px-10 py-3 text-[11px] text-paused-banner-foreground max-[700px]:px-5.5 max-[700px]:text-[10px]">
                                    {t('shell:paused-banner')}
                                </div>
                            )}
                            <Outlet />
                        </div>
                        <div className="legacy-view contents">
                            {pane && !handle?.chat && (
                                // The computer pane over the view, below the header.
                                <div className="absolute inset-y-0 right-0 z-15 w-[min(660px,100vw)] overflow-auto bg-[#fdfcfb] [box-shadow:-8px_0_28px_#20263418] *:min-h-full dark:bg-[#20201f]">
                                    <ClientOnly>
                                        {() => (
                                            <ResultPane
                                                key={params.spaceId ?? dot.id}
                                                dots={inUse}
                                                defaultDotId={paneDot}
                                                dotState="idle"
                                                onClose={() => setPane(false)}
                                            />
                                        )}
                                    </ClientOnly>
                                </div>
                            )}
                            {dialog && (
                                <WorkspaceDialog
                                    dialog={dialog}
                                    state={state}
                                    workspace={workspace}
                                    onClose={closeDialog}
                                    mutate={mutate}
                                />
                            )}
                        </div>
                    </div>
                </SidebarInset>
            </SidebarProvider>
            <CommandPalette open={palette} onOpenChange={setPalette} />
            <Onboarding key={workspace.user.id} />
            <Toaster position="bottom-right" />
        </ShellContext.Provider>
    );
}

import { ChevronDown, Mic, MicOff, PhoneOff, Volume2, VolumeX, Maximize2 } from 'lucide-react';
import { useEffect, useState, type ComponentProps, type ReactNode } from 'react';

import type { Dot } from '@socio/shared/types';

import { Mascot } from '../../locals/Mascot';

import type { useVoice } from './useVoice';

import { cn } from '@/lib/utils';

export function CallView({
    dot,
    voice,
    className,
}: {
    dot: Dot;
    voice: ReturnType<typeof useVoice>;
    /** The chat view keeps the open call within its column's width. */
    className?: string;
}) {
    const [minimized, setMinimized] = useState(false);
    const [now, setNow] = useState(Date.now());
    useEffect(() => {
        if (voice.status !== 'active') {
            return;
        }
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
    }, [voice.status]);
    if (voice.status === 'idle') {
        return null;
    }
    const seconds = voice.startedAt ? Math.max(0, Math.floor((now - voice.startedAt) / 1000)) : 0;
    const duration = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
    const label =
        voice.status === 'connecting'
            ? 'Connecting…'
            : voice.status === 'ending'
              ? 'Saving call…'
              : voice.muted
                ? 'Microphone muted'
                : voice.phase === 'speaking'
                  ? `${dot.name} is speaking`
                  : voice.phase === 'thinking'
                    ? 'Working on it…'
                    : 'Listening';
    return (
        <section
            data-slot="call-view"
            data-minimized={minimized || undefined}
            className={cn(
                'fixed z-60 flex flex-col items-center overflow-auto bg-[radial-gradient(ellipse_at_50%_20%,var(--call-from)_0%,var(--call-via)_48%,var(--call-to)_100%)] text-white shadow-[0_24px_80px_rgb(21_62_59/0.19)]',
                minimized
                    ? 'right-6 bottom-27.5 w-75 rounded-[18px] p-4 max-[760px]:right-3 max-[760px]:bottom-25'
                    : 'inset-y-5 right-5 left-[max(290px,calc((100vw-1040px)/2))] rounded-[24px] px-8 py-6 max-[760px]:inset-2 max-[760px]:px-6 max-[760px]:py-4.5',
                className,
            )}
            aria-label={`Voice call with ${dot.name}`}
        >
            <div className="flex w-full items-center justify-between text-xs/[normal] text-white/80">
                <span className="flex items-center gap-2">
                    <span className="size-1.5 rounded-full bg-emerald-200" /> Voice call
                    {voice.backend === 'self-hosted' && !minimized && (
                        <span className="text-white/70 max-[400px]:hidden">· on your team’s voice server</span>
                    )}
                </span>
                <button
                    type="button"
                    data-slot="call-minimize"
                    className="flex rounded-full border border-white/12 bg-white/7 p-2.5 text-white transition-colors outline-none hover:bg-white/15 focus-visible:ring-[3px] focus-visible:ring-white/50"
                    aria-label={minimized ? 'Expand call view' : 'Minimize call view'}
                    onClick={() => setMinimized(!minimized)}
                >
                    {minimized ? <Maximize2 size={18} /> : <ChevronDown size={20} />}
                </button>
            </div>
            <div
                data-phase={voice.phase}
                className={cn(
                    'group/persona flex flex-col items-center',
                    minimized ? 'mt-2.5' : 'mt-[clamp(20px,8vh,90px)]',
                )}
            >
                <Mascot
                    identity={dot.id}
                    character={dot.character}
                    name={dot.name}
                    className={cn(
                        'drop-shadow-[0_15px_22px_rgb(11_41_37/0.16)] group-data-[phase=speaking]/persona:animate-call-breathe motion-reduce:animate-none!',
                        minimized ? 'size-13' : 'size-38.5',
                    )}
                />
                <h2
                    className={cn(
                        'font-[550] tracking-[-0.04em]',
                        minimized ? 'my-1 text-[15px]' : 'mt-4.5 mb-3.5 text-2xl/[normal]',
                    )}
                >
                    {dot.name}
                </h2>
                <span
                    className={cn('text-white/80 tabular-nums', minimized ? 'text-sm/[normal]' : 'text-xl/[normal]')}
                    aria-label="Call duration"
                >
                    {duration}
                </span>
                <p role="status" className={cn('text-[13px]/[1.7] text-white/80', minimized ? 'my-1.5' : 'my-3')}>
                    {label}
                </p>
                {/* Self-hosted (CB-265): stop the reply without speaking over it. */}
                {voice.backend === 'self-hosted' && voice.status === 'active' && voice.phase === 'speaking' && (
                    <button
                        type="button"
                        data-slot="call-interrupt"
                        className="rounded-full border border-white/20 bg-white/10 px-3.5 py-1.5 text-xs/[normal] text-white transition-colors outline-none hover:bg-white/15 focus-visible:ring-[3px] focus-visible:ring-white/50"
                        onClick={voice.interrupt}
                    >
                        Interrupt
                    </button>
                )}
            </div>
            {!minimized && (
                <div
                    className="min-h-20 w-[min(480px,100%)] flex-1 overflow-y-auto py-7 text-center text-lg/[1.7] text-white/90"
                    aria-live="polite"
                >
                    {voice.userCaption && (
                        <p className="mt-0 mb-5 text-sm/[1.7] text-white/80">
                            <small className={captionLabel}>You</small>
                            {voice.userCaption}
                        </p>
                    )}
                    <p className="mt-0 mb-5">
                        <small className={captionLabel}>{dot.name}</small>
                        {voice.caption || 'Speak naturally. Your socio is here with you.'}
                    </p>
                </div>
            )}
            {voice.notice && !voice.error && (
                <p
                    data-slot="call-notice"
                    className="mt-0 mb-3 max-w-110 text-center text-xs/[1.7] text-white/90"
                    role="status"
                >
                    {voice.notice}
                </p>
            )}
            {voice.error && (
                <p className="mt-0 mb-3 max-w-110 text-center text-xs/[1.7] text-orange-100" role="alert">
                    {voice.error}
                </p>
            )}
            <div className={cn('flex justify-center', minimized ? 'gap-5 pt-2' : 'gap-7 pt-5')}>
                <CallControl
                    minimized={minimized}
                    aria-label={voice.speakerMuted ? 'Enable call audio' : 'Mute call audio'}
                    aria-pressed={voice.speakerMuted}
                    onClick={voice.toggleSpeaker}
                    disabled={voice.status !== 'active'}
                    icon={voice.speakerMuted ? <VolumeX /> : <Volume2 />}
                    label="Speaker"
                />
                <CallControl
                    minimized={minimized}
                    end
                    aria-label="End voice call"
                    onClick={() => void voice.end()}
                    disabled={voice.status === 'ending'}
                    icon={<PhoneOff />}
                    label="End"
                />
                <CallControl
                    minimized={minimized}
                    aria-label={voice.muted ? 'Unmute microphone' : 'Mute microphone'}
                    aria-pressed={voice.muted}
                    onClick={voice.toggleMute}
                    disabled={voice.status !== 'active'}
                    icon={voice.muted ? <MicOff /> : <Mic />}
                    label={voice.muted ? 'Unmute' : 'Mute'}
                />
            </div>
            {!minimized && (
                <p className="mt-6.5 mb-1 text-[11px]/[1.7] text-white/70">Text and voice share this conversation</p>
            )}
        </section>
    );
}

/** Who speaks, above a caption. */
const captionLabel = 'mb-1.5 block text-[11px] tracking-[0.04em] text-white/70';

/** A round call control with its label under it (Speaker, End, Mute). */
function CallControl({
    minimized,
    end = false,
    icon,
    label,
    ...props
}: ComponentProps<'button'> & {
    minimized: boolean;
    end?: boolean;
    icon: ReactNode;
    label: string;
}) {
    return (
        <button
            type="button"
            data-slot="call-control"
            className="group/control flex flex-col items-center gap-2.5 rounded-lg bg-transparent p-0 text-white outline-none focus-visible:ring-[3px] focus-visible:ring-white/50 disabled:cursor-not-allowed disabled:opacity-50"
            {...props}
        >
            <span
                className={cn(
                    'grid place-items-center rounded-full border',
                    minimized ? 'size-10' : 'size-14.5',
                    end
                        ? 'border-call-end bg-call-end group-enabled/control:group-hover/control:brightness-90'
                        : 'border-white/10 bg-white/10 group-enabled/control:group-hover/control:bg-white/15 group-aria-pressed/control:bg-emerald-50 group-aria-pressed/control:text-call-via',
                )}
            >
                {icon}
            </span>
            <small className="text-xs/[normal]">{label}</small>
        </button>
    );
}

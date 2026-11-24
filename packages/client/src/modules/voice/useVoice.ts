import { useCallback, useEffect, useRef, useState } from 'react';

import type { VoiceBackend } from '@socio/shared/voice/voice-call';

import { api } from '../../lib/api';
import { postWrite } from '../../lib/change-channel';

import { SelfHostedCall, callAudio, selfHostedCallSupported } from './self-hosted-call';

// A single failed control poll is usually a network flap, not a dead call.
// Only treat the control connection as lost after this many consecutive
// poll failures, mirroring the grace period #26 gives the peer connection.
const CONTROL_POLL_FAILURE_LIMIT = 3;
/** Which backend calls use (CB-265), and whether cloud is there to fall back to. */
export interface VoiceOptions {
    backend?: VoiceBackend;
    cloud?: boolean;
    /**
     * A self-hosted call's turn is done (CB-265): the server stored it in
     * the conversation, which the chat behind the call can now show.
     */
    onTurn?: () => void;
}
export function useVoice(threadId: string, onSaved: () => void, anchorMessageId?: string, options: VoiceOptions = {}) {
    const [status, setStatus] = useState<'idle' | 'connecting' | 'active' | 'ending'>('idle');
    const generation = useRef(0);
    const connecting = useRef(false);
    const ending = useRef(false);
    const [error, setError] = useState('');
    const [muted, setMuted] = useState(false);
    const [speakerMuted, setSpeakerMuted] = useState(false);
    const [startedAt, setStartedAt] = useState<number>();
    const [phase, setPhase] = useState<'listening' | 'speaking' | 'thinking'>('listening');
    const [caption, setCaption] = useState('');
    const [userCaption, setUserCaption] = useState('');
    /** Self-hosted (CB-265): something to show, such as an approval waiting. */
    const [notice, setNotice] = useState('');
    /** A self-hosted call couldn't connect, and a cloud call could take it. */
    const [canFallBack, setCanFallBack] = useState(false);
    /** The backend of the call in progress (or the last one). */
    const [backendInUse, setBackendInUse] = useState<VoiceBackend>(options.backend ?? 'cloud');
    const selfHosted = useRef<
        | {
              call?: SelfHostedCall;
              id?: string;
              transcript: string[];
              timer?: ReturnType<typeof setTimeout>;
              controlPollFailures: number;
              cancelled: boolean;
              /** The voice server listened: the call was active. */
              connected?: boolean;
              stream?: MediaStream;
              context?: AudioContext;
          }
        | undefined
    >(undefined);
    const session = useRef<
        | {
              pc: RTCPeerConnection;
              stream: MediaStream;
              audio: HTMLAudioElement;
              id?: string;
              channel: RTCDataChannel;
              transcript: string[];
              timer?: ReturnType<typeof setTimeout>;
              controlPollFailures: number;
              disconnectTimer?: ReturnType<typeof setTimeout>;
              cancelled: boolean;
          }
        | undefined
    >(undefined);
    const anchor = useRef(anchorMessageId);
    anchor.current = anchorMessageId;
    const closeMedia = useCallback(() => {
        const local = selfHosted.current;
        if (local) {
            local.cancelled = true;
            clearTimeout(local.timer);
            local.call?.close();
            local.stream?.getTracks().forEach((track) => track.stop());
            if (!local.call) {
                void local.context?.close().catch(() => undefined);
            }
        }
        const current = session.current;
        if (!current) {
            return;
        }
        current.cancelled = true;
        current.stream.getTracks().forEach((track) => track.stop());
        current.channel.close();
        current.pc.close();
        current.audio.pause();
        current.audio.srcObject = null;
        clearTimeout(current.timer);
        clearTimeout(current.disconnectTimer);
    }, []);
    const end = useCallback(async () => {
        if (ending.current) {
            return;
        }
        generation.current++;
        connecting.current = false;
        const local = selfHosted.current;
        if (local) {
            // The microphone and speech stop at once; the server keeps the
            // transcript it heard (CB-265).
            ending.current = true;
            setStatus('ending');
            local.cancelled = true;
            clearTimeout(local.timer);
            local.call?.close();
            try {
                if (local.id) {
                    await api(`/voice/calls/${local.id}/end`, 'POST', {
                        transcript: local.transcript.join('\n').slice(0, 20000),
                        anchorMessageId: anchor.current,
                    });
                }
                onSaved();
            } catch (e) {
                setError(e instanceof Error ? e.message : 'Call ended, but its receipt could not be saved.');
            } finally {
                closeMedia();
                selfHosted.current = undefined;
                ending.current = false;
                setStatus('idle');
            }
            return;
        }
        const current = session.current;
        if (!current) {
            setStatus('idle');
            return;
        }
        // Silence the call immediately, while keeping the peer alive until the
        // provider confirms hangup through the server.
        current.cancelled = true;
        current.stream.getTracks().forEach((track) => {
            track.enabled = false;
        });
        current.audio.pause();
        clearTimeout(current.timer);
        clearTimeout(current.disconnectTimer);
        ending.current = true;
        setStatus('ending');
        try {
            if (current.id) {
                await api(`/voice/calls/${current.id}/end`, 'POST', {
                    transcript: current.transcript.join('\n').slice(0, 20000),
                    anchorMessageId: anchor.current,
                });
            }
            onSaved();
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Call ended, but its receipt could not be saved.');
        } finally {
            closeMedia();
            session.current = undefined;
            ending.current = false;
            setStatus('idle');
        }
    }, [closeMedia, onSaved]);
    useEffect(
        () => () => {
            generation.current++;
            const current = session.current ?? selfHosted.current;
            closeMedia();
            if (current?.id && !ending.current) {
                void fetch(`/api/voice/calls/${current.id}/end`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        transcript: current.transcript.join('\n').slice(0, 20000),
                        anchorMessageId: anchor.current,
                    }),
                    keepalive: true,
                })
                    .then((response) => {
                        if (response.ok) {
                            postWrite(`/voice/calls/${current.id}/end`);
                        }
                    })
                    .catch(() => {});
            }
        },
        [closeMedia],
    );
    useEffect(() => {
        if (status !== 'active' && status !== 'connecting') {
            return;
        }
        const timer = setInterval(() => {
            const current = session.current ?? selfHosted.current;
            const id = current?.id;
            const same = () => (session.current ?? selfHosted.current) === current && !!current;
            if (id && current) {
                void api<{ endedAt: number | null }>(`/voice/calls/${id}`)
                    .then((call) => {
                        if (!same()) {
                            return;
                        }
                        if (call.endedAt) {
                            void end();
                            return;
                        }
                        current.controlPollFailures = 0;
                    })
                    .catch(() => {
                        if (!same()) {
                            return;
                        }
                        current.controlPollFailures += 1;
                        if (current.controlPollFailures < CONTROL_POLL_FAILURE_LIMIT) {
                            return;
                        }
                        setError('Call control connection was lost.');
                        void end();
                    });
            }
        }, 2000);
        return () => clearInterval(timer);
    }, [status, closeMedia, onSaved, end]);
    const start = async (backend: VoiceBackend = options.backend ?? 'cloud') => {
        if (session.current || selfHosted.current || connecting.current || ending.current) {
            return;
        }
        connecting.current = true;
        const attempt = ++generation.current;
        setStatus('connecting');
        setError('');
        setNotice('');
        setCanFallBack(false);
        setBackendInUse(backend);
        setMuted(false);
        setSpeakerMuted(false);
        setStartedAt(undefined);
        setPhase('listening');
        setCaption('');
        setUserCaption('');
        if (backend === 'self-hosted') {
            await startSelfHosted(attempt);
            return;
        }
        let stream: MediaStream | undefined;
        try {
            stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            if (attempt !== generation.current) {
                stream.getTracks().forEach((track) => track.stop());
                return;
            }
            const pc = new RTCPeerConnection();
            const audio = new Audio();
            audio.autoplay = true;
            const channel = pc.createDataChannel('oai-events');
            const current = {
                pc,
                audio,
                stream,
                channel,
                transcript: [] as string[],
                cancelled: false,
                id: undefined as string | undefined,
                timer: undefined as ReturnType<typeof setTimeout> | undefined,
                controlPollFailures: 0,
                disconnectTimer: undefined as ReturnType<typeof setTimeout> | undefined,
            };
            session.current = current;
            stream.getTracks().forEach((track) => pc.addTrack(track, stream!));
            pc.ontrack = (event) => {
                if (current.cancelled) {
                    return;
                }
                audio.srcObject = event.streams[0] ?? new MediaStream([event.track]);
                void audio.play().catch(() => {
                    if (!current.cancelled) {
                        setError('Audio playback was blocked. Check your browser audio permissions.');
                    }
                });
            };
            pc.onconnectionstatechange = () => {
                if (current.cancelled) {
                    return;
                }
                if (pc.connectionState === 'connected') {
                    clearTimeout(current.disconnectTimer);
                    current.disconnectTimer = undefined;
                    setStatus('active');
                    setStartedAt((value) => value ?? Date.now());
                    if (current.id) {
                        void api(`/voice/calls/${current.id}/active`, 'POST', {}).catch((e) => {
                            if (!current.cancelled) {
                                setError(e.message);
                            }
                        });
                    }
                }
                if (pc.connectionState === 'disconnected' && !current.disconnectTimer) {
                    current.disconnectTimer = setTimeout(() => {
                        current.disconnectTimer = undefined;
                        if (current.cancelled || pc.connectionState !== 'disconnected') {
                            return;
                        }
                        setError('The voice connection dropped.');
                        void end();
                    }, 5000);
                }
                if (pc.connectionState === 'failed') {
                    setError('The voice connection dropped.');
                    void end();
                }
            };
            channel.onmessage = async (event) => {
                if (current.cancelled) {
                    return;
                }
                let data: Record<string, unknown>;
                try {
                    const parsed: unknown = JSON.parse(String(event.data));
                    if (!parsed || typeof parsed !== 'object') {
                        return;
                    }
                    data = parsed as Record<string, unknown>;
                } catch {
                    return;
                }
                if (data.type === 'input_audio_buffer.speech_started') {
                    setPhase('listening');
                    setCaption('');
                }
                if (data.type === 'response.output_audio_transcript.delta' && typeof data.delta === 'string') {
                    setPhase('speaking');
                    setCaption((text) => text + data.delta);
                }
                if (data.type === 'output_audio_buffer.stopped') {
                    setPhase('listening');
                }
                if (data.type === 'response.created') {
                    setCaption('');
                    setPhase('thinking');
                }
                if (typeof data.transcript === 'string') {
                    if (data.type === 'conversation.item.input_audio_transcription.completed') {
                        current.transcript.push(`You: ${data.transcript}`);
                        setUserCaption(data.transcript);
                    }
                    if (data.type === 'response.output_audio_transcript.done') {
                        current.transcript.push(`Socio: ${data.transcript}`);
                    }
                }
                if (data.type === 'error') {
                    setError('The voice provider reported a session error. End the call and retry.');
                }
                if (
                    data.type !== 'response.function_call_arguments.done' ||
                    data.name !== 'ask_compute' ||
                    typeof data.call_id !== 'string' ||
                    !current.id
                ) {
                    return;
                }
                let output: string;
                setPhase('thinking');
                try {
                    const args: unknown = JSON.parse(String(data.arguments));
                    if (!args || typeof args !== 'object' || !('request' in args) || typeof args.request !== 'string') {
                        throw new Error('Invalid compute request.');
                    }
                    const result = await api<{ text: string }>(`/voice/calls/${current.id}/compute`, 'POST', {
                        toolCallId: data.call_id,
                        request: args.request,
                        transcript: current.transcript.join('\n').slice(-12000),
                    });
                    output = result.text;
                } catch (e) {
                    output = `Compute failed: ${e instanceof Error ? e.message : 'Unknown error'}`;
                }
                if (!current.cancelled && channel.readyState === 'open') {
                    channel.send(
                        JSON.stringify({
                            type: 'conversation.item.create',
                            item: {
                                type: 'function_call_output',
                                call_id: data.call_id,
                                output,
                            },
                        }),
                    );
                    channel.send(JSON.stringify({ type: 'response.create' }));
                }
            };
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            const response = await api<{ id: string; sdp: string }>('/voice/calls', 'POST', {
                threadId,
                sdp: offer.sdp,
                backend: 'cloud',
            });
            current.id = response.id;
            if (current.cancelled) {
                await api(`/voice/calls/${response.id}/end`, 'POST', {
                    transcript: '',
                });
                return;
            }
            await pc.setRemoteDescription({ type: 'answer', sdp: response.sdp });
            if (current.cancelled) {
                return;
            }
            current.timer = setTimeout(() => void end(), 15 * 60_000);
        } catch (e) {
            if (attempt !== generation.current) {
                stream?.getTracks().forEach((track) => track.stop());
                return;
            }
            const current = session.current;
            const id = current?.id;
            if (id) {
                void api(`/voice/calls/${id}/end`, 'POST', {
                    transcript: '',
                    anchorMessageId: anchor.current,
                }).catch(() => {});
            }
            stream?.getTracks().forEach((track) => track.stop());
            closeMedia();
            session.current = undefined;
            setStatus('idle');
            setError(e instanceof Error ? e.message : 'Could not connect the call.');
        } finally {
            if (attempt === generation.current) {
                connecting.current = false;
            }
        }
    };
    /**
     * A self-hosted call (CB-265): the call is recorded, then the socket
     * carries the microphone and the replies. When it can't connect, the
     * reason shows, with a cloud call to fall back to where there is one.
     */
    const startSelfHosted = async (attempt: number) => {
        const local: NonNullable<typeof selfHosted.current> = {
            transcript: [],
            controlPollFailures: 0,
            cancelled: false,
        };
        selfHosted.current = local;
        const fail = (message: string) => {
            if (local.id) {
                void api(`/voice/calls/${local.id}/end`, 'POST', {
                    transcript: local.transcript.join('\n').slice(0, 20000),
                    anchorMessageId: anchor.current,
                }).catch(() => {});
            }
            closeMedia();
            if (selfHosted.current === local) {
                selfHosted.current = undefined;
            }
            setStatus('idle');
            setError(message);
            setCanFallBack(!!options.cloud);
        };
        try {
            if (!selfHostedCallSupported()) {
                throw new Error('This browser can’t make self-hosted calls. Try a current Safari, Chrome or Firefox.');
            }
            // In the tap: iOS runs only audio started in a gesture.
            local.context = callAudio();
            if (!local.context) {
                throw new Error('This browser can’t play call audio.');
            }
            local.stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true,
                    channelCount: 1,
                },
            });
            if (attempt !== generation.current || local.cancelled) {
                closeMedia();
                return;
            }
            const response = await api<{ id: string }>('/voice/calls', 'POST', {
                threadId,
                backend: 'self-hosted',
            });
            local.id = response.id;
            if (attempt !== generation.current || local.cancelled) {
                await api(`/voice/calls/${response.id}/end`, 'POST', {
                    transcript: '',
                });
                return;
            }
            local.call = await SelfHostedCall.start(response.id, local.context, local.stream, {
                onReady: () => {
                    if (local.cancelled) {
                        return;
                    }
                    local.connected = true;
                    setStatus('active');
                    setStartedAt((value) => value ?? Date.now());
                },
                onPhase: (next) => {
                    if (local.cancelled) {
                        return;
                    }
                    setPhase(next);
                    if (next === 'thinking') {
                        setCaption('');
                    }
                },
                onPartial: (text) => !local.cancelled && setUserCaption(text),
                onHeard: (text) => {
                    if (local.cancelled) {
                        return;
                    }
                    local.transcript.push(`You: ${text}`);
                    setUserCaption(text);
                },
                onReply: (text) => {
                    if (local.cancelled) {
                        return;
                    }
                    local.transcript.push(`Socio: ${text}`);
                    setCaption(text);
                    options.onTurn?.();
                },
                onNotice: (text) => !local.cancelled && setNotice(text),
                onEnded: (reason) => {
                    if (local.cancelled) {
                        return;
                    }
                    if (!local.connected) {
                        // It never connected: nothing to save but the failure.
                        fail(reason ?? 'Could not connect the call.');
                        return;
                    }
                    setError(reason ?? 'The voice connection dropped.');
                    void end();
                },
            });
            if (local.cancelled) {
                local.call.close();
                return;
            }
            local.timer = setTimeout(() => void end(), 15 * 60_000);
        } catch (e) {
            if (attempt !== generation.current) {
                closeMedia();
                return;
            }
            fail(e instanceof Error ? e.message : 'Could not connect the call.');
        } finally {
            if (attempt === generation.current) {
                connecting.current = false;
            }
        }
    };
    const toggleMute = () => {
        const next = !muted;
        (session.current?.stream ?? selfHosted.current?.stream)?.getAudioTracks().forEach((track) => {
            track.enabled = !next;
        });
        setMuted(next);
    };
    const toggleSpeaker = () => {
        const next = !speakerMuted;
        if (session.current) {
            session.current.audio.muted = next;
        }
        selfHosted.current?.call?.setSpeakerMuted(next);
        setSpeakerMuted(next);
    };
    /** Self-hosted (CB-265): the socio stops speaking now. */
    const interrupt = () => selfHosted.current?.call?.interrupt();
    /** After a self-hosted call couldn't connect: the same call over cloud voice. */
    const fallBack = () => {
        setCanFallBack(false);
        void start('cloud');
    };
    return {
        status,
        error,
        start,
        end,
        muted,
        speakerMuted,
        startedAt,
        phase,
        caption,
        userCaption,
        toggleMute,
        toggleSpeaker,
        backend: backendInUse,
        notice,
        canFallBack,
        interrupt,
        fallBack,
    };
}

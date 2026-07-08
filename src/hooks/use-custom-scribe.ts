"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export interface TranscriptSegment {
	id: string;
	text: string;
	isFinal: boolean;
	timestamp: number;
}

interface UseCustomScribeOptions {
	/** The mixed MediaStream from useAudioMixer */
	stream: MediaStream | null;
	/** A display name shown in transcript entries */
	username: string;
	/** Called for every final committed segment */
	onCommitted: (segment: TranscriptSegment) => void;
	/** Called with the current live partial text */
	onPartial?: (text: string) => void;
}

export interface CustomScribeState {
	isConnected: boolean;
	isConnecting: boolean;
	partialText: string;
	error: string | null;
	connect: () => Promise<void>;
	disconnect: () => void;
}

/**
 * useCustomScribe
 *
 * Uses the ElevenLabs Scribe WebSocket API (scribe_v2_realtime) with a
 * custom MediaStream instead of the SDK-managed microphone.  Audio is:
 *   1. Routed into a mono 16kHz AudioContext channel via a ScriptProcessorNode
 *   2. Converted to PCM16 Int16Array
 *   3. Sent as binary frames over the WebSocket
 */
export function useCustomScribe({
	stream,
	username,
	onCommitted,
	onPartial,
}: UseCustomScribeOptions): CustomScribeState {
	const [isConnected, setIsConnected] = useState(false);
	const [isConnecting, setIsConnecting] = useState(false);
	const [partialText, setPartialText] = useState("");
	const [error, setError] = useState<string | null>(null);

	const wsRef = useRef<WebSocket | null>(null);
	const ctxRef = useRef<AudioContext | null>(null);
	const processorRef = useRef<ScriptProcessorNode | null>(null);
	const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
	const silenceFramesRef = useRef(0);
	const onCommittedRef = useRef(onCommitted);
	const onPartialRef = useRef(onPartial);

	useEffect(() => {
		onCommittedRef.current = onCommitted;
	}, [onCommitted]);
	useEffect(() => {
		onPartialRef.current = onPartial;
	}, [onPartial]);

	const disconnect = useCallback(() => {
		processorRef.current?.disconnect();
		processorRef.current = null;
		sourceRef.current?.disconnect();
		sourceRef.current = null;
		ctxRef.current?.close().catch(() => {});
		ctxRef.current = null;
		silenceFramesRef.current = 0;

		if (wsRef.current) {
			if (
				wsRef.current.readyState === WebSocket.OPEN ||
				wsRef.current.readyState === WebSocket.CONNECTING
			) {
				wsRef.current.close();
			}
			wsRef.current = null;
		}

		setIsConnected(false);
		setIsConnecting(false);
		setPartialText("");
	}, []);

	const connect = useCallback(async () => {
		if (!stream) {
			setError("No audio stream available — start the audio mixer first.");
			return;
		}
		if (isConnected || isConnecting) return;

		setError(null);
		setIsConnecting(true);
		silenceFramesRef.current = 0;

		try {
			// 1. Get a single-use token from our backend
			const res = await fetch("/api/elevenlabs/token");
			if (!res.ok) throw new Error("Failed to fetch ElevenLabs token");
			const { token } = await res.json();

			// 2. Open a WebSocket to Scribe using the token
			// Protocol format: wss://api.elevenlabs.io/v1/speech-to-text/stream?token=<token>&model_id=scribe_v2_realtime
			const url = `wss://api.elevenlabs.io/v1/speech-to-text/stream?model_id=scribe_v2_realtime`;
			const ws = new WebSocket(url, ["bearer", token]);
			wsRef.current = ws;

			ws.binaryType = "arraybuffer";

			ws.onopen = () => {
				setIsConnected(true);
				setIsConnecting(false);

				// 3. Set up audio pipeline: stream → AudioContext → ScriptProcessor → PCM16 → ws
				const ctx = new AudioContext({ sampleRate: 16000 });
				ctxRef.current = ctx;

				const source = ctx.createMediaStreamSource(stream);
				sourceRef.current = source;

				// ScriptProcessorNode is the most compatible way to intercept raw PCM in-browser
				// 4096 samples ≈ 256ms at 16kHz — good for real-time streaming
				const BUFFER = 4096;
				const processor = ctx.createScriptProcessor(BUFFER, 1, 1);
				processorRef.current = processor;

				processor.onaudioprocess = (e) => {
					if (ws.readyState !== WebSocket.OPEN) return;
					const float32 = e.inputBuffer.getChannelData(0);

					// ── Meetily VAD / Silence Gate ────────────────────────────────────
					// Calculate RMS energy of the 4096-sample buffer (~256ms).
					// If energy is below silence threshold (< 0.003), increment silence counter.
					// If we've been in silence for > 6 frames (~1.5 seconds), skip sending
					// to Scribe to save quota/tokens and prevent AI hallucinations during silences.
					let sum = 0;
					for (let i = 0; i < float32.length; i++) sum += float32[i] * float32[i];
					const rms = Math.sqrt(sum / float32.length);

					if (rms < 0.003) {
						silenceFramesRef.current++;
						if (silenceFramesRef.current > 6) {
							return; // Skip silence block
						}
					} else {
						// Voice / audio activity detected! Reset silence counter immediately.
						silenceFramesRef.current = 0;
					}

					// Convert Float32 → PCM16 Int16Array
					const pcm16 = new Int16Array(float32.length);
					for (let i = 0; i < float32.length; i++) {
						const s = Math.max(-1, Math.min(1, float32[i]));
						pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
					}
					ws.send(pcm16.buffer);
				};

				source.connect(processor);
				processor.connect(ctx.destination);
			};

			ws.onmessage = (event) => {
				try {
					const data = JSON.parse(event.data as string);

					if (data.type === "partial_transcript" || data.type === "partial") {
						const text = data.text ?? data.transcript ?? "";
						setPartialText(text);
						onPartialRef.current?.(text);
					} else if (
						data.type === "committed_transcript" ||
						data.type === "committed" ||
						data.type === "final"
					) {
						const text =
							(data.text ?? data.transcript ?? "").trim();
						if (text) {
							setPartialText("");
							onPartialRef.current?.("");
							onCommittedRef.current({
								id: `${Date.now()}-${Math.random()}`,
								text,
								isFinal: true,
								timestamp: Date.now(),
							});
						}
					}
				} catch {
					// Non-JSON frames are ignored
				}
			};

			ws.onerror = () => {
				setError("WebSocket error — check your ElevenLabs API key.");
				setIsConnecting(false);
				setIsConnected(false);
			};

			ws.onclose = () => {
				setIsConnected(false);
				setIsConnecting(false);
				// Clean up audio nodes
				processorRef.current?.disconnect();
				sourceRef.current?.disconnect();
				ctxRef.current?.close().catch(() => {});
				processorRef.current = null;
				sourceRef.current = null;
				ctxRef.current = null;
			};
		} catch (e) {
			const msg = e instanceof Error ? e.message : "Connection failed";
			setError(msg);
			setIsConnecting(false);
		}
	}, [stream, isConnected, isConnecting]);

	// Auto-disconnect when stream changes or is removed
	useEffect(() => {
		if (!stream && isConnected) disconnect();
	}, [stream, isConnected, disconnect]);

	// Cleanup on unmount
	useEffect(() => {
		return () => disconnect();
	// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	return { isConnected, isConnecting, partialText, error, connect, disconnect };
}

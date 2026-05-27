"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type AudioSource = "microphone" | "system" | "both";

export interface AudioLevel {
	mic: number;
	system: number;
}

interface UseAudioMixerOptions {
	/** Which sources to capture. Default = "both". */
	source?: AudioSource;
	/** Callback firing ~20/s with normalised 0-1 levels for each track */
	onLevels?: (levels: AudioLevel) => void;
}

export interface AudioMixerState {
	/** Combined MediaStream ready to feed into Scribe */
	stream: MediaStream | null;
	isCapturing: boolean;
	hasMic: boolean;
	hasSystem: boolean;
	error: string | null;
	start: () => Promise<void>;
	stop: () => void;
}

/** Shared AudioContext — created once and reused */
let sharedCtx: AudioContext | null = null;
function getAudioContext(): AudioContext {
	if (!sharedCtx || sharedCtx.state === "closed") {
		sharedCtx = new AudioContext({ sampleRate: 16000 });
	}
	return sharedCtx;
}

/**
 * Creates a AnalyserNode for a source track and polls it for RMS level.
 * Returns a cleanup function.
 */
function attachLevelMeter(
	ctx: AudioContext,
	track: MediaStreamTrack,
	onLevel: (rms: number) => void,
): () => void {
	const stream = new MediaStream([track]);
	const source = ctx.createMediaStreamSource(stream);
	const analyser = ctx.createAnalyser();
	analyser.fftSize = 512;
	analyser.smoothingTimeConstant = 0.5;
	source.connect(analyser);
	const data = new Float32Array(analyser.fftSize);

	let rafId: number;
	const tick = () => {
		analyser.getFloatTimeDomainData(data);
		let sum = 0;
		for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
		const rms = Math.sqrt(sum / data.length);
		onLevel(Math.min(rms * 5, 1)); // amplify slightly and clamp
		rafId = requestAnimationFrame(tick);
	};
	rafId = requestAnimationFrame(tick);

	return () => {
		cancelAnimationFrame(rafId);
		source.disconnect();
	};
}

/**
 * useAudioMixer
 *
 * Requests microphone and/or system audio (via getDisplayMedia with
 * audio-only), merges them into a single AudioContext destination, and
 * exposes the combined stream for use with ElevenLabs Scribe.
 */
export function useAudioMixer({
	source = "both",
	onLevels,
}: UseAudioMixerOptions = {}): AudioMixerState {
	const [stream, setStream] = useState<MediaStream | null>(null);
	const [isCapturing, setIsCapturing] = useState(false);
	const [hasMic, setHasMic] = useState(false);
	const [hasSystem, setHasSystem] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// Hold refs to cleanup callbacks
	const cleanupRef = useRef<(() => void)[]>([]);
	const onLevelsRef = useRef(onLevels);
	useEffect(() => {
		onLevelsRef.current = onLevels;
	}, [onLevels]);

	const stop = useCallback(() => {
		for (const fn of cleanupRef.current) fn();
		cleanupRef.current = [];

		if (stream) {
			for (const t of stream.getTracks()) t.stop();
		}
		setStream(null);
		setIsCapturing(false);
		setHasMic(false);
		setHasSystem(false);
		setError(null);
	}, [stream]);

	const start = useCallback(async () => {
		setError(null);
		try {
			const ctx = getAudioContext();
			if (ctx.state === "suspended") await ctx.resume();

			const dest = ctx.createMediaStreamDestination();

			let micTrack: MediaStreamTrack | null = null;
			let sysTrack: MediaStreamTrack | null = null;

			// ── Microphone ───────────────────────────────────────────────────
			if (source === "microphone" || source === "both") {
				try {
					const micStream = await navigator.mediaDevices.getUserMedia({
						audio: {
							echoCancellation: true,
							noiseSuppression: true,
							autoGainControl: true,
							sampleRate: 16000,
							channelCount: 1,
						},
						video: false,
					});
					micTrack = micStream.getAudioTracks()[0];
					if (micTrack) {
						const src = ctx.createMediaStreamSource(new MediaStream([micTrack]));
						src.connect(dest);
						setHasMic(true);

						// Level meter for mic
						const cleanup = attachLevelMeter(ctx, micTrack, (rms) => {
							onLevelsRef.current?.({ mic: rms, system: 0 });
						});
						cleanupRef.current.push(cleanup);
						cleanupRef.current.push(() => micTrack?.stop());
					}
				} catch (e) {
					console.warn("Microphone not available:", e);
				}
			}

			// ── System / tab audio ───────────────────────────────────────────
			if (source === "system" || source === "both") {
				try {
					// getDisplayMedia prompts the user to share a window or tab.
					// They MUST check "Share audio" / "Share tab audio" for system
					// audio to be included.
					const displayStream = await navigator.mediaDevices.getDisplayMedia({
						video: true, // must include video to trigger the share picker
						audio: {
							echoCancellation: false,
							noiseSuppression: false,
							sampleRate: 16000,
							channelCount: 1,
						},
					} as DisplayMediaStreamOptions);

					// Stop the video track — we only want audio
					for (const vt of displayStream.getVideoTracks()) vt.stop();

					const audioTracks = displayStream.getAudioTracks();
					if (audioTracks.length > 0) {
						sysTrack = audioTracks[0];
						const src = ctx.createMediaStreamSource(
							new MediaStream([sysTrack]),
						);
						src.connect(dest);
						setHasSystem(true);

						// Level meter for system audio
						const cleanup = attachLevelMeter(ctx, sysTrack, (rms) => {
							onLevelsRef.current?.({ mic: 0, system: rms });
						});
						cleanupRef.current.push(cleanup);
						cleanupRef.current.push(() => sysTrack?.stop());

						// When the user stops screen-share, clean up gracefully
						sysTrack.addEventListener("ended", () => {
							setHasSystem(false);
						});
					} else {
						console.warn(
							"No system audio track found — user may not have checked 'Share audio'.",
						);
					}
				} catch (e) {
					// User cancelled display picker — not a fatal error
					console.warn("System audio not captured:", e);
				}
			}

			if (!micTrack && !sysTrack) {
				throw new Error(
					"No audio sources could be captured. Please allow microphone access or select a window to share.",
				);
			}

			setStream(dest.stream);
			setIsCapturing(true);
		} catch (e) {
			const msg = e instanceof Error ? e.message : "Unknown audio error";
			setError(msg);
			setIsCapturing(false);
		}
	}, [source]);

	// Cleanup on unmount
	useEffect(() => {
		return () => {
			for (const fn of cleanupRef.current) fn();
			cleanupRef.current = [];
		};
	}, []);

	return { stream, isCapturing, hasMic, hasSystem, error, start, stop };
}

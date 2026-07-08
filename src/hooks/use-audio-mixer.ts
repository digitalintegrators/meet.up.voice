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
	/** Locally recorded mixed audio blob ready for download/export */
	recordedBlob: Blob | null;
	/** Helper to trigger download of the locally recorded audio */
	downloadAudio: (filename?: string) => void;
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
 * Optionally ducking a target GainNode when voice activity exceeds threshold.
 */
function attachLevelMeter(
	ctx: AudioContext,
	track: MediaStreamTrack,
	onLevel: (rms: number) => void,
	duckingTarget?: GainNode | null,
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
		const level = Math.min(rms * 5, 1); // amplify slightly and clamp
		onLevel(level);

		// ── Meetily RMS Ducking Algorithm ──────────────────────────────────
		// When microphone level exceeds speech threshold (> 0.08), attenuate
		// system audio gain smoothly to 35% so user voice remains intelligible.
		if (duckingTarget && ctx.state === "running") {
			if (level > 0.08) {
				duckingTarget.gain.setTargetAtTime(0.35, ctx.currentTime, 0.05);
			} else {
				duckingTarget.gain.setTargetAtTime(1.0, ctx.currentTime, 0.15);
			}
		}

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
 * audio-only), merges them into a single AudioContext destination with
 * professional RMS ducking, records locally via MediaRecorder, and
 * exposes the combined stream for ElevenLabs Scribe.
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
	const [recordedBlob, setRecordedBlob] = useState<Blob | null>(null);

	// Hold refs to cleanup callbacks and media recorder
	const cleanupRef = useRef<(() => void)[]>([]);
	const onLevelsRef = useRef(onLevels);
	const mediaRecorderRef = useRef<MediaRecorder | null>(null);
	const audioChunksRef = useRef<Blob[]>([]);

	useEffect(() => {
		onLevelsRef.current = onLevels;
	}, [onLevels]);

	const stop = useCallback(() => {
		for (const fn of cleanupRef.current) fn();
		cleanupRef.current = [];

		if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
			mediaRecorderRef.current.stop();
		}

		if (stream) {
			for (const t of stream.getTracks()) t.stop();
		}
		setStream(null);
		setIsCapturing(false);
		setHasMic(false);
		setHasSystem(false);
		setError(null);
	}, [stream]);

	const downloadAudio = useCallback((filename = "meeting-recording.webm") => {
		if (!recordedBlob) return;
		const url = URL.createObjectURL(recordedBlob);
		const a = document.createElement("a");
		a.href = url;
		a.download = filename;
		document.body.appendChild(a);
		a.click();
		document.body.removeChild(a);
		URL.revokeObjectURL(url);
	}, [recordedBlob]);

	const start = useCallback(async () => {
		setError(null);
		setRecordedBlob(null);
		audioChunksRef.current = [];

		try {
			const ctx = getAudioContext();
			if (ctx.state === "suspended") await ctx.resume();

			const dest = ctx.createMediaStreamDestination();
			const sysGainNode = ctx.createGain();
			sysGainNode.gain.value = 1.0;
			sysGainNode.connect(dest);

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

						// Level meter for mic with system audio ducking target
						const cleanup = attachLevelMeter(ctx, micTrack, (rms) => {
							onLevelsRef.current?.({ mic: rms, system: 0 });
						}, sysGainNode);
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
						// Connect system audio through ducking GainNode
						src.connect(sysGainNode);
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
					console.warn("System audio not captured:", e);
				}
			}

			if (!micTrack && !sysTrack) {
				throw new Error(
					"No audio sources could be captured. Please allow microphone access or select a window to share.",
				);
			}

			// ── Meetily Local MediaRecorder Setup ─────────────────────────────
			try {
				const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
					? "audio/webm;codecs=opus"
					: MediaRecorder.isTypeSupported("audio/mp4")
					? "audio/mp4"
					: "";
				const recorder = new MediaRecorder(
					dest.stream,
					mimeType ? { mimeType } : undefined,
				);
				recorder.ondataavailable = (e) => {
					if (e.data && e.data.size > 0) audioChunksRef.current.push(e.data);
				};
				recorder.onstop = () => {
					const finalType = recorder.mimeType || "audio/webm";
					const blob = new Blob(audioChunksRef.current, { type: finalType });
					setRecordedBlob(blob);
				};
				recorder.start(1000); // collect 1s chunks
				mediaRecorderRef.current = recorder;
			} catch (err) {
				console.warn("Local MediaRecorder init warning:", err);
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
			if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
				mediaRecorderRef.current.stop();
			}
		};
	}, []);

	return { stream, isCapturing, hasMic, hasSystem, error, recordedBlob, downloadAudio, start, stop };
}

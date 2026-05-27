"use client";

import { useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useCurrentUser } from "@/hooks/use-current-user";
import { useAudioMixer, type AudioLevel } from "@/hooks/use-audio-mixer";
import { useCustomScribe, type TranscriptSegment } from "@/hooks/use-custom-scribe";
import { Button } from "@/components/ui/button";
import { notify } from "@/lib/notify";
import {
	Mic,
	Volume2,
	Play,
	Square,
	Sparkles,
	Clock,
	AlertCircle,
	Captions,
	ChevronRight,
	HelpCircle,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";

export default function RecorderPage() {
	const { id: sessionId } = useParams<{ id: string }>();
	const router = useRouter();
	const { fingerprintId, clerkId, isLoading: identityLoading } = useCurrentUser();

	const [username, setUsername] = useState("Speaker");
	const [transcript, setTranscript] = useState<TranscriptSegment[]>([]);
	const [levels, setLevels] = useState<AudioLevel>({ mic: 0, system: 0 });
	const [duration, setDuration] = useState(0);
	const durationTimerRef = useRef<NodeJS.Timeout | null>(null);

	// Get browser window object safely
	const [appUrl, setAppUrl] = useState("");
	useEffect(() => {
		setAppUrl(window.location.origin);
	}, []);

	// Handle level updates
	const handleLevels = (newLevels: AudioLevel) => {
		setLevels(newLevels);
	};

	// 1. Audio Mixer Hook
	const mixer = useAudioMixer({
		source: "both",
		onLevels: handleLevels,
	});

	// 2. ElevenLabs Scribe Hook
	const scribe = useCustomScribe({
		stream: mixer.stream,
		username,
		onCommitted: async (segment) => {
			setTranscript((prev) => [...prev, segment]);
			// Persist segment to database
			try {
				await fetch(`/api/recorder/${sessionId}/transcript`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						username,
						content: segment.text,
						type: "transcript",
					}),
				});
			} catch (err) {
				console.error("Failed to save transcript segment:", err);
			}
		},
	});

	// Duration Timer
	useEffect(() => {
		if (scribe.isConnected) {
			durationTimerRef.current = setInterval(() => {
				setDuration((prev) => prev + 1);
			}, 1000);
		} else {
			if (durationTimerRef.current) {
				clearInterval(durationTimerRef.current);
				durationTimerRef.current = null;
			}
		}
		return () => {
			if (durationTimerRef.current) clearInterval(durationTimerRef.current);
		};
	}, [scribe.isConnected]);

	// Clean up on unmount
	useEffect(() => {
		return () => {
			mixer.stop();
			scribe.disconnect();
		};
	// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	const startRecording = async () => {
		try {
			await mixer.start();
		} catch (err) {
			notify("error", { title: "Audio Capture Failed", description: String(err) });
		}
	};

	// Auto-connect Scribe once mixer starts capturing successfully
	useEffect(() => {
		if (mixer.isCapturing && mixer.stream && !scribe.isConnected && !scribe.isConnecting) {
			scribe.connect().catch((err) => {
				notify("error", { title: "Transcription Failed", description: String(err) });
			});
		}
	}, [mixer.isCapturing, mixer.stream, scribe, scribe.isConnected, scribe.isConnecting]);

	const stopRecording = async () => {
		// Stop mixer first to cut off streams
		mixer.stop();
		// Disconnect from ElevenLabs Scribe
		scribe.disconnect();

		// Notify backend that session is complete
		try {
			await fetch(`/api/recorder/${sessionId}/transcript`, {
				method: "DELETE",
			});
			notify("success", { title: "Recording complete", description: "Generating AI Summary..." });
			// Redirect to summary view
			router.push(`/summary/voice_${sessionId}`);
		} catch (err) {
			console.error("Failed to end session:", err);
			notify("error", { title: "Error saving recording" });
		}
	};

	const formatDuration = (sec: number) => {
		const m = Math.floor(sec / 60);
		const s = sec % 60;
		return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
	};

	return (
		<main className="min-h-screen bg-zinc-950 text-zinc-100 flex flex-col md:flex-row">
			{/* Left Column: Controls & Instructions */}
			<section className="w-full md:w-[380px] p-6 border-b md:border-b-0 md:border-r border-zinc-800/60 flex flex-col justify-between shrink-0 bg-zinc-900/20">
				<div className="space-y-6">
					<div>
						<div className="flex items-center gap-2 mb-2">
							<span className="h-2 w-2 rounded-full bg-[#ffba8f] animate-pulse" />
							<h1 className="text-xl font-bold tracking-tight font-serif">Voice Recorder</h1>
						</div>
						<p className="text-xs text-zinc-400">
							Capture, transcribe, and summarize any web call (Google Meet, Teams, Zoom) in real-time.
						</p>
					</div>

					{/* Instruction Notice */}
					<div className="p-4 border border-zinc-800 rounded-lg bg-zinc-900/40 text-xs space-y-2">
						<div className="flex items-center gap-2 text-[#ffba8f] font-semibold">
							<AlertCircle className="h-4 w-4" />
							<span>Important Setup</span>
						</div>
						<p className="text-zinc-300 leading-relaxed">
							When prompted to share your screen:
						</p>
						<ol className="list-decimal list-inside space-y-1 text-zinc-400 pl-1">
							<li>Choose the **Chrome Tab** or **Window** running your call.</li>
							<li>Check the **&quot;Share audio&quot;** checkbox (bottom-left) to capture system sound.</li>
						</ol>
					</div>

					{/* Connection State */}
					<div className="space-y-3">
						<h2 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Device Status</h2>

						{/* Micro level bar */}
						<div className="space-y-1 bg-zinc-900/60 p-3 rounded-lg border border-zinc-800/40">
							<div className="flex items-center justify-between text-xs mb-1">
								<span className="flex items-center gap-1.5 text-zinc-300">
									<Mic className={`h-3.5 w-3.5 ${mixer.hasMic ? "text-[#ffba8f]" : "text-zinc-500"}`} />
									Microphone
								</span>
								<span className="text-[10px] text-zinc-500">
									{mixer.hasMic ? "Active" : "Ready"}
								</span>
							</div>
							<div className="h-1.5 w-full bg-zinc-800 rounded-full overflow-hidden">
								<motion.div
									className="h-full bg-[#ffba8f]"
									style={{ width: `${levels.mic * 100}%` }}
									transition={{ type: "spring", stiffness: 300, damping: 20 }}
								/>
							</div>
						</div>

						{/* System sound level bar */}
						<div className="space-y-1 bg-zinc-900/60 p-3 rounded-lg border border-zinc-800/40">
							<div className="flex items-center justify-between text-xs mb-1">
								<span className="flex items-center gap-1.5 text-zinc-300">
									<Volume2 className={`h-3.5 w-3.5 ${mixer.hasSystem ? "text-[#ffba8f]" : "text-zinc-500"}`} />
									System / Tab Audio
								</span>
								<span className="text-[10px] text-zinc-500">
									{mixer.hasSystem ? "Active" : "Unshared"}
								</span>
							</div>
							<div className="h-1.5 w-full bg-zinc-800 rounded-full overflow-hidden">
								<motion.div
									className="h-full bg-[#ffba8f]"
									style={{ width: `${levels.system * 100}%` }}
									transition={{ type: "spring", stiffness: 300, damping: 20 }}
								/>
							</div>
						</div>
					</div>
				</div>

				{/* Primary action controls */}
				<div className="mt-8 space-y-4">
					{scribe.isConnected && (
						<div className="flex items-center justify-between bg-zinc-900/80 p-3 rounded-lg border border-zinc-800/80 text-xs">
							<span className="flex items-center gap-2 text-zinc-300">
								<span className="h-2 w-2 rounded-full bg-red-500 animate-pulse" />
								Recording Live
							</span>
							<span className="font-mono text-zinc-400 flex items-center gap-1">
								<Clock className="h-3 w-3" />
								{formatDuration(duration)}
							</span>
						</div>
					)}

					<div className="flex gap-2">
						{!scribe.isConnected ? (
							<Button
								onClick={startRecording}
								disabled={scribe.isConnecting || mixer.isCapturing}
								className="w-full bg-[#ffba8f] text-zinc-950 hover:bg-[#ffa975] flex items-center justify-center gap-2 py-5 font-semibold text-sm"
							>
								<Play className="h-4 w-4 fill-current" />
								{scribe.isConnecting ? "Connecting Scribe..." : "Start Capture"}
							</Button>
						) : (
							<Button
								onClick={stopRecording}
								className="w-full bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/30 flex items-center justify-center gap-2 py-5 font-semibold text-sm"
							>
								<Square className="h-4 w-4 fill-current" />
								Stop & Summarize
							</Button>
						)}
					</div>
				</div>
			</section>

			{/* Right Column: Live Transcription timeline */}
			<section className="flex-1 flex flex-col h-[calc(100vh-140px)] md:h-screen">
				{/* Top bar */}
				<header className="px-6 py-4 border-b border-zinc-800/60 flex items-center justify-between shrink-0 bg-zinc-900/10">
					<div className="flex items-center gap-2">
						<Captions className="h-4 w-4 text-zinc-400" />
						<span className="text-xs font-semibold text-zinc-300">Live Transcription Feed</span>
					</div>
					{scribe.isConnected && (
						<span className="text-[10px] text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded-full border border-emerald-500/20 font-medium">
							Connected to Scribe
						</span>
					)}
				</header>

				{/* Scrolling Transcript Window */}
				<div className="flex-1 overflow-y-auto p-6 space-y-4 scrollbar-thin scrollbar-thumb-zinc-800">
					{transcript.length === 0 && !scribe.partialText && (
						<div className="h-full flex flex-col items-center justify-center text-center max-w-sm mx-auto space-y-3">
							<div className="h-10 w-10 rounded-full bg-zinc-900 border border-zinc-800 flex items-center justify-center">
								<Sparkles className="h-5 w-5 text-zinc-600" />
							</div>
							<p className="text-xs text-zinc-400">
								Click **Start Capture** to begin. The transcription will begin rolling here as soon as audio is received.
							</p>
						</div>
					)}

					{/* Completed segments */}
					{transcript.map((seg) => (
						<motion.div
							key={seg.id}
							initial={{ opacity: 0, y: 10 }}
							animate={{ opacity: 1, y: 0 }}
							className="space-y-1 max-w-[85%]"
						>
							<div className="flex items-center gap-2">
								<span className="text-[10px] text-[#ffba8f] font-semibold uppercase tracking-wider">
									Speaker
								</span>
								<span className="text-[9px] text-zinc-600">
									{new Date(seg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
								</span>
							</div>
							<div className="bg-zinc-900/40 border border-zinc-800/40 rounded-2xl rounded-tl-none px-4 py-3 text-sm text-zinc-300 leading-relaxed shadow-sm">
								{seg.text}
							</div>
						</motion.div>
					))}

					{/* Live partial segment */}
					<AnimatePresence>
						{scribe.partialText && (
							<motion.div
								initial={{ opacity: 0, y: 5 }}
								animate={{ opacity: 1, y: 0 }}
								exit={{ opacity: 0 }}
								className="space-y-1 max-w-[85%] border-l-2 border-[#ffba8f]/50 pl-3"
							>
								<div className="flex items-center gap-1.5">
									<span className="text-[10px] text-zinc-400 font-semibold uppercase tracking-wider">
										Speaking...
									</span>
								</div>
								<div className="text-sm text-zinc-400 leading-relaxed italic">
									{scribe.partialText}
								</div>
							</motion.div>
						)}
					</AnimatePresence>
				</div>
			</section>
		</main>
	);
}

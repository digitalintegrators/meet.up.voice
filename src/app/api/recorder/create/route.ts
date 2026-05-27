import { auth } from "@clerk/nextjs/server";
import { db } from "@/db";
import { rooms } from "@/db/schema";
import { hashSecret } from "@/lib/owner";
import { nanoid } from "nanoid";
import { type NextRequest, NextResponse } from "next/server";

/**
 * POST /api/recorder/create
 *
 * Creates a lightweight "voice-only" recording session in the database.
 * No Daily.co room is provisioned — the session ID is used only for
 * persisting the transcript and generating the AI summary.
 */
export async function POST(req: NextRequest) {
	const body = await req.json().catch(() => ({}));
	const fingerprintId: string | null = body.fingerprintId ?? null;

	const sessionId = nanoid(10);
	const ownerSecret = nanoid(32);
	const { userId: ownerClerkUserId } = await auth();

	await db.insert(rooms).values({
		// Use a prefixed ID so we can tell these apart in logs
		dailyRoomName: `voice_${sessionId}`,
		// No real meeting URL — just a placeholder
		dailyRoomUrl: `${process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"}/recorder/${sessionId}`,
		expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24h
		ownerSecretHash: hashSecret(ownerSecret),
		ownerClerkUserId: ownerClerkUserId ?? null,
		ownerFingerprintId: fingerprintId,
	});

	return NextResponse.json({ sessionId, ownerSecret });
}

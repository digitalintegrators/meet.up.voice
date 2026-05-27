import { db } from "@/db";
import { messages, rooms } from "@/db/schema";
import { nanoid } from "nanoid";
import { eq } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";

/**
 * POST /api/recorder/[id]/transcript
 * Body: { username: string; content: string; type: "transcript" }
 *
 * Persists a single transcript segment for the given voice session.
 */
export async function POST(
	req: NextRequest,
	{ params }: { params: Promise<{ id: string }> },
) {
	const { id } = await params;
	const body = await req.json().catch(() => ({}));
	const { username, content, type = "transcript" } = body;

	if (!content?.trim()) {
		return NextResponse.json({ error: "Content required" }, { status: 400 });
	}

	const room = await db.query.rooms.findFirst({
		where: eq(rooms.dailyRoomName, `voice_${id}`),
	});
	if (!room) {
		return NextResponse.json({ error: "Session not found" }, { status: 404 });
	}

	const msg = {
		id: nanoid(),
		roomId: room.id,
		username: username || "Me",
		content: content.trim(),
		type,
	};

	await db.insert(messages).values(msg);

	return NextResponse.json({ ok: true, id: msg.id });
}

/**
 * DELETE /api/recorder/[id]/transcript
 * Marks the room as ended (enables summary generation).
 */
export async function DELETE(
	_req: NextRequest,
	{ params }: { params: Promise<{ id: string }> },
) {
	const { id } = await params;

	const room = await db.query.rooms.findFirst({
		where: eq(rooms.dailyRoomName, `voice_${id}`),
	});
	if (!room) {
		return NextResponse.json({ error: "Session not found" }, { status: 404 });
	}

	await db
		.update(rooms)
		.set({ endedAt: new Date() })
		.where(eq(rooms.id, room.id));

	return NextResponse.json({ ok: true });
}

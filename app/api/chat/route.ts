// app/api/chat/route.ts
import { NextResponse } from "next/server";

// version mock, juste pour que le build passe
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const message = (body.message as string) || "";
  return NextResponse.json({
    answer: message ? `Tu as demandé: ${message}` : "Message vide",
    sources: [],
  });
}

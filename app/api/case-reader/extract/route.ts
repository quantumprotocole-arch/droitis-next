import { NextResponse } from "next/server";
import mammoth from "mammoth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "Content-Type, Authorization",
};

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

const MAX_FILE_BYTES = Number(process.env.MAX_FILE_BYTES ?? 10 * 1024 * 1024); // 10MB
const MAX_TEXT_CHARS = Number(process.env.MAX_EXTRACTED_TEXT_CHARS ?? 140_000);

function normalizeText(s: string) {
  return s
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function POST(req: Request) {
  try {
    const form = await req.formData();
    const file = form.get("file");

    if (!(file instanceof File)) {
      return NextResponse.json({ error: "Missing file" }, { status: 400, headers: CORS_HEADERS });
    }

    if (file.size > MAX_FILE_BYTES) {
      return NextResponse.json(
        { error: "File too large", max_bytes: MAX_FILE_BYTES, received_bytes: file.size },
        { status: 413, headers: CORS_HEADERS }
      );
    }

    const name = (file.name || "").toLowerCase();
    const mime = (file.type || "").toLowerCase();

    const isPdf = mime === "application/pdf" || name.endsWith(".pdf");
    const isDocx =
      mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
      name.endsWith(".docx");

    if (isPdf) {
      // MVP: PDF extraction côté navigateur uniquement
      return NextResponse.json(
        { error: "PDF: extraction côté navigateur uniquement (PDF texte requis)." },
        { status: 415, headers: CORS_HEADERS }
      );
    }

    if (!isDocx) {
      return NextResponse.json(
        { error: "Format non supporté. Utilise un fichier .pdf ou .docx." },
        { status: 415, headers: CORS_HEADERS }
      );
    }

    const arrayBuffer = await file.arrayBuffer();
    const buf = Buffer.from(arrayBuffer);

    const out = await mammoth.extractRawText({ buffer: buf });
    let text = normalizeText(out?.value ?? "");

    if (!text) {
      return NextResponse.json(
        { error: "No extractable text found in DOCX." },
        { status: 422, headers: CORS_HEADERS }
      );
    }

    if (text.length > MAX_TEXT_CHARS) {
      text = text.slice(0, MAX_TEXT_CHARS) + "\n\n[TRUNCATED]";
    }

    return NextResponse.json({ extracted_text: text }, { status: 200, headers: CORS_HEADERS });
  } catch (e: any) {
    return NextResponse.json(
      { error: "Extraction failed", details: String(e?.message ?? e) },
      { status: 500, headers: CORS_HEADERS }
    );
  }
}

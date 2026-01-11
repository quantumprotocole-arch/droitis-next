import { NextResponse } from "next/server";
import "@napi-rs/canvas";
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

async function parsePdfBuffer(buf: Buffer): Promise<string> {
  const mod: any = await import("pdf-parse");
  const pdfParseFn = mod?.default ?? mod;
  if (typeof pdfParseFn !== "function") throw new Error("pdf-parse export is not a function.");

  try {
    const out = await pdfParseFn(buf);
    return out?.text ?? "";
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    if (msg.includes("@napi-rs/canvas")) {
      throw new Error("PDF extraction requires @napi-rs/canvas on server. Install it and externalize it in next.config.");
    }
    throw e;
  }
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

    const arrayBuffer = await file.arrayBuffer();
    const buf = Buffer.from(arrayBuffer);

    const isPdf = mime === "application/pdf" || name.endsWith(".pdf");
    const isDocx =
      mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
      name.endsWith(".docx");

    let text = "";

   if (isPdf) {
  return NextResponse.json(
    { error: "PDF: extraction côté navigateur uniquement (upload un PDF texte ou copie-colle le texte)." },
    { status: 415, headers: CORS_HEADERS }
  );
}
    text = normalizeText(text);

    if (!text) {
      return NextResponse.json(
        {
          error:
            "No extractable text found. (PDF scanné/image-only?) — colle le texte ou utilise un PDF texte."
        },
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

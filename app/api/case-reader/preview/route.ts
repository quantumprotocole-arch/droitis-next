/* eslint-disable no-console */
import { NextResponse } from "next/server";
import { findBestCodificationMatch } from "@/lib/case-reader/codification";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const { OPENAI_API_KEY } = process.env;

const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "Content-Type, Authorization",
};

const MODEL = process.env.OPENAI_MODEL ?? "gpt-4o-mini";
const OPENAI_TIMEOUT_MS = Number(process.env.OPENAI_TIMEOUT_MS ?? 90_000);

const MAX_CASE_TEXT_CHARS = Number(process.env.MAX_CASE_TEXT_CHARS ?? 120_000);
const PREVIEW_MODEL_CHARS = Number(process.env.PREVIEW_MODEL_CHARS ?? 70_000);
const MAX_OUTPUT_TOKENS_PREVIEW = Number(process.env.MAX_OUTPUT_TOKENS_PREVIEW ?? 1200);

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

type InputBody = {
  case_text: string;
  output_mode: "fiche" | "analyse_longue";
  language?: "fr" | "en";
  institution_slug?: string;
  course_slug?: string;
  jurisdiction_hint?: string;
  court_hint?: string;
  decision_date_hint?: string;
  source_kind?: "pdf" | "docx";
  filename?: string;
};

function clampForModel(text: string, maxChars: number) {
  const t = String(text ?? "");
  if (t.length <= maxChars) return t;
  // head+tail pour garder contexte + conclusion
  const head = t.slice(0, Math.floor(maxChars * 0.65));
  const tail = t.slice(t.length - Math.floor(maxChars * 0.35));
  return `${head}\n\n[...TRUNCATED FOR PREVIEW...]\n\n${tail}`;
}

function extractOutputText(respJson: any): string | null {
  if (typeof respJson?.output_text === "string" && respJson.output_text.length > 0) return respJson.output_text;

  const out = respJson?.output;
  if (!Array.isArray(out)) return null;

  const msg = out.find((x: any) => x?.type === "message" && Array.isArray(x?.content));
  if (!msg) return null;

  const parts = msg.content.filter((p: any) => p?.type === "output_text" && typeof p?.text === "string");
  const text = parts.map((p: any) => p.text).join("");
  return text || null;
}

function buildSystemPrompt(codNote: string | null) {
  const base = [
    "TU ES DROITIS — MODE CASE READER (PHASE 4C).",
    "",
    "ÉTAPE 1/2 (PREVIEW): extraire les informations IMPORTANTES à confirmer par l’utilisateur.",
    "Objectif: donner un aperçu clair, UTILISABLE EN EXAMEN, sans inventer.",
    "",
    "RÈGLES NON NÉGOCIABLES:",
    "1) Ne rien inventer: tout doit être ANCRÉ dans le texte.",
    "2) Pas d’URL.",
    "3) Pas de longues citations: micro-extraits courts (<= 20 mots) uniquement.",
    "4) Si info critique manque, indique-le dans 'uncertainties' (pas plus).",
    "",
    "SORTIE: JSON uniquement (pas de texte hors JSON).",
    "Le JSON doit être sous la forme:",
    "{",
    "  type: 'preview',",
    "  output_mode: 'fiche'|'analyse_longue',",
    "  preview: {",
    "    scope_course_first: { course, what_it_changes, exam_spotting_box:{ trigger, do_this[], pitfalls[] }, codification_if_any? },",
    "    context_text: 'texte cohérent (pas un objet JSON)',",
    "    key_facts: [{ fact, why_it_matters, anchor_refs[] }],",
    "    issues: [{ issue, anchor_refs[] }],",
    "    rules_tests: [{ item, kind:'rule'|'test', anchor_refs[] }],",
    "    reasoning: [{ step, anchor_refs[] }],",
    "    uncertainties: [string],",
    "    anchors: [{ id, anchor_type, location, evidence_snippet, confidence }]",
    "  }",
    "}",
    "",
    "IMPORTANT: La section scope_course_first doit être la plus claire (cours + examen).",
  ].join("\n");

  return codNote ? `${base}\n\n${codNote}` : base;
}

async function callOpenAI(payload: any) {
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY manquant");

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);

  try {
    const res = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const json = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, json };
  } finally {
    clearTimeout(t);
  }
}

function payloadPreview(systemPrompt: string, body: InputBody) {
  const textForModel = clampForModel(body.case_text, PREVIEW_MODEL_CHARS);

  const userPayload = {
    case_text: textForModel,
    output_mode: body.output_mode,
    language: body.language ?? "fr",
    institution_slug: body.institution_slug,
    course_slug: body.course_slug,
    jurisdiction_hint: body.jurisdiction_hint,
    court_hint: body.court_hint,
    decision_date_hint: body.decision_date_hint,
    source_kind: body.source_kind,
    filename: body.filename,
    _meta: { original_chars: body.case_text.length, preview_chars: textForModel.length },
  };

  return {
    model: MODEL,
    store: false,
    temperature: 0,
    max_output_tokens: MAX_OUTPUT_TOKENS_PREVIEW,
    input: [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content:
          "Fais le PREVIEW (étape 1/2). Retourne uniquement le JSON décrit.\n\n" +
          JSON.stringify(userPayload),
      },
    ],
    // JSON mode, plus robuste que json_schema pour preview
    text: { format: { type: "json_object" } },
  };
}

export async function POST(req: Request) {
  try {
    if (!OPENAI_API_KEY) {
      return NextResponse.json({ error: "OPENAI_API_KEY manquant" }, { status: 500, headers: CORS_HEADERS });
    }

    const body = (await req.json().catch(() => null)) as InputBody | null;
    if (!body?.case_text || !body?.output_mode) {
      return NextResponse.json({ error: "Missing case_text or output_mode" }, { status: 400, headers: CORS_HEADERS });
    }

    if (body.source_kind !== "pdf" && body.source_kind !== "docx") {
      return NextResponse.json(
        { error: "Upload requis: PDF ou DOCX (source_kind='pdf'|'docx')." },
        { status: 400, headers: CORS_HEADERS }
      );
    }

    if (body.case_text.length > MAX_CASE_TEXT_CHARS) {
      return NextResponse.json(
        { error: "case_text trop long", max_chars: MAX_CASE_TEXT_CHARS, received_chars: body.case_text.length },
        { status: 413, headers: CORS_HEADERS }
      );
    }

    const codMatch = findBestCodificationMatch(body.case_text);
    let codNote: string | null = null;

    if (codMatch) {
      const r = codMatch.record;
      codNote =
        [
          "NOTE INTERNE (TABLE DE CODIFICATION — SOURCE AUTORISÉE):",
          `- Décision détectée: ${r.decision}${r.citation ? ` — ${r.citation}` : ""}`,
          `- Codifiée à: ${r.codification_articles || "[non précisé]"}`,
          "INSTRUCTION: mentionner la codification dans scope_course_first.codification_if_any (sans prétendre que ça vient du jugement).",
        ].join("\n");
    }

    const systemPrompt = buildSystemPrompt(codNote);
    const r = await callOpenAI(payloadPreview(systemPrompt, body));

    if (!r.ok) {
      return NextResponse.json(
        {
          error: "OpenAI responses error",
          status: r.status,
          openai_message: r.json?.error?.message ?? null,
          resp: r.json,
        },
        { status: 502, headers: CORS_HEADERS }
      );
    }

    const raw = extractOutputText(r.json);
    if (!raw) {
      return NextResponse.json({ error: "Empty output_text from OpenAI", resp: r.json }, { status: 502, headers: CORS_HEADERS });
    }

    const parsed = (() => {
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    })();

    if (!parsed) {
      return NextResponse.json({ error: "Preview not valid JSON", raw: raw.slice(0, 2000) }, { status: 502, headers: CORS_HEADERS });
    }

    return NextResponse.json(parsed, { status: 200, headers: CORS_HEADERS });
  } catch (e: any) {
    const msg = e?.name === "AbortError" ? "OpenAI timeout" : String(e?.message ?? e);
    return NextResponse.json({ error: "Unhandled error", details: msg }, { status: 500, headers: CORS_HEADERS });
  }
}

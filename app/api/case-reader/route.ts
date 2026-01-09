/* eslint-disable no-console */
import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import Ajv from "ajv";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const { OPENAI_API_KEY } = process.env;

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "Content-Type, Authorization",
};

// --- Config robustesse ---
const MODEL = process.env.OPENAI_MODEL ?? "gpt-4o-mini";
const OPENAI_TIMEOUT_MS = Number(process.env.OPENAI_TIMEOUT_MS ?? 60000);
const MAX_CASE_TEXT_CHARS = Number(process.env.MAX_CASE_TEXT_CHARS ?? 120_000);

// --- Schema chargé une fois (évite fs à chaque requête) ---
const schemaPath = path.join(process.cwd(), "schemas", "case-reader-v2.schema.json");
const schema = JSON.parse(fs.readFileSync(schemaPath, "utf-8"));

// --- Ajv validator (ceinture + bretelles) ---
const ajv = new Ajv({ allErrors: true, strict: false });
const validate = ajv.compile(schema);

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
};

function extractOutputText(respJson: any): string | null {
  // Certaines réponses exposent output_text; sinon on reconstruit depuis output[]
  if (typeof respJson?.output_text === "string" && respJson.output_text.length > 0) {
    return respJson.output_text;
  }

  const out = respJson?.output;
  if (!Array.isArray(out)) return null;

  const msg = out.find((x: any) => x?.type === "message" && Array.isArray(x?.content));
  if (!msg) return null;

  const parts = msg.content.filter(
    (p: any) => p?.type === "output_text" && typeof p?.text === "string"
  );
  const text = parts.map((p: any) => p.text).join("");
  return text || null;
}

function buildDeveloperPrompt() {
  return [
    "TU ES DROITIS — MODE CASE READER (PHASE 4C).",
    "",
    "RÈGLES NON NÉGOCIABLES:",
    "1) Tu n’inventes rien sur la décision. Tout doit être ancré dans le texte fourni.",
    "2) Aucune URL inventée (ex: CanLII). Si référence officielle absente: écrire 'Référence officielle non fournie'.",
    "3) Tu ne republies pas la décision. Citations verbatim = très courtes, uniquement pour ancrage.",
    "4) Si info critique absente: poser 1 à 3 questions max (clarification_questions).",
    "5) Tu dois fournir des anchors[]: location (para/page) + micro-extrait.",
    "",
    "SORTIE: JSON UNIQUEMENT, conforme au schéma. Aucun texte hors JSON."
  ].join("\n");
}

async function callOpenAIResponses(payload: any) {
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY manquant");

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);

  try {
    const res = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const json = await res.json().catch(() => null);

    if (!res.ok) {
      return { ok: false, status: res.status, json };
    }
    return { ok: true, status: res.status, json };
  } finally {
    clearTimeout(t);
  }
}

export async function POST(req: Request) {
  try {
    if (!OPENAI_API_KEY) {
      return NextResponse.json(
        { error: "OPENAI_API_KEY manquant" },
        { status: 500, headers: CORS_HEADERS }
      );
    }

    const body = (await req.json().catch(() => null)) as InputBody | null;
    if (!body?.case_text || !body?.output_mode) {
      return NextResponse.json(
        { error: "Missing case_text or output_mode" },
        { status: 400, headers: CORS_HEADERS }
      );
    }

    // limite input pour éviter crash / coûts
    if (body.case_text.length > MAX_CASE_TEXT_CHARS) {
      return NextResponse.json(
        {
          error: "case_text trop long",
          max_chars: MAX_CASE_TEXT_CHARS,
          received_chars: body.case_text.length
        },
        { status: 413, headers: CORS_HEADERS }
      );
    }

    const developer = buildDeveloperPrompt();
    const userPayload = {
      case_text: body.case_text,
      output_mode: body.output_mode,
      language: body.language ?? "fr",
      institution_slug: body.institution_slug,
      course_slug: body.course_slug,
      jurisdiction_hint: body.jurisdiction_hint,
      court_hint: body.court_hint,
      decision_date_hint: body.decision_date_hint
    };

    const payload = {
      model: MODEL,
      store: false,
      input: [
        { role: "developer", content: developer },
        {
          role: "user",
          content:
            "Lis le texte fourni et produis la sortie JSON conforme au schéma.\n\n" +
            JSON.stringify(userPayload)
        }
      ],
      text: {
        format: {
          type: "json_schema",
          name: "droitis_case_reader_v2",
          strict: true,
          schema
        }
      }
    };

    const r1 = await callOpenAIResponses(payload);
    if (!r1.ok) {
      return NextResponse.json(
        { error: "OpenAI responses error", status: r1.status, resp: r1.json },
        { status: 502, headers: CORS_HEADERS }
      );
    }

    const raw = extractOutputText(r1.json);
    if (!raw) {
      return NextResponse.json(
        { error: "Empty output_text from Responses API", resp: r1.json },
        { status: 502, headers: CORS_HEADERS }
      );
    }

    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return NextResponse.json(
        { error: "Model output was not valid JSON", raw },
        { status: 502, headers: CORS_HEADERS }
      );
    }

    // Ajv validation
    const ok = validate(parsed) as boolean;
    if (!ok) {
      return NextResponse.json(
        {
          error: "Schema validation failed",
          errors: validate.errors,
          parsed
        },
        { status: 502, headers: CORS_HEADERS }
      );
    }

    return NextResponse.json(parsed, { status: 200, headers: CORS_HEADERS });
  } catch (e: any) {
    const msg = e?.name === "AbortError" ? "OpenAI timeout" : String(e?.message ?? e);
    console.error(e);
    return NextResponse.json(
      { error: "Unhandled error", details: msg },
      { status: 500, headers: CORS_HEADERS }
    );
  }
}

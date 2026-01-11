/* eslint-disable no-console */
import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020";
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
const OPENAI_TIMEOUT_MS = Number(process.env.OPENAI_TIMEOUT_MS ?? 120_000);

const MAX_CASE_TEXT_CHARS = Number(process.env.MAX_CASE_TEXT_CHARS ?? 120_000);
const LONG_TEXT_THRESHOLD = Number(process.env.LONG_TEXT_THRESHOLD ?? 85_000);

const MAX_REPAIR_RAW_CHARS = Number(process.env.MAX_REPAIR_RAW_CHARS ?? 20_000);
const MAX_REPAIR_ERR_CHARS = Number(process.env.MAX_REPAIR_ERR_CHARS ?? 6_000);

const MAX_OUTPUT_TOKENS_FICHE = Number(process.env.MAX_OUTPUT_TOKENS_FICHE ?? 1800);
const MAX_OUTPUT_TOKENS_ANALYSE = Number(process.env.MAX_OUTPUT_TOKENS_ANALYSE ?? 2600);

// --- Schema canonical AJV + schema OpenAI subset ---
const schemaPath = path.join(process.cwd(), "schemas", "case-reader-v2.schema.json");
const canonicalSchema = JSON.parse(fs.readFileSync(schemaPath, "utf-8"));

function toOpenAISchema(node: any): any {
  if (Array.isArray(node)) return node.map(toOpenAISchema);
  if (!node || typeof node !== "object") return node;

  const bannedKeys = new Set([
    "$schema",
    "$id",
    "title",
    "description",
    "allOf",
    "oneOf",
    "anyOf",
    "if",
    "then",
    "else",
    "const",
    "default",
    "examples",
    "minLength",
    "maxLength",
    "pattern",
    "minItems",
    "maxItems",
  ]);

  const out: any = {};
  for (const [k, v] of Object.entries(node)) {
    if (bannedKeys.has(k)) continue;
    out[k] = toOpenAISchema(v);
  }

  if (out.type === "object" && out.properties && typeof out.properties === "object") {
    out.additionalProperties = false;

    // garder required existant (ne pas le recalculer)
    if (Array.isArray((node as any).required)) {
      const req = (node as any).required.filter((k: any) => typeof k === "string");
      const props = new Set(Object.keys(out.properties));
      out.required = req.filter((k: string) => props.has(k));
    }

    for (const [pk, pv] of Object.entries(out.properties)) {
      out.properties[pk] = toOpenAISchema(pv);
    }
  }

  if (out.type === "array" && out.items) {
    out.items = toOpenAISchema(out.items);
  }

  return out;
}

const openaiSchema = toOpenAISchema(canonicalSchema);

// --- Ajv validator ---
const ajv = new Ajv2020({ allErrors: true, strict: false });
const validate = ajv.compile(canonicalSchema);

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

  // Upload-only enforcement
  source_kind?: "pdf" | "docx";
  filename?: string;

  // champs legacy (si jamais encore envoyés par l'UI)
  confirmed_preview?: boolean;
  preview_payload?: any;
};

function clampText(s: string, maxChars: number) {
  const t = String(s ?? "");
  if (t.length <= maxChars) return t;
  return t.slice(0, maxChars) + "\n...[TRUNCATED]...";
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

function safeJsonParse(raw: string): any | null {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function buildDroitisSystemPrompt(): string {
  return [
    "TU ES DROITIS — MODE CASE READER (PHASE 4C).",
    "",
    "OBJECTIF: produire une fiche ou une analyse longue UTILISABLE EN EXAMEN.",
    "",
    "EXIGENCE DE DÉTAIL:",
    "- Chaque point doit être substantiel (éviter les puces d'une seule phrase).",
    "- Pour chaque point important: (1) sens, (2) pourquoi, (3) conséquence en examen.",
    "",
    "RÈGLES NON NÉGOCIABLES (ANTI-HALLUCINATION + IP):",
    "1) Ne rien inventer: tout doit être ANCRÉ dans le texte fourni.",
    "2) Aucune URL inventée. Si référence officielle absente: l’indiquer.",
    "3) Ne pas republier: citations verbatim COURTES, uniquement anchors.",
    "4) Si info critique manque: type='clarify' avec 1 à 3 questions max.",
    "5) Preuves d’ancrage obligatoires: para/page + micro-extrait.",
    "",
    "FORMAT OBLIGATOIRE (7 SECTIONS): conforme au schéma.",
    "IMPORTANT UI/DOCX: la section 6 doit être la plus claire (cours + examen) et sortir en premier dans l’affichage client.",
    "",
    "IMPORTANT (CODIFICATION): si une NOTE INTERNE indique codification (articles), le mentionner explicitement en section 6, sans prétendre que ça vient du texte.",
  ].join("\n");
}

const ANCHOR_ID_RE = /^[A-Z]{1,4}-\d{1,4}$/;

function sanitizeAnchorIds(obj: any) {
  if (!obj || typeof obj !== "object") return;
  if (!Array.isArray(obj.anchors)) return;

  let i = 1;
  for (const a of obj.anchors) {
    if (!a || typeof a !== "object") continue;
    const id = typeof a.id === "string" ? a.id : "";
    if (!ANCHOR_ID_RE.test(id)) a.id = `A-${i}`;
    i += 1;
  }
}

function redactUrls(s: string) {
  return s
    .replace(/https?:\/\/\S+/gi, "[LIEN SUPPRIMÉ]")
    .replace(/\bwww\.\S+/gi, "[LIEN SUPPRIMÉ]");
}

function sanitizeUrlsInOutput(out: any) {
  const stack: any[] = [out];
  while (stack.length) {
    const cur = stack.pop();
    if (!cur) continue;

    if (Array.isArray(cur)) {
      for (let i = 0; i < cur.length; i += 1) {
        const v = cur[i];
        if (typeof v === "string") {
          if (/https?:\/\/|www\./i.test(v)) cur[i] = redactUrls(v);
        } else if (v && typeof v === "object") {
          stack.push(v);
        }
      }
      continue;
    }

    if (typeof cur === "object") {
      for (const [k, v] of Object.entries(cur)) {
        if (typeof v === "string") {
          if (/https?:\/\/|www\./i.test(v)) (cur as any)[k] = redactUrls(v);
        } else if (Array.isArray(v) || (v && typeof v === "object")) {
          stack.push(v);
        }
      }
    }
  }
}

function applyAnswerGuards(parsed: any) {
  sanitizeAnchorIds(parsed);
  sanitizeUrlsInOutput(parsed);
}

function normalizeClarify(parsed: any) {
  const qs = Array.isArray(parsed?.clarification_questions)
    ? parsed.clarification_questions.slice(0, 3)
    : [];
  const safeQs = qs.length > 0 ? qs : ["Peux-tu fournir une version plus courte du document (ex: pages pertinentes) ?"];

  return {
    type: "clarify",
    output_mode: parsed?.output_mode === "analyse_longue" ? "analyse_longue" : "fiche",
    clarification_questions: safeQs,
  };
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

// PRIMARY: json_schema strict
function buildPrimaryPayload(systemPrompt: string, userPayload: any, maxOutputTokens: number) {
  return {
    model: MODEL,
    store: false,
    temperature: 0,
    max_output_tokens: maxOutputTokens,
    input: [
      { role: "system", content: systemPrompt },
      { role: "user", content: "Produis la sortie JSON conforme au schéma.\n\n" + JSON.stringify(userPayload) },
    ],
    text: {
      format: {
        type: "json_schema",
        name: "droitis_case_reader_v2",
        strict: true,
        schema: openaiSchema,
      },
    },
  };
}

// FALLBACK: json_object
function buildJsonObjectPayload(systemPrompt: string, prompt: string, maxOutputTokens: number) {
  return {
    model: MODEL,
    store: false,
    temperature: 0,
    max_output_tokens: maxOutputTokens,
    input: [
      { role: "system", content: systemPrompt },
      { role: "user", content: prompt },
    ],
    text: { format: { type: "json_object" } },
  };
}

function buildRepairPayload(systemPrompt: string, raw: string, errors: any) {
  const rawClamped = clampText(raw, MAX_REPAIR_RAW_CHARS);
  const errClamped = clampText(JSON.stringify(errors ?? null), MAX_REPAIR_ERR_CHARS);

  const prompt =
    "Répare ce JSON pour qu'il soit conforme au schéma.\n" +
    "Contraintes:\n" +
    "- UNIQUEMENT du JSON valide.\n" +
    "- Ne rien inventer.\n" +
    "- Si info critique manque: type='clarify' et 1-3 questions.\n" +
    "- Pas d'URL: remplace par '[LIEN SUPPRIMÉ]'.\n\n" +
    "JSON À RÉPARER:\n" +
    rawClamped +
    "\n\nERREURS:\n" +
    errClamped;

  return buildJsonObjectPayload(systemPrompt, prompt, 1200);
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

    // Upload-only
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

    // Garde-fou: très long => clarify (évite timeouts 502)
    if (body.case_text.length >= LONG_TEXT_THRESHOLD) {
      return NextResponse.json(
        {
          type: "clarify",
          output_mode: body.output_mode,
          clarification_questions: [
            "Le document est très long. Peux-tu téléverser une version réduite (pages où la Cour énonce le test + l’application + conclusion) ?",
          ],
        },
        { status: 200, headers: CORS_HEADERS }
      );
    }

    const codMatch = findBestCodificationMatch(body.case_text);
    const codificationLines: string[] = [];
    if (codMatch) {
      const r = codMatch.record;
      codificationLines.push(
        "NOTE INTERNE (TABLE DE CODIFICATION — SOURCE AUTORISÉE):",
        `- Décision détectée: ${r.decision}${r.citation ? ` — ${r.citation}` : ""}`,
        `- Codifiée à: ${r.codification_articles || "[non précisé]"}`,
        r.recommended_mention ? `- Mention recommandée: ${r.recommended_mention}` : "",
        "INSTRUCTION: mentionner la codification dans la section 6, sans prétendre que ça vient du texte."
      );
    }

    const systemPrompt = [buildDroitisSystemPrompt(), "", ...codificationLines]
      .filter((x) => typeof x === "string" && x.trim().length > 0)
      .join("\n");

    const userPayload: any = {
      case_text: body.case_text,
      output_mode: body.output_mode,
      language: body.language ?? "fr",
      institution_slug: body.institution_slug,
      course_slug: body.course_slug,
      jurisdiction_hint: body.jurisdiction_hint,
      court_hint: body.court_hint,
      decision_date_hint: body.decision_date_hint,
      source_kind: body.source_kind,
      filename: body.filename,
    };

    const maxOut = body.output_mode === "analyse_longue" ? MAX_OUTPUT_TOKENS_ANALYSE : MAX_OUTPUT_TOKENS_FICHE;

    // 1) Primary json_schema
    let r1 = await callOpenAIResponses(buildPrimaryPayload(systemPrompt, userPayload, maxOut));

    // 2) Fallback json_object
    if (!r1.ok) {
      const fallbackPrompt =
        "Retourne UNIQUEMENT du JSON valide conforme exactement au schéma attendu.\n" +
        "Ne rien inventer, anchors courts, pas d'URL.\n\n" +
        JSON.stringify(userPayload);

      r1 = await callOpenAIResponses(buildJsonObjectPayload(systemPrompt, fallbackPrompt, maxOut));
    }

    if (!r1.ok) {
      return NextResponse.json(
        { error: "OpenAI responses error", status: r1.status, openai_message: r1.json?.error?.message ?? null, resp: r1.json },
        { status: 502, headers: CORS_HEADERS }
      );
    }

    const raw1 = extractOutputText(r1.json);
    if (!raw1) {
      return NextResponse.json({ error: "Empty output_text from OpenAI", resp: r1.json }, { status: 502, headers: CORS_HEADERS });
    }

    let parsed = safeJsonParse(raw1);

    // parse fail => repair
    if (!parsed) {
      const r2 = await callOpenAIResponses(buildRepairPayload(systemPrompt, raw1, { parse: "failed" }));
      if (!r2.ok) {
        return NextResponse.json(
          { error: "OpenAI repair error", status: r2.status, openai_message: r2.json?.error?.message ?? null, resp: r2.json },
          { status: 502, headers: CORS_HEADERS }
        );
      }
      const raw2 = extractOutputText(r2.json);
      parsed = raw2 ? safeJsonParse(raw2) : null;

      if (!parsed) {
        return NextResponse.json({ error: "Repair output still not valid JSON" }, { status: 502, headers: CORS_HEADERS });
      }
    }

    if (parsed?.type === "clarify") {
      return NextResponse.json(normalizeClarify(parsed), { status: 200, headers: CORS_HEADERS });
    }

    applyAnswerGuards(parsed);

    let ok = validate(parsed) as boolean;
    if (ok) {
      return NextResponse.json(parsed, { status: 200, headers: CORS_HEADERS });
    }

    // schema fail => repair once
    const r3 = await callOpenAIResponses(buildRepairPayload(systemPrompt, JSON.stringify(parsed), validate.errors));
    if (!r3.ok) {
      return NextResponse.json(
        { error: "OpenAI repair error", status: r3.status, openai_message: r3.json?.error?.message ?? null, resp: r3.json, errors: validate.errors },
        { status: 502, headers: CORS_HEADERS }
      );
    }

    const raw3 = extractOutputText(r3.json);
    const parsed3 = raw3 ? safeJsonParse(raw3) : null;

    if (!parsed3) {
      return NextResponse.json({ error: "Repair output not valid JSON" }, { status: 502, headers: CORS_HEADERS });
    }

    if (parsed3?.type === "clarify") {
      return NextResponse.json(normalizeClarify(parsed3), { status: 200, headers: CORS_HEADERS });
    }

    applyAnswerGuards(parsed3);

    ok = validate(parsed3) as boolean;
    if (!ok) {
      return NextResponse.json(
        { error: "Schema validation failed (after repair)", errors: validate.errors, parsed: parsed3 },
        { status: 422, headers: CORS_HEADERS }
      );
    }

    return NextResponse.json(parsed3, { status: 200, headers: CORS_HEADERS });
  } catch (e: any) {
    const msg = e?.name === "AbortError" ? "OpenAI timeout" : String(e?.message ?? e);
    console.error(e);
    return NextResponse.json({ error: "Unhandled error", details: msg }, { status: 500, headers: CORS_HEADERS });
  }
}

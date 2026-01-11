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
const OPENAI_TIMEOUT_MS = Number(process.env.OPENAI_TIMEOUT_MS ?? 60000);
const MAX_CASE_TEXT_CHARS = Number(process.env.MAX_CASE_TEXT_CHARS ?? 120_000);

// Réparations: éviter les payloads trop gros
const MAX_REPAIR_RAW_CHARS = Number(process.env.MAX_REPAIR_RAW_CHARS ?? 25_000);
const MAX_REPAIR_ERR_CHARS = Number(process.env.MAX_REPAIR_ERR_CHARS ?? 8_000);

// Retries: charge + résilience
const MAX_OPENAI_ATTEMPTS = Number(process.env.MAX_OPENAI_ATTEMPTS ?? 3);
const BASE_BACKOFF_MS = Number(process.env.BASE_BACKOFF_MS ?? 350);

// --- Schema canonical AJV + OpenAI schema “compat” ---
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

    // Conserver required s’il existait (ne pas l’inventer)
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
  source_kind?: "pdf" | "docx";
  filename?: string;
};

function clampText(s: string, maxChars: number) {
  const t = String(s ?? "");
  if (t.length <= maxChars) return t;
  return t.slice(0, maxChars) + "\n...[TRUNCATED]...";
}

function safeJsonParse(raw: string): any | null {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function extractOutputText(respJson: any): string | null {
  if (typeof respJson?.output_text === "string" && respJson.output_text.length > 0) {
    return respJson.output_text;
  }
  const out = respJson?.output;
  if (!Array.isArray(out)) return null;
  const msg = out.find((x: any) => x?.type === "message" && Array.isArray(x?.content));
  if (!msg) return null;
  const parts = msg.content.filter((p: any) => p?.type === "output_text" && typeof p?.text === "string");
  const text = parts.map((p: any) => p.text).join("");
  return text || null;
}

function buildDroitisSystemPrompt(): string {
  const lines: string[] = [
    "TU ES DROITIS — MODE CASE READER (PHASE 4C).",
    "",
    "OBJECTIF: produire une fiche ou une analyse longue UTILISABLE EN EXAMEN.",
    "",
    "EXIGENCE DE DÉTAIL:",
    "- Chaque point (faits, issues, règles/tests, application, takeaways) doit être substantiel: éviter les puces d'une seule phrase.",
    "- Pour chaque point important, ajoute (1) ce que ça veut dire, (2) pourquoi ça compte, (3) conséquence pratique en examen (quand applicable).",
    "",
    "RÈGLES NON NÉGOCIABLES (ANTI-HALLUCINATION + IP):",
    "1) Tu n’inventes rien sur la décision: toute règle/test/application doit être ANCRÉE dans le texte fourni.",
    "2) Aucune URL inventée. Si la référence officielle n’est pas fournie, tu l’indiques.",
    "3) Tu ne republies pas la décision: pas de longues citations. Les citations verbatim doivent être COURTES et servent uniquement d’ancrage.",
    "4) Si info critique absente, tu poses 1 à 3 questions MAX.",
    "5) Tu dois fournir des PREUVES D’ANCRAGE: (para/page) + micro-extrait.",
    "",
    "FORMAT OBLIGATOIRE (7 SECTIONS) — MAIS ATTENTION À L'ORDRE D'AFFICHAGE:",
    "- La section 6 (Portée + En examen) doit sortir en premier dans l'UI et le DOCX.",
    "",
    "SORTIE:",
    "- JSON uniquement.",
    "- type = 'clarify' OU 'answer'.",
    "- Si 'clarify': 1 à 3 questions max.",
    "",
    "IMPORTANT (CODIFICATION):",
    "- Si le système te fournit une NOTE INTERNE indiquant qu'une décision est codifiée, tu dois le mentionner explicitement dans la section 6.",
    "- Ne prétends pas que cette codification vient du texte: c'est une info fournie par le système.",
  ];
  return lines.join("\n");
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
  const safeQs =
    qs.length > 0
      ? qs
      : ["Peux-tu fournir un extrait plus complet (idéalement avec numéros de paragraphes/pages) ?"];

  return {
    type: "clarify",
    output_mode: parsed?.output_mode === "analyse_longue" ? "analyse_longue" : "fiche",
    clarification_questions: safeQs,
  };
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function isRetryableStatus(status: number) {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

// Détecte les erreurs 400 typiques liées à Structured Outputs / schema / modèle
function isLikelyStructuredOutputs400(openaiJson: any): boolean {
  const msg = String(openaiJson?.error?.message ?? "").toLowerCase();
  return (
    msg.includes("json_schema") ||
    msg.includes("structured outputs") ||
    msg.includes("schema") ||
    msg.includes("not supported") ||
    msg.includes("unsupported") ||
    msg.includes("invalid schema")
  );
}

async function callOpenAIResponses(payload: any): Promise<{ ok: boolean; status: number; json: any }> {
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY manquant");

  let last: { ok: boolean; status: number; json: any } = { ok: false, status: 0, json: null };

  for (let attempt = 1; attempt <= MAX_OPENAI_ATTEMPTS; attempt += 1) {
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
      last = { ok: res.ok, status: res.status, json };

      if (res.ok) return last;

      // Retryable?
      if (isRetryableStatus(res.status) && attempt < MAX_OPENAI_ATTEMPTS) {
        const backoff = BASE_BACKOFF_MS * Math.pow(2, attempt - 1);
        await sleep(backoff);
        continue;
      }

      return last;
    } catch (e: any) {
      last = { ok: false, status: 0, json: { error: { message: String(e?.message ?? e) } } };
      if (attempt < MAX_OPENAI_ATTEMPTS) {
        const backoff = BASE_BACKOFF_MS * Math.pow(2, attempt - 1);
        await sleep(backoff);
        continue;
      }
      return last;
    } finally {
      clearTimeout(t);
    }
  }

  return last;
}

// 1) Structured outputs (json_schema)
function buildPrimaryPayloadJsonSchema(systemPrompt: string, userPayload: any) {
  return {
    model: MODEL,
    store: false,
    input: [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content:
          "Lis le texte fourni et produis la sortie JSON conforme au schéma.\n\n" +
          JSON.stringify(userPayload),
      },
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

// 2) JSON mode (json_object) — compatible plus large (valid JSON mais pas schema)
function buildPrimaryPayloadJsonObject(systemPrompt: string, userPayload: any) {
  return {
    model: MODEL,
    store: false,
    input: [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content:
          "Retourne UNIQUEMENT du JSON valide (aucun texte autour). Respecte la structure attendue.\n\n" +
          JSON.stringify(userPayload),
      },
    ],
    text: {
      format: { type: "json_object" },
    },
  };
}

// 3) Plain text (sans text.format)
function buildPrimaryPayloadPlain(systemPrompt: string, userPayload: any) {
  return {
    model: MODEL,
    store: false,
    input: [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content:
          "Retourne UNIQUEMENT du JSON valide (aucun texte autour). Respecte la structure attendue.\n\n" +
          JSON.stringify(userPayload),
      },
    ],
  };
}

// Repair: toujours en json_object (évite “invalid schema” et force JSON)
function buildRepairPayload(systemPrompt: string, raw: string, errors: any) {
  const rawClamped = clampText(raw, MAX_REPAIR_RAW_CHARS);
  const errClamped = clampText(JSON.stringify(errors ?? null), MAX_REPAIR_ERR_CHARS);

  return {
    model: MODEL,
    store: false,
    input: [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content:
          "Répare le JSON.\n" +
          "Contraintes:\n" +
          "- UNIQUEMENT du JSON valide (aucun texte autour).\n" +
          "- Ne rajoute aucune information non présente.\n" +
          "- Si info critique manque: type='clarify' et 1-3 questions.\n" +
          "- Ne mets jamais d'URL (http/https/www): remplace par '[LIEN SUPPRIMÉ]'.\n\n" +
          "JSON À RÉPARER:\n" +
          rawClamped +
          "\n\nERREURS / INDICES:\n" +
          errClamped,
      },
    ],
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
        { error: "Upload requis: fournissez un PDF ou DOCX (source_kind='pdf'|'docx')." },
        { status: 400, headers: CORS_HEADERS }
      );
    }

    if (body.case_text.length > MAX_CASE_TEXT_CHARS) {
      return NextResponse.json(
        { error: "case_text trop long", max_chars: MAX_CASE_TEXT_CHARS, received_chars: body.case_text.length },
        { status: 413, headers: CORS_HEADERS }
      );
    }

    // Codification injection (source autorisée interne)
    const codMatch = findBestCodificationMatch(body.case_text);
    const codificationLines: string[] = [];
    if (codMatch) {
      const r = codMatch.record;
      codificationLines.push(
        "NOTE INTERNE (SOURCE AUTORISÉE — TABLE DE CODIFICATION JURISPRUDENTIELLE):",
        `- Décision détectée: ${r.decision}${r.citation ? ` — ${r.citation}` : ""}`,
        `- Codifiée à: ${r.codification_articles || "[non précisé]"}`,
        r.recommended_mention ? `- Mention recommandée (Droitis): ${r.recommended_mention}` : "",
        r.principle ? `- Principe ciblé: ${r.principle}` : "",
        "",
        "INSTRUCTIONS SPÉCIALES:",
        "A) Mention obligatoire de la codification dans la section 6 (Portée + En examen), en citant les articles.",
        "B) Ne prétends pas que la codification provient du texte de la décision: c'est une info de table interne.",
        "C) Ajoute un piège en examen: oublier de mentionner la codification (certains enseignants le demandent)."
      );
    }

    const systemPrompt = [buildDroitisSystemPrompt(), "", ...codificationLines]
      .filter((x) => typeof x === "string" && x.trim().length > 0)
      .join("\n");

    const userPayload = {
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

    // --- Primary attempt ladder ---
    // A) json_schema (Structured Outputs)
    let r = await callOpenAIResponses(buildPrimaryPayloadJsonSchema(systemPrompt, userPayload));

    // Si 400 lié structured outputs/schema: fallback vers json_object
    if (!r.ok && r.status === 400 && isLikelyStructuredOutputs400(r.json)) {
      r = await callOpenAIResponses(buildPrimaryPayloadJsonObject(systemPrompt, userPayload));
    }

    // Si encore KO: fallback plain
    if (!r.ok && r.status === 400) {
      r = await callOpenAIResponses(buildPrimaryPayloadPlain(systemPrompt, userPayload));
    }

    if (!r.ok) {
      const status = Number.isFinite(r.status) && r.status >= 400 ? r.status : 502;
      return NextResponse.json(
        {
          error: "OpenAI responses error",
          status: r.status,
          // Retourner le message OpenAI pour diagnostiquer (sans inventer)
          openai_message: r.json?.error?.message ?? null,
          resp: r.json,
        },
        { status, headers: CORS_HEADERS }
      );
    }

    const raw = extractOutputText(r.json);
    if (!raw) {
      return NextResponse.json(
        { error: "Empty output_text from OpenAI", resp: r.json },
        { status: 502, headers: CORS_HEADERS }
      );
    }

    let parsed: any | null = safeJsonParse(raw);

    // Parse fail => repair (json_object)
    if (!parsed) {
      const rr = await callOpenAIResponses(buildRepairPayload(systemPrompt, raw, { parse: "failed" }));
      if (!rr.ok) {
        const status = Number.isFinite(rr.status) && rr.status >= 400 ? rr.status : 502;
        return NextResponse.json(
          {
            error: "OpenAI repair error",
            status: rr.status,
            openai_message: rr.json?.error?.message ?? null,
            resp: rr.json,
          },
          { status, headers: CORS_HEADERS }
        );
      }
      const raw2 = extractOutputText(rr.json);
      if (!raw2) {
        return NextResponse.json({ error: "Empty output_text from repair", resp: rr.json }, { status: 502, headers: CORS_HEADERS });
      }
      parsed = safeJsonParse(raw2);
      if (!parsed) {
        return NextResponse.json({ error: "Repair output still not valid JSON", raw: clampText(raw2, 2000) }, { status: 502, headers: CORS_HEADERS });
      }
    }

    // Clarify shortcut
    if (parsed?.type === "clarify") {
      return NextResponse.json(normalizeClarify(parsed), { status: 200, headers: CORS_HEADERS });
    }

    applyAnswerGuards(parsed);

    // AJV validate; si fail => repair (json_object)
    let ok = validate(parsed) as boolean;
    if (ok) {
      return NextResponse.json(parsed, { status: 200, headers: CORS_HEADERS });
    }

    const rr2 = await callOpenAIResponses(buildRepairPayload(systemPrompt, JSON.stringify(parsed), validate.errors));
    if (!rr2.ok) {
      const status = Number.isFinite(rr2.status) && rr2.status >= 400 ? rr2.status : 502;
      return NextResponse.json(
        {
          error: "OpenAI repair error",
          status: rr2.status,
          openai_message: rr2.json?.error?.message ?? null,
          resp: rr2.json,
          errors: validate.errors,
        },
        { status, headers: CORS_HEADERS }
      );
    }

    const raw3 = extractOutputText(rr2.json);
    if (!raw3) {
      return NextResponse.json({ error: "Empty output_text from schema repair", resp: rr2.json }, { status: 502, headers: CORS_HEADERS });
    }

    const parsed3 = safeJsonParse(raw3);
    if (!parsed3) {
      return NextResponse.json({ error: "Repair output not valid JSON", raw: clampText(raw3, 2000) }, { status: 502, headers: CORS_HEADERS });
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

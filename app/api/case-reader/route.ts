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

// Limites de “repair” pour éviter les 400 “request too large”
const MAX_REPAIR_RAW_CHARS = Number(process.env.MAX_REPAIR_RAW_CHARS ?? 25_000);
const MAX_REPAIR_ERR_CHARS = Number(process.env.MAX_REPAIR_ERR_CHARS ?? 8_000);

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

    // Conserver required si présent; sinon ne pas inventer
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
    "4) Si info critique absente, tu poses 1 à 3 questions MAX (mode clarifier).",
    "5) Tu dois fournir des PREUVES D’ANCRAGE: pour chaque règle/test/élément clé, indique où tu l’as trouvé (para/page) + micro-extrait.",
    "",
    "FORMAT OBLIGATOIRE (7 SECTIONS) — MAIS ATTENTION À L'ORDRE D'AFFICHAGE:",
    "- La section 6 (Portée + En examen) doit être la PLUS CLAIRE et doit sortir en premier dans l'UI et le DOCX (même si elle reste numérotée 6).",
    "",
    "SORTIE:",
    "- JSON uniquement, conforme au schema.",
    "- type = 'clarify' OU 'answer'.",
    "- Si 'clarify': 1 à 3 questions max.",
    "",
    "IMPORTANT (CODIFICATION):",
    "- Si le système te fournit une NOTE INTERNE indiquant qu'une décision est codifiée (article(s)), tu dois le mentionner explicitement dans la section 6 (Portée + En examen) et rappeler un piège associé.",
    "- Ne prétends pas que cette codification vient du texte de la décision si ce n'est pas ancré: traite-la comme une information fournie par le système.",
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

function safeJsonParse(raw: string): any | null {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function clampText(s: string, maxChars: number) {
  const t = String(s ?? "");
  if (t.length <= maxChars) return t;
  return t.slice(0, maxChars) + "\n...[TRUNCATED]...";
}

async function callOpenAIResponses(payload: any): Promise<{ ok: boolean; status: number; json: any }> {
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

// PRIMARY = on garde Structured Outputs (si ça passe)
function buildPrimaryPayloadStructured(systemPrompt: string, userPayload: any) {
  return {
    model: MODEL,
    store: false,
    temperature: 0,
    input: [
      { role: "developer", content: [{ type: "input_text", text: systemPrompt }] },
      {
        role: "user",
        content: [{ type: "input_text", text: "Lis le texte fourni et produis la sortie JSON conforme au schéma.\n\n" + JSON.stringify(userPayload) }],
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

// REPAIR = PAS de json_schema (évite 400 “invalid schema”), on valide ensuite avec AJV
function buildRepairPayloadPlain(systemPrompt: string, raw: string, errors: any) {
  const rawClamped = clampText(raw, MAX_REPAIR_RAW_CHARS);
  const errClamped = clampText(JSON.stringify(errors ?? null), MAX_REPAIR_ERR_CHARS);

  return {
    model: MODEL,
    store: false,
    temperature: 0,
    input: [
      { role: "developer", content: [{ type: "input_text", text: systemPrompt }] },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text:
              "Retourne UNIQUEMENT du JSON valide (aucun texte autour).\n" +
              "Objectif: rendre le JSON conforme au schéma attendu.\n" +
              "Contraintes:\n" +
              "- Ne rajoute aucune information non présente.\n" +
              "- Si info critique manque: type='clarify' et 1-3 questions.\n" +
              "- Ne mets jamais d'URL (http/https/www): remplace par '[LIEN SUPPRIMÉ]'.\n\n" +
              "JSON À RÉPARER:\n" +
              rawClamped +
              "\n\nERREURS / INDICES:\n" +
              errClamped,
          },
        ],
      },
    ],
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

    // Codification note (source autorisée interne)
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

    // 1) Primary structured
    const r1 = await callOpenAIResponses(buildPrimaryPayloadStructured(systemPrompt, userPayload));
    if (!r1.ok) {
      const status = Number.isFinite(r1.status) && r1.status >= 400 ? r1.status : 502;
      return NextResponse.json(
        { error: "OpenAI responses error", status: r1.status, resp: r1.json },
        { status, headers: CORS_HEADERS }
      );
    }

    const raw1 = extractOutputText(r1.json);
    if (!raw1) {
      return NextResponse.json(
        { error: "Empty output_text from Responses API", resp: r1.json },
        { status: 502, headers: CORS_HEADERS }
      );
    }

    // 2) Parse JSON
    let parsed: any | null = safeJsonParse(raw1);

    // 3) Repair if parse failed (PLAIN)
    if (!parsed) {
      const r2 = await callOpenAIResponses(buildRepairPayloadPlain(systemPrompt, raw1, { parse: "failed" }));
      if (!r2.ok) {
        const status = Number.isFinite(r2.status) && r2.status >= 400 ? r2.status : 502;
        return NextResponse.json(
          { error: "OpenAI repair error", status: r2.status, resp: r2.json },
          { status, headers: CORS_HEADERS }
        );
      }

      const raw2 = extractOutputText(r2.json);
      if (!raw2) {
        return NextResponse.json({ error: "Empty output_text from repair", resp: r2.json }, { status: 502, headers: CORS_HEADERS });
      }

      parsed = safeJsonParse(raw2);
      if (!parsed) {
        return NextResponse.json({ error: "Repair output still not valid JSON", raw: clampText(raw2, 2000) }, { status: 502, headers: CORS_HEADERS });
      }
    }

    // Clarify => sortie minimale
    if (parsed?.type === "clarify") {
      return NextResponse.json(normalizeClarify(parsed), { status: 200, headers: CORS_HEADERS });
    }

    // Guards
    applyAnswerGuards(parsed);

    // 4) AJV validate
    let ok = validate(parsed) as boolean;
    if (ok) {
      return NextResponse.json(parsed, { status: 200, headers: CORS_HEADERS });
    }

    // 5) Repair once if schema fails (PLAIN)
    const r3 = await callOpenAIResponses(buildRepairPayloadPlain(systemPrompt, JSON.stringify(parsed), validate.errors));
    if (!r3.ok) {
      const status = Number.isFinite(r3.status) && r3.status >= 400 ? r3.status : 502;
      return NextResponse.json(
        { error: "OpenAI repair error", status: r3.status, resp: r3.json, errors: validate.errors },
        { status, headers: CORS_HEADERS }
      );
    }

    const raw3 = extractOutputText(r3.json);
    if (!raw3) {
      return NextResponse.json({ error: "Empty output_text from schema repair", resp: r3.json }, { status: 502, headers: CORS_HEADERS });
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

/* eslint-disable no-console */
import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020";
import { buildCodificationPromptBlock, findCodificationMatch, injectCodificationNoticeIntoAnswer } from "@/lib/case-reader/codification";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const { OPENAI_API_KEY } = process.env;

const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "Content-Type, Authorization",
};

// --- Config robustesse ---
const MODEL = process.env.OPENAI_MODEL ?? "gpt-4o-mini";
const OPENAI_TIMEOUT_MS = Number(process.env.OPENAI_TIMEOUT_MS ?? 60000);
const MAX_CASE_TEXT_CHARS = Number(process.env.MAX_CASE_TEXT_CHARS ?? 120_000);

// --- Schema : canonical (pour Ajv) + schema OpenAI (subset compatible) ---
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
    out.required = Object.keys(out.properties);
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

// --- Ajv validator sur le schema COMPLET (canonical) ---
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

function buildDeveloperPrompt(extraBlock?: string) {
  return [
    "TU ES DROITIS — MODE CASE READER (PHASE 4C).",
    "",
    "OBJECTIF: produire une fiche ou une analyse longue UTILISABLE EN EXAMEN.",
    "",
    "RÈGLES NON NÉGOCIABLES:",
    "1) Tu n’inventes rien sur la décision. Tout doit être ancré dans le texte fourni.",
    "2) Aucune URL inventée (ex: CanLII). Si la référence officielle n’est pas fournie: écrire 'Référence officielle non fournie'.",
    "3) Tu ne republies pas la décision. Citations verbatim = très courtes et seulement pour anchors[].",
    "4) Si info critique absente: mets type='clarify' et pose 1 à 3 questions max.",
    "   - Remplis les champs inconnus avec 'UNKNOWN' plutôt que d’inventer.",
    "5) anchors[] obligatoires: location (para/page) + micro-extrait court + confidence.",
    "6) Ne mets jamais de liens cliquables (http/https/www). Si le texte source contient une URL, remplace-la par '[LIEN SUPPRIMÉ]'.",
    "",
    "EXIGENCE PÉDAGOGIQUE:",
    "- Définis brièvement les notions juridiques centrales (vulgarisé).",
    "- Hiérarchise (déterminant vs secondaire).",
    "- Si institution_slug/course_slug sont fournis, adapte la section 'Portée' + 'En examen...'.",
    "",
    "FORMAT (7 SECTIONS) via le JSON:",
    "IMPORTANT (UI/DOCX): les ÉLÉMENTS IMPORTANTS sont affichés en premier et proviennent de scope_for_course + takeaways ‘Définition — ...’.",
    "=> Soigne scope_for_course: what_it_changes doit être court, déterminant, orienté examen; exam_spotting_box doit être concret (trigger + do_this + pitfalls).",
    "1. Contexte",
    "2. Faits essentiels",
    "3. Question(s) en litige",
    "4. Règle/test",
    "5. Application / raisonnement",
    "6. Portée (cours) + En examen",
    "7. Takeaways",
    "",
    "CONTRAINTE takeaways:",
    "- Inclure au moins 2 lignes commençant par 'Définition — ...'.",
    "- Les définitions doivent être courtes, vulgarisées et exactes (pas de blabla).",
    "",
    "CONTRAINTE examen:",
    "- exam_spotting_box.do_this: 2–6 items (actions claires).",
    "- exam_spotting_box.pitfalls: 2–6 items (pièges concrets).",
    "",
    "SORTIE: JSON UNIQUEMENT, conforme au schéma. Aucun texte hors JSON.",
    "",
    ...(extraBlock && extraBlock.trim().length ? ["", extraBlock.trim()] : [])
  ].join("\n");
}

const ANCHOR_ID_RE = /^[A-Z]{1,4}-\d{1,4}$/;

function sanitizeAnchorIds(obj: any) {
  if (!obj || typeof obj !== "object") return;

  if (Array.isArray(obj.anchors)) {
    let i = 1;
    for (const a of obj.anchors) {
      if (!a || typeof a !== "object") continue;
      const id = typeof a.id === "string" ? a.id : "";
      if (!ANCHOR_ID_RE.test(id)) a.id = `A-${i}`;
      i += 1;
    }
  }
}

function normalizeClarify(parsed: any) {
  const qs = Array.isArray(parsed?.clarification_questions)
    ? parsed.clarification_questions.slice(0, 3)
    : [];
  const safeQs = qs.length > 0 ? qs : ["Peux-tu fournir un extrait de la décision (avec paragraphes) ?"];

  return {
    type: "clarify",
    output_mode: parsed?.output_mode === "analyse_longue" ? "analyse_longue" : "fiche",
    clarification_questions: safeQs,
  };
}

// ---------- URL redaction (NE PAS BLOQUER l’utilisateur) ----------
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

function anchorsContainUrl(out: any): { found: boolean; where?: string; sample?: string } {
  const anchors = Array.isArray(out?.anchors) ? out.anchors : [];
  for (const a of anchors) {
    const fields = ["evidence_snippet", "location"];
    for (const f of fields) {
      const v = typeof a?.[f] === "string" ? a[f] : "";
      if (/https?:\/\/|www\./i.test(v)) {
        return { found: true, where: `anchors[].${f}`, sample: v.slice(0, 160) };
      }
    }
  }
  return { found: false };
}

/**
 * Applique toutes les protections sur une réponse "answer"
 * - IDs anchors conformes au pattern
 * - redaction des URLs (partout)
 * - si URLs dans anchors -> redaction aussi (mais pas de 502)
 */
function applyAnswerGuards(parsed: any) {
  sanitizeAnchorIds(parsed);
  sanitizeUrlsInOutput(parsed);

  const anchorUrl = anchorsContainUrl(parsed);
  if (anchorUrl.found) {
    // On redige une seconde fois, au cas où.
    sanitizeUrlsInOutput(parsed);
  }
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
    if (!res.ok) return { ok: false, status: res.status, json };
    return { ok: true, status: res.status, json };
  } finally {
    clearTimeout(t);
  }
}

function buildPrimaryPayload(developer: string, userPayload: any) {
  return {
    model: MODEL,
    store: false,
    input: [
      { role: "developer", content: developer },
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

function buildRepairPayload(developer: string, raw: string, errors: any) {
  return {
    model: MODEL,
    store: false,
    input: [
      { role: "developer", content: developer },
      {
        role: "user",
        content:
          "Répare ce JSON pour qu'il soit conforme au schéma. " +
          "Ne rajoute aucune information non présente. " +
          "Si une info manque, utilise 'UNKNOWN' et/ou type='clarify' avec 1-3 questions. " +
          "Ne mets jamais d'URL (http/https/www) : remplace par '[LIEN SUPPRIMÉ]'.\n\n" +
          "JSON A RÉPARER:\n" +
          raw +
          "\n\nERREURS:\n" +
          JSON.stringify(errors),
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

export async function POST(req: Request) {
  try {
    if (!OPENAI_API_KEY) {
      return NextResponse.json({ error: "OPENAI_API_KEY manquant" }, { status: 500, headers: CORS_HEADERS });
    }

    const body = (await req.json().catch(() => null)) as InputBody | null;
    if (!body?.case_text || !body?.output_mode) {
      return NextResponse.json({ error: "Missing case_text or output_mode" }, { status: 400, headers: CORS_HEADERS });
    }

    if (body.case_text.length > MAX_CASE_TEXT_CHARS) {
      return NextResponse.json(
        { error: "case_text trop long", max_chars: MAX_CASE_TEXT_CHARS, received_chars: body.case_text.length },
        { status: 413, headers: CORS_HEADERS }
      );
    }

    const preCodif = findCodificationMatch({ caseText: body.case_text });
    const developer = buildDeveloperPrompt(preCodif ? buildCodificationPromptBlock(preCodif) : undefined);
    const userPayload = {
      case_text: body.case_text,
      output_mode: body.output_mode,
      language: body.language ?? "fr",
      institution_slug: body.institution_slug,
      course_slug: body.course_slug,
      jurisdiction_hint: body.jurisdiction_hint,
      court_hint: body.court_hint,
      decision_date_hint: body.decision_date_hint,
    };

    // -------- 1) Primary call --------
    const r1 = await callOpenAIResponses(buildPrimaryPayload(developer, userPayload));
    if (!r1.ok) {
      return NextResponse.json(
        { error: "OpenAI responses error", status: r1.status, resp: r1.json },
        { status: 502, headers: CORS_HEADERS }
      );
    }

    const raw1 = extractOutputText(r1.json);
    if (!raw1) {
      return NextResponse.json(
        { error: "Empty output_text from Responses API", resp: r1.json },
        { status: 502, headers: CORS_HEADERS }
      );
    }

    // -------- 2) Parse primary JSON --------
    let parsed: any;
    try {
      parsed = JSON.parse(raw1);
    } catch {
      // -------- 3) Repair if parse failed --------
      const r2 = await callOpenAIResponses(buildRepairPayload(developer, raw1, { parse: "failed" }));
      if (!r2.ok) {
        return NextResponse.json(
          { error: "OpenAI repair error", status: r2.status, resp: r2.json },
          { status: 502, headers: CORS_HEADERS }
        );
      }

      const raw2 = extractOutputText(r2.json);
      if (!raw2) {
        return NextResponse.json({ error: "Empty output_text from repair", resp: r2.json }, { status: 502, headers: CORS_HEADERS });
      }

      try {
        parsed = JSON.parse(raw2);
      } catch {
        return NextResponse.json({ error: "Repair output still not valid JSON", raw: raw2 }, { status: 502, headers: CORS_HEADERS });
      }
    }

    // Clarify => retour minimal (pas d’AJV strict sur anchors, etc.)
    if (parsed?.type === "clarify") {
      return NextResponse.json(normalizeClarify(parsed), { status: 200, headers: CORS_HEADERS });
    }

    // Answer guards (IDs + URL redaction)
    applyAnswerGuards(parsed);
    const postCodif = preCodif ?? findCodificationMatch({
      caseNameHint: parsed?.context?.case_name,
      citationHint: parsed?.context?.neutral_citation,
      caseText: body.case_text,
    });
    if (postCodif) injectCodificationNoticeIntoAnswer(parsed, postCodif);

    // -------- 4) Ajv validation --------
    let ok = validate(parsed) as boolean;
    if (ok) {
      return NextResponse.json(parsed, { status: 200, headers: CORS_HEADERS });
    }

    // -------- 5) Repair once if schema fails --------
    const r3 = await callOpenAIResponses(buildRepairPayload(developer, JSON.stringify(parsed), validate.errors));
    if (!r3.ok) {
      return NextResponse.json(
        { error: "OpenAI repair error", status: r3.status, resp: r3.json, errors: validate.errors },
        { status: 502, headers: CORS_HEADERS }
      );
    }

    const raw3 = extractOutputText(r3.json);
    if (!raw3) {
      return NextResponse.json({ error: "Empty output_text from repair", resp: r3.json }, { status: 502, headers: CORS_HEADERS });
    }

    let parsed3: any;
    try {
      parsed3 = JSON.parse(raw3);
    } catch {
      return NextResponse.json(
        { error: "Repair output not valid JSON", raw: raw3, errors: validate.errors },
        { status: 502, headers: CORS_HEADERS }
      );
    }

    if (parsed3?.type === "clarify") {
      return NextResponse.json(normalizeClarify(parsed3), { status: 200, headers: CORS_HEADERS });
    }

    applyAnswerGuards(parsed3);

    ok = validate(parsed3) as boolean;
    if (!ok) {
      return NextResponse.json(
        { error: "Schema validation failed (after repair)", errors: validate.errors, parsed: parsed3 },
        { status: 502, headers: CORS_HEADERS }
      );
    }

    return NextResponse.json(parsed3, { status: 200, headers: CORS_HEADERS });
  } catch (e: any) {
    const msg = e?.name === "AbortError" ? "OpenAI timeout" : String(e?.message ?? e);
    console.error(e);
    return NextResponse.json({ error: "Unhandled error", details: msg }, { status: 500, headers: CORS_HEADERS });
  }
}

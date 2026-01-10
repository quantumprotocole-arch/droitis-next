/* eslint-disable no-console */
import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020";

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

// --- Schema : canonical (pour Ajv) + schema OpenAI (subset compatible) ---
const schemaPath = path.join(process.cwd(), "schemas", "case-reader-v2.schema.json");
const canonicalSchema = JSON.parse(fs.readFileSync(schemaPath, "utf-8"));

function toOpenAISchema(node: any): any {
  if (Array.isArray(node)) return node.map(toOpenAISchema);
  if (!node || typeof node !== "object") return node;

  // Keywords souvent refusés par Structured Outputs
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
    // Constraints texte souvent non supportées
    "minLength",
    "maxLength",
    "pattern",
    // Limits arrays souvent non supportés
    "minItems",
    "maxItems",
  ]);

  const out: any = {};
  for (const [k, v] of Object.entries(node)) {
    if (bannedKeys.has(k)) continue;
    out[k] = toOpenAISchema(v);
  }

  // Object: additionalProperties false + required = toutes les props (OpenAI aime "tout required")
  if (out.type === "object" && out.properties && typeof out.properties === "object") {
    out.additionalProperties = false;
    out.required = Object.keys(out.properties);

    for (const [pk, pv] of Object.entries(out.properties)) {
      out.properties[pk] = toOpenAISchema(pv);
    }
  }

  // Array: sanitize items
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
    "2) Aucune URL inventée (ex: CanLII). Si la référence officielle n’est pas fournie: écrire 'Référence officielle non fournie'.",
    "3) Tu ne republies pas la décision. Citations verbatim = très courtes, uniquement pour ancrage.",
    "4) Si info critique absente: mets type='clarify' et pose 1 à 3 questions max.",
    "   - Remplis les champs inconnus avec 'UNKNOWN' plutôt que d’inventer.",
    "5) Tu dois fournir des anchors[]: location (para/page) + micro-extrait court.",
    "",
    "SORTIE: JSON UNIQUEMENT, conforme au schéma. Aucun texte hors JSON."
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
      if (!ANCHOR_ID_RE.test(id)) {
        a.id = `A-${i}`; // pattern OK
      }
      i += 1;
    }
  }
}

/**
 * En mode clarify, on renvoie un objet minimal conforme au schema canonical,
 * pour éviter que des champs optionnels invalides fassent échouer Ajv.
 */
function normalizeClarify(parsed: any) {
  const qs = Array.isArray(parsed?.clarification_questions)
    ? parsed.clarification_questions.slice(0, 3)
    : [];

  // fallback si le modèle n’en met pas (rare)
  const safeQs =
    qs.length > 0
      ? qs
      : ["Peux-tu fournir un extrait de la décision (avec paragraphes) ?"];

  return {
    type: "clarify",
    output_mode: parsed?.output_mode === "analyse_longue" ? "analyse_longue" : "fiche",
    clarification_questions: safeQs
  };
}

function containsForbiddenUrlLikeStrings(obj: any): { found: boolean; sample?: string } {
  const needles = ["http://", "https://", "www.", "canlii", ".com", ".net", ".org"];
  const stack: any[] = [obj];

  while (stack.length) {
    const cur = stack.pop();
    if (typeof cur === "string") {
      const s = cur.toLowerCase();
      if (needles.some((n) => s.includes(n))) return { found: true, sample: cur.slice(0, 160) };
    } else if (Array.isArray(cur)) {
      for (const v of cur) stack.push(v);
    } else if (cur && typeof cur === "object") {
      for (const v of Object.values(cur)) stack.push(v);
    }
  }
  return { found: false };
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
          JSON.stringify(userPayload)
      }
    ],
    text: {
      format: {
        type: "json_schema",
        name: "droitis_case_reader_v2",
        strict: true,
        schema: openaiSchema
      }
    }
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
          "Si une info manque, utilise 'UNKNOWN' et/ou type='clarify' avec 1-3 questions.\n\n" +
          "JSON A RÉPARER:\n" +
          raw +
          "\n\nERREURS:\n" +
          JSON.stringify(errors)
      }
    ],
    text: {
      format: {
        type: "json_schema",
        name: "droitis_case_reader_v2",
        strict: true,
        schema: openaiSchema
      }
    }
  };
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

    // 1) Primary call
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

    // Parse
    let parsed: any;
    try {
      parsed = JSON.parse(raw1);
    } catch {
      // 2) Repair retry (parse fail)
      const r2 = await callOpenAIResponses(buildRepairPayload(developer, raw1, { parse: "failed" }));
      if (!r2.ok) {
        return NextResponse.json(
          { error: "OpenAI repair error", status: r2.status, resp: r2.json },
          { status: 502, headers: CORS_HEADERS }
        );
      }
          // Si le modèle répond "clarify", on renvoie une version MINIMALE
    // (sinon Ajv peut échouer sur des champs optionnels contraints, ex anchors.id)
    if (parsed?.type === "clarify") {
      const minimal = normalizeClarify(parsed);
      return NextResponse.json(minimal, { status: 200, headers: CORS_HEADERS });
    }

    // Sinon (answer), on assainit les anchor IDs pour éviter un échec pattern Ajv
    sanitizeAnchorIds(parsed);

      const raw2 = extractOutputText(r2.json);
      if (!raw2) {
        return NextResponse.json(
          { error: "Empty output_text from repair", resp: r2.json },
          { status: 502, headers: CORS_HEADERS }
        );
      }
      try {
        parsed = JSON.parse(raw2);
      } catch {
        return NextResponse.json(
          { error: "Repair output still not valid JSON", raw: raw2 },
          { status: 502, headers: CORS_HEADERS }
        );
      }
    }

    // Anti-URL server side
    const urlCheck = containsForbiddenUrlLikeStrings(parsed);
    if (urlCheck.found) {
      return NextResponse.json(
        { error: "Forbidden URL-like content detected", sample: urlCheck.sample },
        { status: 502, headers: CORS_HEADERS }
      );
    }

    // Ajv validation (canonical)
    let ok = validate(parsed) as boolean;
    if (!ok) {
      // 3) Repair retry (schema fail)
      const r2 = await callOpenAIResponses(
        buildRepairPayload(developer, JSON.stringify(parsed), validate.errors)
      );

      if (!r2.ok) {
        return NextResponse.json(
          { error: "OpenAI repair error", status: r2.status, resp: r2.json, errors: validate.errors },
          { status: 502, headers: CORS_HEADERS }
        );
      }

      const raw2 = extractOutputText(r2.json);
      if (!raw2) {
        return NextResponse.json(
          { error: "Empty output_text from repair", resp: r2.json },
          { status: 502, headers: CORS_HEADERS }
        );
      }

      let parsed2: any;
      try {
        parsed2 = JSON.parse(raw2);
      } catch {
        return NextResponse.json(
          { error: "Repair output not valid JSON", raw: raw2, errors: validate.errors },
          { status: 502, headers: CORS_HEADERS }
        );
      }

      const urlCheck2 = containsForbiddenUrlLikeStrings(parsed2);
      if (urlCheck2.found) {
        return NextResponse.json(
          { error: "Forbidden URL-like content detected (repair)", sample: urlCheck2.sample },
          { status: 502, headers: CORS_HEADERS }
        );
      }

      ok = validate(parsed2) as boolean;
      if (!ok) {
        return NextResponse.json(
          { error: "Schema validation failed (after repair)", errors: validate.errors, parsed: parsed2 },
          { status: 502, headers: CORS_HEADERS }
        );
      }

      return NextResponse.json(parsed2, { status: 200, headers: CORS_HEADERS });
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

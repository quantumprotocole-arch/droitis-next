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

// ✅ Central: 60s est trop court sur gros docs + schema strict
const OPENAI_TIMEOUT_MS = Number(process.env.OPENAI_TIMEOUT_MS ?? 180_000);

// Limites d’entrée
const MAX_CASE_TEXT_CHARS = Number(process.env.MAX_CASE_TEXT_CHARS ?? 120_000);

// Garde-fous longueur (pipeline 2 passes)
const SOFT_COMPRESS_THRESHOLD = Number(process.env.SOFT_COMPRESS_THRESHOLD ?? 45_000); // au-delà => condensation
const HARD_BLOCK_THRESHOLD = Number(process.env.HARD_BLOCK_THRESHOLD ?? 110_000); // au-delà => clarify

// Limites “repair/condense” (éviter payload trop gros)
const MAX_REPAIR_RAW_CHARS = Number(process.env.MAX_REPAIR_RAW_CHARS ?? 20_000);
const MAX_REPAIR_ERR_CHARS = Number(process.env.MAX_REPAIR_ERR_CHARS ?? 6_000);

// Tokens de sortie (évite runaway / incomplete)
const MAX_OUTPUT_TOKENS_FICHE = Number(process.env.MAX_OUTPUT_TOKENS_FICHE ?? 1800);
const MAX_OUTPUT_TOKENS_ANALYSE = Number(process.env.MAX_OUTPUT_TOKENS_ANALYSE ?? 2600);
const MAX_OUTPUT_TOKENS_CONDENSE = Number(process.env.MAX_OUTPUT_TOKENS_CONDENSE ?? 1400);

const MAX_OPENAI_ATTEMPTS = Number(process.env.MAX_OPENAI_ATTEMPTS ?? 3);
const BASE_BACKOFF_MS = Number(process.env.BASE_BACKOFF_MS ?? 400);

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
    "3) Ne pas republier: extraits verbatim COURTS, uniquement pour anchors.",
    "4) Si info critique manque: type='clarify' et 1 à 3 questions max.",
    "5) Preuves d’ancrage obligatoires: para/page + micro-extrait.",
    "",
    "FORMAT (7 sections) + ordre UI/DOCX:",
    "- La section 6 (Portée + En examen) doit être la plus claire et sortir en premier.",
    "",
    "IMPORTANT (CODIFICATION):",
    "- Si une NOTE INTERNE indique codification (articles), le mentionner en section 6.",
    "- Ne pas prétendre que ça vient du jugement si ce n'est pas ancré.",
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
  const safeQs =
    qs.length > 0
      ? qs
      : [
          "Ton document est long. Quelles pages/paragraphes sont les plus pertinents (ex: partie 'Règle/Test' + 'Application') ?",
        ];

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

function isIncomplete(respJson: any): boolean {
  return String(respJson?.status ?? "").toLowerCase() === "incomplete";
}

async function callOpenAIResponses(payload: any): Promise<{ ok: boolean; status: number; json: any }> {
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY manquant");

  let last = { ok: false, status: 0, json: null as any };

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

      // Si OpenAI répond "incomplete", on traite comme échec contrôlé (=> fallback / clarify)
      if (res.ok && isIncomplete(json)) {
        return { ok: false, status: 502, json: { error: { message: "OpenAI response incomplete", type: "incomplete" }, raw: json } };
      }

      if (res.ok) return last;

      if (isRetryableStatus(res.status) && attempt < MAX_OPENAI_ATTEMPTS) {
        const backoff = BASE_BACKOFF_MS * Math.pow(2, attempt - 1);
        await sleep(backoff);
        continue;
      }

      return last;
    } catch (e: any) {
      const msg = e?.name === "AbortError" ? "AbortError: timeout" : String(e?.message ?? e);
      last = { ok: false, status: 0, json: { error: { message: msg, type: e?.name ?? "fetch_error" } } };
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

// -------- Payload builders --------

// Pass final: schema strict (si possible)
function payloadFinalJsonSchema(systemPrompt: string, userPayload: any, maxOutputTokens: number) {
  return {
    model: MODEL,
    store: false,
    temperature: 0,
    max_output_tokens: maxOutputTokens,
    input: [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: "Lis le texte fourni et produis la sortie JSON conforme au schéma.\n\n" + JSON.stringify(userPayload),
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

// Fallback: JSON mode (moins fragile que json_schema)
function payloadJsonObject(systemPrompt: string, userText: string, maxOutputTokens: number) {
  return {
    model: MODEL,
    store: false,
    temperature: 0,
    max_output_tokens: maxOutputTokens,
    input: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userText },
    ],
    text: { format: { type: "json_object" } },
  };
}

// Pass 1: condensation ancrée (réduit taille + latence)
function payloadCondense(systemPrompt: string, caseText: string) {
  const prompt =
    "Tu vas condenser un texte de décision LONG en un 'condensé ancré' pour une seconde passe.\n" +
    "Règles:\n" +
    "- Ne rien inventer.\n" +
    "- Ne pas republier: chaque extrait verbatim doit être très court (<= 20 mots).\n" +
    "- Pour chaque élément clé, donne une référence (para/page si présent dans le texte) et un micro-extrait.\n" +
    "- Pas d'URL.\n\n" +
    "Retourne UNIQUEMENT un JSON avec:\n" +
    "{\n" +
    '  "condensed_text": "un texte structuré (sections courtes) incluant refs (para/page) + micro-extraits",\n' +
    '  "notes": ["ex: limites / info manquante"]\n' +
    "}\n\n" +
    "TEXTE:\n" +
    caseText;

  return payloadJsonObject(systemPrompt, prompt, MAX_OUTPUT_TOKENS_CONDENSE);
}

// Repair JSON (quand parse ou AJV échoue)
function payloadRepair(systemPrompt: string, raw: string, errors: any) {
  const rawClamped = clampText(raw, MAX_REPAIR_RAW_CHARS);
  const errClamped = clampText(JSON.stringify(errors ?? null), MAX_REPAIR_ERR_CHARS);

  const prompt =
    "Répare ce JSON.\n" +
    "Contraintes:\n" +
    "- UNIQUEMENT du JSON valide.\n" +
    "- Ne rajoute aucune information non présente.\n" +
    "- Si info critique manque: type='clarify' et 1-3 questions.\n" +
    "- Aucune URL: remplace par '[LIEN SUPPRIMÉ]'.\n\n" +
    "JSON À RÉPARER:\n" +
    rawClamped +
    "\n\nERREURS / INDICES:\n" +
    errClamped;

  return payloadJsonObject(systemPrompt, prompt, 1200);
}

function openaiErrorShape(r: { ok: boolean; status: number; json: any }, stage: string) {
  return {
    error: "OpenAI responses error",
    attempt_stage: stage,
    status: r.status,
    openai_message: r.json?.error?.message ?? null,
    openai_type: r.json?.error?.type ?? null,
    openai_code: r.json?.error?.code ?? null,
    resp: r.json,
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

    // Upload-only (comme tu le veux)
    if (body.source_kind !== "pdf" && body.source_kind !== "docx") {
      return NextResponse.json(
        { error: "Upload requis: fournissez un PDF ou DOCX (source_kind='pdf'|'docx')." },
        { status: 400, headers: CORS_HEADERS }
      );
    }

    if (body.case_text.length > MAX_CASE_TEXT_CHARS) {
      return NextResponse.json(
        {
          type: "clarify",
          output_mode: body.output_mode,
          clarification_questions: [
            "Le document est trop long pour une analyse fiable en une passe. Quelles pages/paragraphes dois-je analyser (ex: passage 'Règle/Test' + 'Application') ?",
          ],
        },
        { status: 200, headers: CORS_HEADERS }
      );
    }

    // Hard-block clarify avant OpenAI si proche du maximum (évite timeouts)
    if (body.case_text.length >= HARD_BLOCK_THRESHOLD) {
      return NextResponse.json(
        {
          type: "clarify",
          output_mode: body.output_mode,
          clarification_questions: [
            "Ton document est très long. Indique les pages/paragraphes à cibler (ex: 10–20 paras où la Cour énonce le test + l’application).",
            "Veux-tu une fiche (plus court) ou une analyse longue (plus lente) ?",
          ],
        },
        { status: 200, headers: CORS_HEADERS }
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
        "B) Ne prétends pas que la codification provient du texte: c'est une info de table interne.",
        "C) Ajoute un piège: oublier de mentionner la codification (certains enseignants le demandent)."
      );
    }

    const systemPrompt = [buildDroitisSystemPrompt(), "", ...codificationLines]
      .filter((x) => typeof x === "string" && x.trim().length > 0)
      .join("\n");

    // ---- PASS 1: condensation si texte long (Central #1/#2) ----
    let effectiveCaseText = body.case_text;
    let usedCondense = false;

    if (effectiveCaseText.length >= SOFT_COMPRESS_THRESHOLD) {
      const rCond = await callOpenAIResponses(payloadCondense(systemPrompt, effectiveCaseText));
      if (!rCond.ok) {
        const status = Number.isFinite(rCond.status) && rCond.status >= 400 ? rCond.status : 502;
        return NextResponse.json(openaiErrorShape(rCond, "condense"), { status, headers: CORS_HEADERS });
      }

      const rawCond = extractOutputText(rCond.json);
      const parsedCond = rawCond ? safeJsonParse(rawCond) : null;

      const condensedText = typeof parsedCond?.condensed_text === "string" ? parsedCond.condensed_text : "";
      if (!condensedText.trim()) {
        // Si condensation échoue: on ne “force” pas, on clarifie
        return NextResponse.json(
          {
            type: "clarify",
            output_mode: body.output_mode,
            clarification_questions: [
              "Le document est long et la condensation a échoué. Peux-tu indiquer les pages/paragraphes à cibler (règle/test + application) ?",
            ],
          },
          { status: 200, headers: CORS_HEADERS }
        );
      }

      effectiveCaseText = condensedText;
      usedCondense = true;
    }

    const userPayload = {
      case_text: effectiveCaseText,
      output_mode: body.output_mode,
      language: body.language ?? "fr",
      institution_slug: body.institution_slug,
      course_slug: body.course_slug,
      jurisdiction_hint: body.jurisdiction_hint,
      court_hint: body.court_hint,
      decision_date_hint: body.decision_date_hint,
      source_kind: body.source_kind,
      filename: body.filename,
      // Info utile côté client
      _meta: { used_condense: usedCondense, original_chars: body.case_text.length, effective_chars: effectiveCaseText.length },
    };

    const maxOut = body.output_mode === "analyse_longue" ? MAX_OUTPUT_TOKENS_ANALYSE : MAX_OUTPUT_TOKENS_FICHE;

    // ---- PASS 2: génération finale ----
    // A) Essai schema strict
    let r1 = await callOpenAIResponses(payloadFinalJsonSchema(systemPrompt, userPayload, maxOut));
    if (!r1.ok) {
      // B) fallback json_object (moins fragile)
      const fallbackPrompt =
        "Retourne UNIQUEMENT du JSON valide conforme au schéma attendu (mêmes champs) à partir des données fournies.\n" +
        "Rappels: ne rien inventer, anchors courts, pas d'URL.\n\n" +
        JSON.stringify(userPayload);

      r1 = await callOpenAIResponses(payloadJsonObject(systemPrompt, fallbackPrompt, maxOut));
    }

    if (!r1.ok) {
      const status = Number.isFinite(r1.status) && r1.status >= 400 ? r1.status : 502;
      return NextResponse.json(openaiErrorShape(r1, "final"), { status, headers: CORS_HEADERS });
    }

    const raw1 = extractOutputText(r1.json);
    if (!raw1) {
      return NextResponse.json(
        { error: "Empty output_text from OpenAI", attempt_stage: "final", resp: r1.json },
        { status: 502, headers: CORS_HEADERS }
      );
    }

    // Parse
    let parsed = safeJsonParse(raw1);

    // Parse fail => repair
    if (!parsed) {
      const r2 = await callOpenAIResponses(payloadRepair(systemPrompt, raw1, { parse: "failed" }));
      if (!r2.ok) {
        const status = Number.isFinite(r2.status) && r2.status >= 400 ? r2.status : 502;
        return NextResponse.json(openaiErrorShape(r2, "repair_parse"), { status, headers: CORS_HEADERS });
      }
      const raw2 = extractOutputText(r2.json);
      parsed = raw2 ? safeJsonParse(raw2) : null;
      if (!parsed) {
        return NextResponse.json(
          { error: "Repair output still not valid JSON", attempt_stage: "repair_parse", raw: clampText(raw2 ?? "", 2000) },
          { status: 502, headers: CORS_HEADERS }
        );
      }
    }

    // Clarify passthrough
    if (parsed?.type === "clarify") {
      return NextResponse.json(normalizeClarify(parsed), { status: 200, headers: CORS_HEADERS });
    }

    applyAnswerGuards(parsed);

    // AJV validate
    let ok = validate(parsed) as boolean;
    if (ok) {
      return NextResponse.json(parsed, { status: 200, headers: CORS_HEADERS });
    }

    // AJV fail => repair
    const r3 = await callOpenAIResponses(payloadRepair(systemPrompt, JSON.stringify(parsed), validate.errors));
    if (!r3.ok) {
      const status = Number.isFinite(r3.status) && r3.status >= 400 ? r3.status : 502;
      return NextResponse.json(openaiErrorShape(r3, "repair_schema"), { status, headers: CORS_HEADERS });
    }

    const raw3 = extractOutputText(r3.json);
    const parsed3 = raw3 ? safeJsonParse(raw3) : null;

    if (!parsed3) {
      return NextResponse.json(
        { error: "Repair output not valid JSON", attempt_stage: "repair_schema", raw: clampText(raw3 ?? "", 2000) },
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
        { error: "Schema validation failed (after repair)", attempt_stage: "repair_schema", errors: validate.errors, parsed: parsed3 },
        { status: 422, headers: CORS_HEADERS }
      );
    }

    return NextResponse.json(parsed3, { status: 200, headers: CORS_HEADERS });
  } catch (e: any) {
    const msg = e?.name === "AbortError" ? "AbortError: timeout" : String(e?.message ?? e);
    console.error(e);
    return NextResponse.json({ error: "Unhandled error", details: msg }, { status: 500, headers: CORS_HEADERS });
  }
}

/* eslint-disable no-console */
import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020";
import { findBestCodificationMatch } from "@/lib/case-reader/codification";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ✅ IMPORTANT: augmente la durée autorisée côté Vercel (si ton plan le permet)
export const maxDuration = 60;

const { OPENAI_API_KEY } = process.env;

const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "Content-Type, Authorization",
};

const MODEL = process.env.OPENAI_MODEL ?? "gpt-4o-mini";

// ⚠️ On met un timeout OpenAI < maxDuration, pour éviter que Vercel tue la fonction avant nous.
const OPENAI_TIMEOUT_MS = Number(process.env.OPENAI_TIMEOUT_MS ?? 45_000);

// Taille max d’entrée acceptée (hard limit)
const MAX_CASE_TEXT_CHARS = Number(process.env.MAX_CASE_TEXT_CHARS ?? 140_000);

// Taille recommandée pour éviter timeouts (soft limit, on compresse au-delà)
const SOFT_TARGET_CHARS = Number(process.env.SOFT_TARGET_CHARS ?? 70_000);

// Réparations: garder petit
const MAX_REPAIR_RAW_CHARS = Number(process.env.MAX_REPAIR_RAW_CHARS ?? 18_000);
const MAX_REPAIR_ERR_CHARS = Number(process.env.MAX_REPAIR_ERR_CHARS ?? 6_000);

// Retries: moins d’essais = moins de risque de dépasser Vercel
const MAX_OPENAI_ATTEMPTS = Number(process.env.MAX_OPENAI_ATTEMPTS ?? 2);
const BASE_BACKOFF_MS = Number(process.env.BASE_BACKOFF_MS ?? 300);

// --- Schema AJV ---
const schemaPath = path.join(process.cwd(), "schemas", "case-reader-v2.schema.json");
let canonicalSchema: any = null;
try {
  canonicalSchema = JSON.parse(fs.readFileSync(schemaPath, "utf-8"));
} catch (e) {
  console.error("❌ Impossible de lire le schema:", schemaPath, e);
  // On ne throw pas ici: on renverra une erreur claire au runtime
}

const ajv = new Ajv2020({ allErrors: true, strict: false });
const validate = canonicalSchema ? ajv.compile(canonicalSchema) : null;

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

function json(data: any, status = 200) {
  return NextResponse.json(data, { status, headers: CORS_HEADERS });
}

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

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function isRetryableStatus(status: number) {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

// ✅ compression “intelligente”
// - garde le début (souvent: style, contexte, parties, question)
// - garde des lignes “paragraphe / para / [123] / 123.”
// - garde la fin (conclusion/dispositif)
function compressCaseText(raw: string, targetChars: number) {
  const text = String(raw ?? "");
  if (text.length <= targetChars) return { text, compressed: false, strategy: "none" as const };

  const head = text.slice(0, Math.floor(targetChars * 0.45));
  const tail = text.slice(Math.max(0, text.length - Math.floor(targetChars * 0.25)));

  const lines = text.split("\n");
  const keep: string[] = [];
  const re = /\b(para\.?|paragraphe|motifs|analyse|dispositif)\b|\[\d{1,5}\]|\b\d{1,4}\./i;

  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (re.test(ln)) keep.push(ln);
    if (keep.join("\n").length > Math.floor(targetChars * 0.30)) break;
  }

  const mid = keep.join("\n");
  const out =
    head.trim() +
    "\n\n[...EXTRAIT INTERMÉDIAIRE CIBLÉ (paragraphes/sections)...]\n" +
    mid.trim() +
    "\n\n[...FIN DE DÉCISION...]\n" +
    tail.trim();

  return { text: out.slice(0, targetChars), compressed: true, strategy: "head+mid(para)+tail" as const };
}

function buildDroitisSystemPrompt(): string {
  return [
    "TU ES DROITIS — MODE CASE READER (PHASE 4C).",
    "",
    "OBJECTIF: produire une fiche OU une analyse longue UTILISABLE EN EXAMEN.",
    "",
    "RÈGLES NON NÉGOCIABLES (ANTI-HALLUCINATION + IP):",
    "1) Tu n’inventes rien: toute règle/test/application doit être ancrée dans le texte fourni.",
    "2) Aucune URL inventée. Si référence officielle absente: l’indiquer.",
    "3) Tu ne republies pas la décision: pas de longues citations. Verbatim très court uniquement comme preuve d’ancrage.",
    "4) Si info critique absente: type='clarify' + 1 à 3 questions max.",
    "5) Tu dois fournir anchors[]: location (para/page/unknown) + micro-extrait + confidence.",
    "",
    "FORMAT OBLIGATOIRE (7 sections dans le JSON):",
    "1) Contexte (juridiction/tribunal/date)",
    "2) Faits essentiels",
    "3) Question(s) en litige",
    "4) Règle/test",
    "5) Application/raisonnement",
    "6) Portée (pour le cours X) + En examen (triggers/pitfalls)",
    "7) Takeaways",
    "",
    "SORTIE: JSON UNIQUEMENT.",
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
        } else if (v && typeof v === "object") stack.push(v);
      }
      continue;
    }

    if (typeof cur === "object") {
      for (const [k, v] of Object.entries(cur)) {
        if (typeof v === "string") {
          if (/https?:\/\/|www\./i.test(v)) (cur as any)[k] = redactUrls(v);
        } else if (Array.isArray(v) || (v && typeof v === "object")) stack.push(v);
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
      : ["Peux-tu fournir un extrait plus complet (idéalement avec paragraphes/pages), ou préciser le tribunal/date?"];

  return {
    type: "clarify",
    output_mode: parsed?.output_mode === "analyse_longue" ? "analyse_longue" : "fiche",
    clarification_questions: safeQs,
  };
}

// ✅ Appel OpenAI robuste: parse JSON ou texte brut, distingue AbortError
async function callOpenAIResponses(payload: any): Promise<{
  ok: boolean;
  status: number;
  json: any;
  rawText?: string;
  aborted?: boolean;
}> {
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY manquant");

  let last: any = { ok: false, status: 0, json: null, rawText: null, aborted: false };

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

      const rawText = await res.text().catch(() => "");
      const json = safeJsonParse(rawText);

      last = { ok: res.ok, status: res.status, json, rawText, aborted: false };

      if (res.ok) return last;

      if (isRetryableStatus(res.status) && attempt < MAX_OPENAI_ATTEMPTS) {
        const backoff = BASE_BACKOFF_MS * Math.pow(2, attempt - 1);
        await sleep(backoff);
        continue;
      }

      return last;
    } catch (e: any) {
      const isAbort = e?.name === "AbortError" || String(e?.message ?? "").toLowerCase().includes("aborted");
      last = {
        ok: false,
        status: 0,
        json: { error: { message: String(e?.message ?? e) } },
        rawText: null,
        aborted: isAbort,
      };

      // si abort: pas la peine de multiplier les retries, ça va juste dépasser Vercel
      if (isAbort) return last;

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

// ✅ payload primaire: json_object (plus stable/rapide)
function buildPrimaryPayloadJsonObject(systemPrompt: string, userPayload: any) {
  return {
    model: MODEL,
    store: false,
    input: [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content:
          "Retourne UNIQUEMENT du JSON valide (aucun texte autour). " +
          "Si info critique manque: type='clarify' + 1-3 questions.\n\n" +
          JSON.stringify(userPayload),
      },
    ],
    text: { format: { type: "json_object" } },
  };
}

// ✅ Repair: json_object + contraintes strictes
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
  const startedAt = Date.now();

  try {
    if (!OPENAI_API_KEY) return json({ error: "OPENAI_API_KEY manquant" }, 500);
    if (!canonicalSchema || !validate) return json({ error: "Schema introuvable côté serveur", schemaPath }, 500);

    const body = (await req.json().catch(() => null)) as InputBody | null;
    if (!body?.case_text || !body?.output_mode) {
      return json({ error: "Missing case_text or output_mode" }, 400);
    }

    // ⚠️ Tu veux PDF/DOCX only — OK, mais l’erreur 502 n’est pas là.
    if (body.source_kind !== "pdf" && body.source_kind !== "docx") {
      return json({ error: "Upload requis: fournissez un PDF ou DOCX (source_kind='pdf'|'docx')." }, 400);
    }

    if (body.case_text.length > MAX_CASE_TEXT_CHARS) {
      return json(
        {
          error: "case_text trop long (hard limit)",
          max_chars: MAX_CASE_TEXT_CHARS,
          received_chars: body.case_text.length,
        },
        413
      );
    }

    // ✅ soft-compress pour réduire timeouts / latence
    const comp = compressCaseText(body.case_text, SOFT_TARGET_CHARS);

    // Codification injection (source autorisée interne)
    const codMatch = findBestCodificationMatch(comp.text);
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
        "A) Mention obligatoire de la codification dans la section 6 (Portée + En examen).",
        "B) Ne prétends pas que la codification provient du texte: c'est une info système.",
        "C) Ajoute un piège en examen: oublier de mentionner la codification."
      );
    }

    const systemPrompt = [buildDroitisSystemPrompt(), "", ...codificationLines].filter(Boolean).join("\n");

    const userPayload = {
      case_text: comp.text,
      output_mode: body.output_mode,
      language: body.language ?? "fr",
      institution_slug: body.institution_slug,
      course_slug: body.course_slug,
      jurisdiction_hint: body.jurisdiction_hint,
      court_hint: body.court_hint,
      decision_date_hint: body.decision_date_hint,
      source_kind: body.source_kind,
      filename: body.filename,
      // debug meta pour UI (facultatif)
      __server_notes: {
        compressed: comp.compressed,
        compression_strategy: comp.strategy,
        original_chars: body.case_text.length,
        sent_chars: comp.text.length,
      },
    };

    // 1) primary json_object
    let r = await callOpenAIResponses(buildPrimaryPayloadJsonObject(systemPrompt, userPayload));

    if (!r.ok) {
      // ✅ erreurs “friendly”
      const took = Date.now() - startedAt;

      // Abort/timeout local
      if (r.aborted) {
        return json(
          {
            error: "OpenAI timeout (serveur)",
            hint:
              "La décision est probablement trop longue ou la réponse trop lourde. " +
              "Essaie avec un extrait plus court (motifs + dispositif) ou relance. " +
              "On peut aussi augmenter maxDuration/timeout côté Vercel.",
            latency_ms: took,
          },
          504
        );
      }

      const status = Number.isFinite(r.status) && r.status >= 400 ? r.status : 502;
      const msg =
        r.json?.error?.message ||
        (typeof r.rawText === "string" && r.rawText.slice(0, 400)) ||
        "Erreur inconnue";

      console.warn("OpenAI responses failed", { status: r.status, msg: String(msg).slice(0, 300) });

      return json(
        {
          error: "OpenAI responses error",
          status: r.status,
          openai_message: msg,
          latency_ms: took,
        },
        status
      );
    }

    const raw = extractOutputText(r.json);
    if (!raw) {
      return json({ error: "Empty output_text from OpenAI" }, 502);
    }

    let parsed = safeJsonParse(raw);

    // Parse fail => repair
    if (!parsed) {
      const rr = await callOpenAIResponses(buildRepairPayload(systemPrompt, raw, { parse: "failed" }));
      if (!rr.ok) {
        const msg = rr.json?.error?.message ?? "repair failed";
        return json({ error: "OpenAI repair error", openai_message: msg }, 502);
      }
      const raw2 = extractOutputText(rr.json);
      if (!raw2) return json({ error: "Empty output_text from repair" }, 502);
      parsed = safeJsonParse(raw2);
      if (!parsed) return json({ error: "Repair output still not valid JSON", raw: clampText(raw2, 1200) }, 502);
    }

    // Clarify passthrough
    if (parsed?.type === "clarify") {
      return json(normalizeClarify(parsed), 200);
    }

    applyAnswerGuards(parsed);

    // AJV validate; si fail => repair (avec erreurs AJV)
    const ok = validate(parsed) as boolean;
    if (ok) return json(parsed, 200);

    const rr2 = await callOpenAIResponses(buildRepairPayload(systemPrompt, JSON.stringify(parsed), validate.errors));
    if (!rr2.ok) {
      const msg = rr2.json?.error?.message ?? "schema repair failed";
      return json({ error: "OpenAI schema repair error", openai_message: msg, errors: validate.errors }, 502);
    }

    const raw3 = extractOutputText(rr2.json);
    if (!raw3) return json({ error: "Empty output_text from schema repair" }, 502);

    const parsed3 = safeJsonParse(raw3);
    if (!parsed3) return json({ error: "Schema repair output not valid JSON", raw: clampText(raw3, 1200) }, 502);

    if (parsed3?.type === "clarify") return json(normalizeClarify(parsed3), 200);

    applyAnswerGuards(parsed3);

    const ok2 = validate(parsed3) as boolean;
    if (!ok2) {
      return json({ error: "Schema validation failed (after repair)", errors: validate.errors, parsed: parsed3 }, 422);
    }

    return json(parsed3, 200);
  } catch (e: any) {
    const msg = e?.name === "AbortError" ? "OpenAI timeout" : String(e?.message ?? e);
    console.error("Unhandled error /api/case-reader:", e);
    return json({ error: "Unhandled error", details: msg }, 500);
  }
}

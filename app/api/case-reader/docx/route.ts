import { NextResponse } from "next/server";
import { Document, Packer, Paragraph, TextRun, HeadingLevel } from "docx";

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

// ✅ docx: HeadingLevel peut être un "value object" => on dérive un type sûr
type Heading = (typeof HeadingLevel)[keyof typeof HeadingLevel];

function h(text: string, level: Heading) {
  return new Paragraph({
    text: String(text ?? ""),
    heading: level,
  });
}

function p(text: string) {
  return new Paragraph({
    children: [new TextRun({ text: String(text ?? "") })],
  });
}

function bullet(text: string) {
  return new Paragraph({
    text: String(text ?? ""),
    bullet: { level: 0 },
  });
}

function safeArray<T = any>(v: any): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

function safeStr(v: any): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function formatContext(ctx: any): string {
  if (!ctx || typeof ctx !== "object") return "";
  const parts: string[] = [];

  if (ctx.case_name) parts.push(String(ctx.case_name));

  const line2: string[] = [];
  if (ctx.tribunal) line2.push(String(ctx.tribunal));
  if (ctx.jurisdiction) line2.push(String(ctx.jurisdiction));
  if (ctx.date) line2.push(String(ctx.date));
  if (line2.length) parts.push(line2.join(" — "));

  const line3: string[] = [];
  if (ctx.neutral_citation) line3.push(String(ctx.neutral_citation));
  if (ctx.docket) line3.push(`Dossier: ${ctx.docket}`);
  if (line3.length) parts.push(line3.join(" · "));

  if (ctx.notes) parts.push(String(ctx.notes));
  return parts.join("\n");
}

/**
 * location peut être:
 * - string (ex: "para 12-15")
 * - objet (ex: { kind:"para"|"page"|"unknown", start?:number, end?:number, note?:string })
 */
function formatLocation(loc: any): string {
  if (!loc) return "";
  if (typeof loc === "string") return loc;

  if (typeof loc === "object") {
    const kind = typeof loc.kind === "string" ? loc.kind : "unknown";
    const start = Number.isFinite(loc.start) ? Number(loc.start) : null;
    const end = Number.isFinite(loc.end) ? Number(loc.end) : null;
    const note = typeof loc.note === "string" ? loc.note.trim() : "";

    let range = "";
    if (start !== null && end !== null) range = `${start}-${end}`;
    else if (start !== null) range = `${start}`;
    else if (end !== null) range = `${end}`;

    const base = range ? `${kind} ${range}` : `${kind}`;
    return note ? `${base} (${note})` : base;
  }

  return safeStr(loc);
}

function isLowConfidenceAnchor(a: any): boolean {
  const c = String(a?.confidence ?? "").toLowerCase().trim();
  return c === "faible" || c === "low";
}

function hasUnknownDeep(obj: any): boolean {
  const s = safeStr(obj);
  return s.includes("UNKNOWN");
}

/** rule_test.rules peut être:
 * - [{rule:string, anchor_refs?:string[]}]
 * - string[]
 */
function renderRulesAsBullets(out: any, children: Paragraph[]) {
  const rules = out?.rule_test?.rules;

  if (Array.isArray(rules)) {
    // array d'objets
    if (rules.some((r: any) => r && typeof r === "object" && "rule" in r)) {
      for (const r of rules) {
        const ruleText = String(r?.rule ?? "").trim();
        if (!ruleText) continue;
        const refs = safeArray<string>(r?.anchor_refs).filter(Boolean);
        const suffix = refs.length ? ` (ancres: ${refs.join(", ")})` : "";
        children.push(bullet(ruleText + suffix));
      }
      return;
    }

    // array de strings
    if (rules.every((x: any) => typeof x === "string")) {
      for (const x of rules) {
        const t = String(x ?? "").trim();
        if (t) children.push(bullet(t));
      }
      return;
    }
  }
}

/** rule_test.tests peut être:
 * - string[]
 * - [{name:string, steps:string[]}]
 * - [{test_name:string, test_steps:string[]}] (variante)
 */
function renderTestsAsBullets(out: any, children: Paragraph[]) {
  const tests = out?.rule_test?.tests;
  if (!Array.isArray(tests)) return;

  // string[]
  if (tests.every((x: any) => typeof x === "string")) {
    for (const x of tests) {
      const t = String(x ?? "").trim();
      if (t) children.push(bullet(t));
    }
    return;
  }

  // object[]
  for (const t of tests) {
    if (!t || typeof t !== "object") continue;
    const name =
      String(t?.name ?? t?.test_name ?? "").trim() ||
      "Test";
    const stepsArr = safeArray<string>(t?.steps ?? t?.test_steps).map((s) => String(s ?? "").trim()).filter(Boolean);
    const steps = stepsArr.length ? stepsArr.join(" · ") : "";
    const line = steps ? `${name}: ${steps}` : name;
    children.push(bullet(line));
  }
}

/** application_reasoning peut varier :
 * - application_reasoning.structured_application[{step,analysis}]
 * - application_reasoning.reasoning_points string[]
 * - application.reasoning string[]
 * - application/analysis texte
 */
function renderApplication(out: any, children: Paragraph[]) {
  const ar = out?.application_reasoning;
  const app = out?.application;

  // structured_application
  const sa = safeArray(ar?.structured_application);
  if (sa.length) {
    for (const s of sa) {
      const step = String(s?.step ?? "").trim();
      const analysis = String(s?.analysis ?? "").trim();
      if (!step && !analysis) continue;
      children.push(bullet(step && analysis ? `${step} — ${analysis}` : (step || analysis)));
    }
  } else {
    // reasoning_points
    const rp = safeArray<string>(ar?.reasoning_points);
    if (rp.length) {
      for (const x of rp) {
        const t = String(x ?? "").trim();
        if (t) children.push(bullet(t));
      }
    } else {
      // fallback application fields
      const apPoints = safeArray<string>(app?.reasoning ?? app?.points);
      if (apPoints.length) {
        for (const x of apPoints) {
          const t = String(x ?? "").trim();
          if (t) children.push(bullet(t));
        }
      } else {
        const txt = String(ar?.analysis ?? app?.analysis ?? "").trim();
        if (txt) children.push(p(txt));
      }
    }
  }

  const ratio = String(ar?.ratio_or_result ?? app?.ratio_or_result ?? app?.result ?? "").trim();
  if (ratio) children.push(p(`Ratio / résultat: ${ratio}`));
}

/** scope_for_course peut être:
 * - {course, what_it_changes, exam_spotting_box:{trigger,do_this,pitfalls}}
 * - ou autre (on fait fallback safeStr)
 */
function renderScopeExamFirst(out: any, children: Paragraph[]) {
  const s = out?.scope_for_course ?? {};

  children.push(h("6. Portée (cours) + En examen", HeadingLevel.HEADING_1));

  const course = String(s?.course ?? s?.course_slug ?? "").trim();
  if (course) children.push(p(`Cours: ${course}`));

  const summary =
    String(s?.what_it_changes ?? s?.scope_summary ?? "").trim();
  if (summary) children.push(p(summary));

  // Codification: si le modèle l’a déjà écrit dans summary/pitfalls, ok.
  // Sinon, si tu ajoutes plus tard un champ dédié, on pourra l’insérer ici.

  children.push(h("En examen, si tu vois…", HeadingLevel.HEADING_2));

  const trigger = String(s?.exam_spotting_box?.trigger ?? "").trim();
  const examTriggers = safeArray<string>(s?.exam_triggers).map((x) => String(x ?? "").trim()).filter(Boolean);

  if (trigger) {
    children.push(p(trigger));
  } else if (examTriggers.length) {
    for (const x of examTriggers) children.push(bullet(x));
  } else {
    children.push(p(""));
  }

  children.push(h("Fais ça", HeadingLevel.HEADING_3));
  const doThis = safeArray<string>(s?.exam_spotting_box?.do_this ?? s?.how_to_use_in_exam).map((x) => String(x ?? "").trim()).filter(Boolean);
  for (const x of doThis) children.push(bullet(x));

  children.push(h("Pièges", HeadingLevel.HEADING_3));
  const pitfalls = safeArray<string>(s?.exam_spotting_box?.pitfalls ?? s?.pitfalls).map((x) => String(x ?? "").trim()).filter(Boolean);
  for (const x of pitfalls) children.push(bullet(x));
}

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => null)) as any;
    const out = body?.case_reader_output;

    if (!out) {
      return NextResponse.json(
        { error: "Missing case_reader_output" },
        { status: 400, headers: CORS_HEADERS }
      );
    }

    if (out.type !== "answer") {
      return NextResponse.json(
        { error: "DOCX export only supports type='answer'" },
        { status: 400, headers: CORS_HEADERS }
      );
    }

    // Minimal DOCX (éditable) — sans republier le jugement: uniquement le résumé structuré.
    const children: Paragraph[] = [];

    children.push(h("Droitis — Fiche (Case Reader)", HeadingLevel.TITLE));

    // =========================
    // BLOC EXAM-FIRST (EN TÊTE)
    // =========================

    // 0) Dispositions importantes
    children.push(h("Dispositions importantes (à citer)", HeadingLevel.HEADING_1));

    // Option: cité_articles si présent
    const citedArticles = safeArray<string>(out.rule_test?.cited_articles).map((x) => String(x ?? "").trim()).filter(Boolean);
    if (citedArticles.length) {
      for (const a of citedArticles) children.push(bullet(a));
    }

    // Règles (fallback si pas de cited_articles)
    if (!citedArticles.length) {
      renderRulesAsBullets(out, children);
    }

    // 0b) Pièges à éviter (si déjà fourni)
    children.push(h("Pièges à éviter", HeadingLevel.HEADING_1));
    const pitfallsTop = safeArray<string>(
      out.scope_for_course?.exam_spotting_box?.pitfalls ??
        out.scope_for_course?.pitfalls
    )
      .map((x) => String(x ?? "").trim())
      .filter(Boolean);
    if (pitfallsTop.length) {
      for (const x of pitfallsTop) children.push(bullet(x));
    } else {
      children.push(p(""));
    }

    // 0c) Quand vérifier la décision (heuristique simple)
    const anchors = safeArray(out.anchors);
    const lowConfidenceRatio =
      anchors.length > 0
        ? anchors.filter((a: any) => isLowConfidenceAnchor(a)).length / anchors.length
        : 0;

    const manyUnknown = hasUnknownDeep(out.context) || hasUnknownDeep(out.facts);

    const shouldVerify =
      String(out.context?.neutral_citation ?? "UNKNOWN") === "UNKNOWN" ||
      manyUnknown ||
      lowConfidenceRatio >= 0.5;

    children.push(h("Quand aller vérifier la décision", HeadingLevel.HEADING_1));
    children.push(
      p(
        shouldVerify
          ? "Vérifie la décision complète (citation, tribunal/date, paragraphes) si tu t’en sers en examen/travail ou si un point est contestable. Ici, certaines infos clés semblent manquantes ou peu sûres."
          : "Vérification recommandée seulement si tu as besoin d’une citation exacte, ou d’un passage précis."
      )
    );

    // 0d) Définitions rapides (si le modèle les fournit dans takeaways sous forme 'Définition — ...')
    const defs = safeArray<string>(out.takeaways).filter((t) =>
      String(t ?? "").toLowerCase().startsWith("définition")
    );
    if (defs.length) {
      children.push(h("Définitions rapides (vulgarisées)", HeadingLevel.HEADING_1));
      for (const d of defs) children.push(bullet(String(d)));
    }

    // =========================
    // SECTION 6 EN PREMIER
    // =========================
    renderScopeExamFirst(out, children);

    // =========================
    // RESTE DES SECTIONS
    // =========================

    children.push(h("1. Contexte", HeadingLevel.HEADING_1));
    children.push(p(formatContext(out.context)));

    children.push(h("2. Faits essentiels", HeadingLevel.HEADING_1));
    children.push(p(out.facts?.summary ?? out.facts?.resume ?? ""));
    for (const kf of safeArray(out.facts?.key_facts ?? out.faits?.faits_charniere)) {
      const fact = String(kf?.fact ?? kf?.fait ?? "").trim();
      const imp = String(kf?.importance ?? "").trim();
      if (!fact) continue;
      children.push(bullet(imp ? `${fact} (${imp})` : fact));
    }

    children.push(h("3. Question(s) en litige", HeadingLevel.HEADING_1));
    for (const x of safeArray<string>(out.issues)) {
      const t = String(x ?? "").trim();
      if (t) children.push(bullet(t));
    }

    children.push(h("4. Règle / Test", HeadingLevel.HEADING_1));

    children.push(h("Règles", HeadingLevel.HEADING_2));
    renderRulesAsBullets(out, children);

    children.push(h("Tests", HeadingLevel.HEADING_2));
    renderTestsAsBullets(out, children);

    children.push(h("5. Application / Raisonnement", HeadingLevel.HEADING_1));
    renderApplication(out, children);

    children.push(h("7. Takeaways", HeadingLevel.HEADING_1));
    for (const x of safeArray<string>(out.takeaways)) {
      const t = String(x ?? "").trim();
      if (t) children.push(bullet(t));
    }

    children.push(h("Anchors (preuves d’ancrage)", HeadingLevel.HEADING_1));
    for (const a of safeArray(out.anchors)) {
      const id = String(a?.id ?? "").trim();
      const typ = String(a?.anchor_type ?? "").trim();
      const loc = formatLocation(a?.location);
      const snip = String(a?.evidence_snippet ?? "").trim();
      children.push(bullet(`${id} — ${typ} — ${loc} — “${snip}”`));
    }

    const doc = new Document({
      sections: [{ properties: {}, children }],
    });

    const buf = await Packer.toBuffer(doc);
    const bodyBytes = new Uint8Array(buf);

    return new Response(bodyBytes, {
      status: 200,
      headers: {
        ...CORS_HEADERS,
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "Content-Disposition": 'attachment; filename="droitis-fiche.docx"',
      },
    });
  } catch (e: any) {
    return NextResponse.json(
      { error: "DOCX export failed", details: String(e?.message ?? e) },
      { status: 500, headers: CORS_HEADERS }
    );
  }
}

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
    text,
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
    for (const r of safeArray(out.rule_test?.rules)) {
      const ruleText = String(r?.rule ?? "").trim();
      if (!ruleText) continue;
      const refs = safeArray<string>(r?.anchor_refs).filter(Boolean);
      const suffix = refs.length ? ` (ancres: ${refs.join(", ")})` : "";
      children.push(bullet(ruleText + suffix));
    }

    // 0b) Pièges à éviter
    children.push(h("Pièges à éviter", HeadingLevel.HEADING_1));
    for (const x of safeArray<string>(out.scope_for_course?.exam_spotting_box?.pitfalls)) {
      const t = String(x ?? "").trim();
      if (t) children.push(bullet(t));
    }

    // 0c) Quand vérifier la décision (heuristique simple)
    const anchors = safeArray(out.anchors);
    const lowConfidenceRatio =
      anchors.length > 0
        ? anchors.filter((a: any) => String(a?.confidence ?? "").toLowerCase() === "faible").length /
          anchors.length
        : 0;

    const manyUnknown =
      JSON.stringify(out.context ?? {}).includes("UNKNOWN") ||
      JSON.stringify(out.facts ?? {}).includes("UNKNOWN");

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
      String(t).toLowerCase().startsWith("définition")
    );
    if (defs.length) {
      children.push(h("Définitions rapides (vulgarisées)", HeadingLevel.HEADING_1));
      for (const d of defs) children.push(bullet(String(d)));
    }


    children.push(h("1. Contexte", HeadingLevel.HEADING_1));
    children.push(p(JSON.stringify(out.context ?? {}, null, 2)));

    children.push(h("2. Faits essentiels", HeadingLevel.HEADING_1));
    children.push(p(out.facts?.summary ?? ""));
    for (const kf of safeArray(out.facts?.key_facts)) {
      children.push(bullet(`${kf?.fact ?? ""} (${kf?.importance ?? ""})`));
    }

    children.push(h("3. Question(s) en litige", HeadingLevel.HEADING_1));
    for (const x of safeArray<string>(out.issues)) {
      children.push(bullet(x));
    }

    children.push(h("4. Règle / Test", HeadingLevel.HEADING_1));
    children.push(h("Règles", HeadingLevel.HEADING_2));
    for (const r of safeArray(out.rule_test?.rules)) {
      children.push(bullet(r?.rule ?? ""));
    }

    children.push(h("Tests", HeadingLevel.HEADING_2));
    for (const t of safeArray(out.rule_test?.tests)) {
      const steps = safeArray<string>(t?.steps).join(" · ");
      children.push(bullet(`${t?.name ?? ""}: ${steps}`));
    }

    children.push(h("5. Application / Raisonnement", HeadingLevel.HEADING_1));
    for (const s of safeArray(out.application_reasoning?.structured_application)) {
      children.push(bullet(`${s?.step ?? ""} — ${s?.analysis ?? ""}`));
    }
    children.push(p(`Ratio / résultat: ${out.application_reasoning?.ratio_or_result ?? ""}`));

    children.push(h("6. Portée (cours) + En examen", HeadingLevel.HEADING_1));
    children.push(p(`Cours: ${out.scope_for_course?.course ?? ""}`));
    children.push(p(out.scope_for_course?.what_it_changes ?? ""));

    children.push(h("En examen, si tu vois…", HeadingLevel.HEADING_2));
    children.push(p(out.scope_for_course?.exam_spotting_box?.trigger ?? ""));

    children.push(h("Fais ça", HeadingLevel.HEADING_3));
    for (const x of safeArray<string>(out.scope_for_course?.exam_spotting_box?.do_this)) {
      children.push(bullet(x));
    }

    children.push(h("Pièges", HeadingLevel.HEADING_3));
    for (const x of safeArray<string>(out.scope_for_course?.exam_spotting_box?.pitfalls)) {
      children.push(bullet(x));
    }

    children.push(h("7. Takeaways", HeadingLevel.HEADING_1));
    for (const x of safeArray<string>(out.takeaways)) {
      children.push(bullet(x));
    }

    children.push(h("Anchors (preuves d’ancrage)", HeadingLevel.HEADING_1));
    for (const a of safeArray(out.anchors)) {
      children.push(
        bullet(
          `${a?.id ?? ""} — ${a?.anchor_type ?? ""} — ${a?.location ?? ""} — “${a?.evidence_snippet ?? ""}”`
        )
      );
    }

    const doc = new Document({
      sections: [{ properties: {}, children }],
    });

    const buf = await Packer.toBuffer(doc);

    // ✅ Robust TS: Response() accepte BodyInit (Uint8Array). Buffer peut causer un warning TS.
    const bodyBytes = new Uint8Array(buf);

    return new Response(bodyBytes, {
      status: 200,
      headers: {
        ...CORS_HEADERS,
        "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
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

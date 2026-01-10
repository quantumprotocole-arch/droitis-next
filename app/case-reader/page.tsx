"use client";

import { useMemo, useState } from "react";
import { extractPdfTextFromFile } from "@/lib/case-reader/pdfText.client";

export const dynamic = "force-dynamic";

type Clarify = {
  type: "clarify";
  output_mode: "fiche" | "analyse_longue";
  clarification_questions: string[];
};

type Answer = {
  type: "answer";
  output_mode: "fiche" | "analyse_longue";
  meta?: any;
  context?: any;
  facts?: any;
  issues?: any[];
  rule_test?: any;
  application_reasoning?: any;
  scope_for_course?: any;
  takeaways?: string[];
  anchors?: any[];
  clarification_questions?: string[];
};

type Data = Clarify | Answer;

function safeStr(x: any) {
  if (x == null) return "";
  if (typeof x === "string") return x;
  if (typeof x === "number" || typeof x === "boolean") return String(x);
  try {
    return JSON.stringify(x);
  } catch {
    return String(x);
  }
}

function isPdfFile(file: File) {
  const name = (file.name || "").toLowerCase();
  const type = (file.type || "").toLowerCase();
  return type === "application/pdf" || name.endsWith(".pdf");
}

function isDocxFile(file: File) {
  const name = (file.name || "").toLowerCase();
  const type = (file.type || "").toLowerCase();
  return (
    type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    name.endsWith(".docx")
  );
}

function formatContextAsText(ctx: any): string {
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

export default function CaseReaderPage() {
  const [outputMode, setOutputMode] = useState<"fiche" | "analyse_longue">("analyse_longue");
  const [institutionSlug, setInstitutionSlug] = useState("udes");
  const [courseSlug, setCourseSlug] = useState("obligations-1");

  const [file, setFile] = useState<File | null>(null);
  const [extractedText, setExtractedText] = useState<string>("");

  const [loading, setLoading] = useState(false);
  const [downloading, setDownloading] = useState(false);

  const [status, setStatus] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<Data | null>(null);

  const canDownload = useMemo(() => data?.type === "answer", [data]);

  async function analyzeFile() {
    if (!file) {
      setError("Choisis un fichier PDF ou DOCX.");
      return;
    }
    if (!isPdfFile(file) && !isDocxFile(file)) {
      setError("Format non supporté. Formats acceptés: PDF ou DOCX.");
      return;
    }

    setLoading(true);
    setError(null);
    setStatus(null);
    setData(null);
    setExtractedText("");

    try {
      // 1) Extraction
      let text = "";

      if (isPdfFile(file)) {
        text = await extractPdfTextFromFile(file);

        // Heuristique "PDF scanné" : trop peu de caractères non-espace
        const compact = text.replace(/\s+/g, "");
        if (compact.length < 200) {
          throw new Error(
            "Ce PDF semble être un scan (image) : il ne contient pas de texte sélectionnable.\n\n" +
              "Solutions :\n" +
              "• Exporter la décision en PDF texte (depuis un éditeur)\n" +
              "• Ou utiliser un DOCX\n"
          );
        }
      } else {
        const fd = new FormData();
        fd.append("file", file);

        const res = await fetch("/api/case-reader/extract", { method: "POST", body: fd });
        const j = await res.json().catch(() => null);
        if (!res.ok) {
          throw new Error(j?.error || `Extraction DOCX échouée (${res.status})`);
        }
        text = String(j?.extracted_text ?? "");
      }

      text = text.trim();
      if (!text) throw new Error("Aucun texte extractible trouvé dans ce fichier.");

      setExtractedText(text);

      // 2) Génération AUTOMATIQUE (pas de bouton 'Générer')
      const res2 = await fetch("/api/case-reader", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          output_mode: outputMode,
          case_text: text,
          institution_slug: institutionSlug,
          course_slug: courseSlug,
          source_kind: isPdfFile(file) ? "pdf" : "docx",
          filename: file.name
        })
      });

      setStatus(res2.status);
      const raw = await res2.text();
      let parsed: any = null;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new Error("Réponse non-JSON du serveur. Voir détails.");
      }

      setData(parsed as Data);

      if (!res2.ok) {
        throw new Error(parsed?.error || `Erreur serveur (${res2.status})`);
      }
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setLoading(false);
    }
  }

  async function onDownloadDocx() {
    if (!data || data.type !== "answer") return;
    setDownloading(true);
    setError(null);

    try {
      const res = await fetch("/api/case-reader/docx", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ case_reader_output: data })
      });

      if (!res.ok) {
        const j = await res.json().catch(() => null);
        throw new Error(j?.error || `DOCX failed (${res.status})`);
      }

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "droitis-case-reader.docx";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div style={{ maxWidth: 980, margin: "0 auto", padding: 24 }}>
      <h1 style={{ marginTop: 0 }}>Droitis — Case Reader</h1>

      <p style={{ opacity: 0.85 }}>
        Analyse une décision <b>uniquement via PDF ou DOCX</b>. Après extraction, la génération démarre automatiquement.
      </p>

      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "flex-end" }}>
        <label style={{ display: "grid", gap: 6 }}>
          output_mode
          <select value={outputMode} onChange={(e) => setOutputMode(e.target.value as any)}>
            <option value="fiche">fiche</option>
            <option value="analyse_longue">analyse_longue</option>
          </select>
        </label>

        <label style={{ display: "grid", gap: 6 }}>
          institution_slug
          <input value={institutionSlug} onChange={(e) => setInstitutionSlug(e.target.value)} />
        </label>

        <label style={{ display: "grid", gap: 6 }}>
          course_slug
          <input value={courseSlug} onChange={(e) => setCourseSlug(e.target.value)} />
        </label>
      </div>

      <div style={{ marginTop: 16, padding: 16, border: "1px solid #333", borderRadius: 12 }}>
        <label style={{ display: "grid", gap: 8 }}>
          <b>Fichier (PDF ou DOCX)</b>
          <input
            type="file"
            accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
        </label>

        <button onClick={analyzeFile} disabled={loading || !file} style={{ marginTop: 12 }}>
          {loading ? "Analyse en cours..." : "Analyser le fichier"}
        </button>

        <button onClick={onDownloadDocx} disabled={!canDownload || downloading} style={{ marginLeft: 10 }}>
          {downloading ? "Téléchargement..." : "Télécharger (.docx)"}
        </button>

        {status != null && (
          <div style={{ marginTop: 12, opacity: 0.85 }}>
            Status: <b>{status}</b>
          </div>
        )}

        {error && (
          <pre
            style={{
              marginTop: 12,
              padding: 12,
              background: "#1b1b1b",
              borderRadius: 8,
              whiteSpace: "pre-wrap"
            }}
          >
            {error}
          </pre>
        )}
      </div>

      <hr style={{ margin: "24px 0" }} />

      {!data && <p style={{ opacity: 0.7 }}>Aucun résultat pour le moment.</p>}

      {data?.type === "clarify" && (
        <div>
          <h2>Besoin de précisions (clarify)</h2>
          <ul>
            {(data.clarification_questions ?? []).map((q, i) => (
              <li key={i}>{q}</li>
            ))}
          </ul>

          <details style={{ marginTop: 12 }}>
            <summary>JSON brut</summary>
            <pre style={{ whiteSpace: "pre-wrap" }}>{JSON.stringify(data, null, 2)}</pre>
          </details>
        </div>
      )}

      {data?.type === "answer" && (
        <div style={{ display: "grid", gap: 18 }}>
          {/* 6) Portée en PREMIER */}
          <div style={{ padding: 16, border: "1px solid #444", borderRadius: 12 }}>
            <h2 style={{ marginTop: 0 }}>6) Portée (cours) + En examen</h2>
            <p style={{ marginTop: 6 }}>
              <b>Cours:</b> {safeStr(data.scope_for_course?.course)}
            </p>
            <p style={{ marginTop: 6 }}>{safeStr(data.scope_for_course?.what_it_changes)}</p>

            <div style={{ padding: 12, border: "1px solid #555", borderRadius: 10 }}>
              <p style={{ marginTop: 0, marginBottom: 8 }}>
                <b>En examen, si tu vois…</b>
              </p>
              <p style={{ marginTop: 0 }}>{safeStr(data.scope_for_course?.exam_spotting_box?.trigger)}</p>

              <p style={{ marginBottom: 6 }}>
                <b>Fais ça</b>
              </p>
              <ul style={{ marginTop: 0 }}>
                {(data.scope_for_course?.exam_spotting_box?.do_this ?? []).map((x: string, i: number) => (
                  <li key={i}>{x}</li>
                ))}
              </ul>

              <p style={{ marginBottom: 6 }}>
                <b>Pièges</b>
              </p>
              <ul style={{ marginTop: 0 }}>
                {(data.scope_for_course?.exam_spotting_box?.pitfalls ?? []).map((x: string, i: number) => (
                  <li key={i}>{x}</li>
                ))}
              </ul>
            </div>
          </div>

          {/* 1) Contexte */}
          <div>
            <h2>1) Contexte</h2>
            <pre style={{ whiteSpace: "pre-wrap", opacity: 0.95 }}>{formatContextAsText(data.context)}</pre>
          </div>

          {/* 2) Faits essentiels */}
          <div>
            <h2>2) Faits essentiels</h2>
            <p>{safeStr(data.facts?.summary)}</p>
            <ul>
              {(data.facts?.key_facts ?? []).map((f: any, i: number) => (
                <li key={i}>
                  <b>{safeStr(f.importance)}</b> — {safeStr(f.fact)}
                </li>
              ))}
            </ul>
          </div>

          {/* 3) Issues */}
          <div>
            <h2>3) Question(s) en litige</h2>
            <ul>
              {(data.issues ?? []).map((x: any, i: number) => (
                <li key={i}>{safeStr(x)}</li>
              ))}
            </ul>
          </div>

          {/* 4) Règle / Test */}
          <div>
            <h2>4) Règle / test</h2>
            <p>{safeStr(data.rule_test?.rule_summary)}</p>

            {Array.isArray(data.rule_test?.test_steps) && data.rule_test.test_steps.length > 0 && (
              <>
                <h3>Étapes du test</h3>
                <ol>
                  {data.rule_test.test_steps.map((s: any, i: number) => (
                    <li key={i}>
                      <b>{safeStr(s.step)}</b> — {safeStr(s.details)}
                    </li>
                  ))}
                </ol>
              </>
            )}

            {Array.isArray(data.rule_test?.cited_articles) && data.rule_test.cited_articles.length > 0 && (
              <>
                <h3>Articles cités (si présents dans le texte)</h3>
                <ul>
                  {data.rule_test.cited_articles.map((a: any, i: number) => (
                    <li key={i}>
                      <b>{safeStr(a.article)}</b> — {safeStr(a.explanation)}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>

          {/* 5) Application / Raisonnement */}
          <div>
            <h2>5) Application / raisonnement</h2>
            <p>{safeStr(data.application_reasoning?.reasoning_summary)}</p>

            {Array.isArray(data.application_reasoning?.structured_application) && (
              <ul>
                {data.application_reasoning.structured_application.map((s: any, i: number) => (
                  <li key={i}>
                    <b>{safeStr(s.step)}</b> — {safeStr(s.analysis)}
                  </li>
                ))}
              </ul>
            )}

            <p>
              <b>Ratio / résultat:</b> {safeStr(data.application_reasoning?.ratio_or_result)}
            </p>
          </div>

          {/* 7) Takeaways */}
          <div>
            <h2>7) Ce que Droitis doit retenir</h2>
            <ul>
              {(data.takeaways ?? []).map((t: any, i: number) => (
                <li key={i}>{safeStr(t)}</li>
              ))}
            </ul>
          </div>

          {/* Anchors */}
          <div>
            <h2>Anchors (preuves d’ancrage)</h2>
            <ul>
              {(data.anchors ?? []).map((a: any, i: number) => (
                <li key={i}>
                  <b>{safeStr(a.id)}</b> — <b>{safeStr(a.anchor_type)}</b> — {safeStr(a.location)} — “
                  {safeStr(a.evidence_snippet)}” ({safeStr(a.confidence)})
                </li>
              ))}
            </ul>
          </div>

          <details>
            <summary>JSON brut</summary>
            <pre style={{ whiteSpace: "pre-wrap" }}>{JSON.stringify(data, null, 2)}</pre>
          </details>

          <details>
            <summary>Texte extrait (debug)</summary>
            <pre style={{ whiteSpace: "pre-wrap" }}>{extractedText}</pre>
          </details>
        </div>
      )}
    </div>
  );
}

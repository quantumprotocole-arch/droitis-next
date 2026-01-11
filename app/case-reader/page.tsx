"use client";

import { useMemo, useState } from "react";
import { extractPdfTextFromFile } from "@/lib/case-reader/pdfText.client";

export const dynamic = "force-dynamic";

type Preview = {
  type: "preview";
  output_mode: "fiche" | "analyse_longue";
  preview: {
    scope_course_first?: {
      course?: string;
      what_it_changes?: string;
      exam_spotting_box?: {
        trigger?: string;
        do_this?: string[];
        pitfalls?: string[];
      };
      codification_if_any?: string;
    };
    context_text?: string;
    key_facts?: { fact: string; why_it_matters?: string; anchor_refs?: string[] }[];
    issues?: { issue: string; anchor_refs?: string[] }[];
    rules_tests?: { item: string; kind: "rule" | "test"; anchor_refs?: string[] }[];
    reasoning?: { step: string; anchor_refs?: string[] }[];
    uncertainties?: string[];
    anchors?: { id: string; anchor_type: string; location: string; evidence_snippet: string; confidence: string }[];
  };
};

type Clarify = {
  type: "clarify";
  output_mode: "fiche" | "analyse_longue";
  clarification_questions: string[];
};

type Answer = any; // réponse finale (schéma canonical)

type Output = Preview | Clarify | Answer;

function isPdfFile(f: File) {
  const name = (f.name || "").toLowerCase();
  const mime = (f.type || "").toLowerCase();
  return mime === "application/pdf" || name.endsWith(".pdf");
}

function isDocxFile(f: File) {
  const name = (f.name || "").toLowerCase();
  const mime = (f.type || "").toLowerCase();
  return (
    mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    name.endsWith(".docx")
  );
}

export default function CaseReaderPage() {
  const [outputMode, setOutputMode] = useState<"fiche" | "analyse_longue">("analyse_longue");
  const [institutionSlug, setInstitutionSlug] = useState("udes");
  const [courseSlug, setCourseSlug] = useState("obligations-1");

  const [file, setFile] = useState<File | null>(null);
  const [sourceKind, setSourceKind] = useState<"pdf" | "docx" | null>(null);

  const [extractedText, setExtractedText] = useState<string>("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [finalAnswer, setFinalAnswer] = useState<any | null>(null);

  const [loadingExtract, setLoadingExtract] = useState(false);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [loadingFinal, setLoadingFinal] = useState(false);
  const [downloading, setDownloading] = useState(false);

  const [status, setStatus] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorDetails, setErrorDetails] = useState<any | null>(null);

  const canPreview = useMemo(() => extractedText.trim().length > 0 && !loadingExtract, [extractedText, loadingExtract]);
  const canGenerate = useMemo(() => !!preview && !loadingFinal, [preview, loadingFinal]);

  const canDownload = useMemo(() => {
    return finalAnswer?.type === "answer" && !downloading;
  }, [finalAnswer, downloading]);

  async function onExtractFile() {
    if (!file) return;

    setLoadingExtract(true);
    setError(null);
    setErrorDetails(null);
    setStatus(null);

    setExtractedText("");
    setPreview(null);
    setFinalAnswer(null);

    try {
      if (isPdfFile(file)) {
        setSourceKind("pdf");
        const text = await extractPdfTextFromFile(file);

        const nonSpace = (text || "").replace(/\s+/g, "");
        if (nonSpace.length < 400) {
          throw new Error(
            "PDF probablement scanné (image-only): aucun texte exploitable détecté. Utilise un PDF texte ou un DOCX."
          );
        }

        setExtractedText(text);
        return;
      }

      if (isDocxFile(file)) {
        setSourceKind("docx");
        const fd = new FormData();
        fd.append("file", file);

        const res = await fetch("/api/case-reader/extract", { method: "POST", body: fd });
        setStatus(res.status);

        const parsed = await res.json().catch(() => null);
        if (!res.ok) {
          setError(parsed?.error ?? "Extraction error");
          setErrorDetails(parsed);
          return;
        }

        const t = String(parsed?.extracted_text ?? "");
        if (!t.trim()) throw new Error("DOCX: texte vide après extraction.");

        setExtractedText(t);
        return;
      }

      throw new Error("Format non supporté. Utilise .pdf ou .docx.");
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setLoadingExtract(false);
    }
  }

  async function onPreview() {
    if (!extractedText.trim() || !sourceKind) return;

    setLoadingPreview(true);
    setError(null);
    setErrorDetails(null);
    setStatus(null);

    setPreview(null);
    setFinalAnswer(null);

    try {
      const res = await fetch("/api/case-reader/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          case_text: extractedText,
          output_mode: outputMode,
          institution_slug: institutionSlug,
          course_slug: courseSlug,
          source_kind: sourceKind,
          filename: file?.name ?? undefined,
        }),
      });

      setStatus(res.status);
      const parsed = (await res.json().catch(() => null)) as any;

      if (!res.ok) {
        setError(parsed?.error ?? "Preview error");
        setErrorDetails(parsed);
        return;
      }

      if (parsed?.type !== "preview") {
        // si jamais l’API renvoie autre chose
        setError("Réponse preview inattendue.");
        setErrorDetails(parsed);
        return;
      }

      setPreview(parsed as Preview);
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setLoadingPreview(false);
    }
  }

  async function onGenerateConfirmed() {
    if (!preview || !sourceKind) return;

    setLoadingFinal(true);
    setError(null);
    setErrorDetails(null);
    setStatus(null);

    setFinalAnswer(null);

    try {
      const res = await fetch("/api/case-reader", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          case_text: extractedText,
          output_mode: outputMode,
          institution_slug: institutionSlug,
          course_slug: courseSlug,
          source_kind: sourceKind,
          filename: file?.name ?? undefined,
          confirmed_preview: true,
          preview_payload: preview, // aperçu validé
        }),
      });

      setStatus(res.status);
      const parsed = await res.json().catch(() => null);

      if (!res.ok) {
        setError(parsed?.error ?? "Generate error");
        setErrorDetails(parsed);
        return;
      }

      setFinalAnswer(parsed);
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setLoadingFinal(false);
    }
  }

  async function onDownloadDocx() {
    if (!finalAnswer || finalAnswer?.type !== "answer") return;

    setDownloading(true);
    setError(null);
    setErrorDetails(null);

    try {
      const res = await fetch("/api/case-reader/docx", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ case_reader_output: finalAnswer }),
      });

      if (!res.ok) {
        const t = await res.text();
        throw new Error("Download failed: " + t.slice(0, 300));
      }

      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "droitis-fiche.docx";
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div style={{ maxWidth: 980, margin: "0 auto", padding: 24 }}>
      <h1 style={{ fontSize: 28, fontWeight: 700 }}>Case Reader</h1>
      <p style={{ opacity: 0.9 }}>
        Flux: <b>Upload → Extraction → Aperçu à confirmer → Génération → Export DOCX</b>
      </p>

      <div style={{ display: "grid", gap: 12, marginTop: 16 }}>
        <label>
          Output mode:{" "}
          <select value={outputMode} onChange={(e) => setOutputMode(e.target.value as any)}>
            <option value="fiche">fiche</option>
            <option value="analyse_longue">analyse_longue</option>
          </select>
        </label>

        <label>
          Institution:{" "}
          <input value={institutionSlug} onChange={(e) => setInstitutionSlug(e.target.value)} />
        </label>

        <label>
          Cours:{" "}
          <input value={courseSlug} onChange={(e) => setCourseSlug(e.target.value)} />
        </label>

        <label>
          Fichier (PDF ou DOCX) :{" "}
          <input
            type="file"
            accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            onChange={(e) => {
              const f = e.target.files?.[0] ?? null;
              setFile(f);
              setExtractedText("");
              setPreview(null);
              setFinalAnswer(null);
              setError(null);
              setErrorDetails(null);
              setStatus(null);
              setSourceKind(null);
            }}
          />
        </label>

        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <button onClick={onExtractFile} disabled={!file || loadingExtract}>
            {loadingExtract ? "Extraction..." : "1) Extraire le texte"}
          </button>

          <button onClick={onPreview} disabled={!canPreview || loadingPreview}>
            {loadingPreview ? "Analyse (aperçu)..." : "2) Analyser (aperçu)"}
          </button>

          <button onClick={onGenerateConfirmed} disabled={!canGenerate || loadingFinal}>
            {loadingFinal ? "Génération..." : "3) Confirmer & Générer"}
          </button>

          {canDownload && (
            <button onClick={onDownloadDocx} disabled={!canDownload}>
              {downloading ? "Téléchargement..." : "Télécharger (.docx)"}
            </button>
          )}
        </div>

        {status !== null && <div style={{ opacity: 0.8 }}>Status: {status}</div>}

        {error && (
          <div style={{ border: "1px solid #c33", padding: 12, borderRadius: 8 }}>
            <b>Erreur:</b> {error}
            {errorDetails?.openai_message && (
              <div style={{ marginTop: 8 }}>
                <b>OpenAI:</b> {String(errorDetails.openai_message)}
              </div>
            )}
            <details style={{ marginTop: 8 }}>
              <summary>Détails</summary>
              <pre style={{ whiteSpace: "pre-wrap" }}>{JSON.stringify(errorDetails, null, 2)}</pre>
            </details>
          </div>
        )}

        {extractedText && (
          <details>
            <summary>Texte extrait (lecture seule) — {extractedText.length.toLocaleString()} caractères</summary>
            <pre style={{ whiteSpace: "pre-wrap", padding: 12, background: "#111", color: "#eee", borderRadius: 8 }}>
              {extractedText.slice(0, 12000)}
              {extractedText.length > 12000 ? "\n\n...[preview tronqué UI]..." : ""}
            </pre>
          </details>
        )}

        {preview && (
          <div style={{ border: "1px solid #444", padding: 16, borderRadius: 10 }}>
            <h2 style={{ marginTop: 0 }}>Aperçu à confirmer</h2>

            {/* Scope first */}
            <h3>6) Portée (cours) + En examen (aperçu)</h3>
            <div style={{ whiteSpace: "pre-wrap" }}>
              <b>Cours:</b> {preview.preview?.scope_course_first?.course ?? courseSlug}
              <div style={{ marginTop: 8 }}>
                {preview.preview?.scope_course_first?.what_it_changes ?? ""}
              </div>
              {preview.preview?.scope_course_first?.codification_if_any && (
                <div style={{ marginTop: 8 }}>
                  <b>Codification:</b> {preview.preview.scope_course_first.codification_if_any}
                </div>
              )}
            </div>

            <h4>En examen, si tu vois…</h4>
            <div>{preview.preview?.scope_course_first?.exam_spotting_box?.trigger ?? ""}</div>

            <h4>Fais ça</h4>
            <ul>
              {(preview.preview?.scope_course_first?.exam_spotting_box?.do_this ?? []).map((x, i) => (
                <li key={i}>{x}</li>
              ))}
            </ul>

            <h4>Pièges</h4>
            <ul>
              {(preview.preview?.scope_course_first?.exam_spotting_box?.pitfalls ?? []).map((x, i) => (
                <li key={i}>{x}</li>
              ))}
            </ul>

            <hr style={{ margin: "16px 0" }} />

            <h3>1) Contexte (texte cohérent)</h3>
            <div style={{ whiteSpace: "pre-wrap" }}>{preview.preview?.context_text ?? ""}</div>

            <h3>2) Faits essentiels</h3>
            <ul>
              {(preview.preview?.key_facts ?? []).map((k, i) => (
                <li key={i}>
                  <b>{k.fact}</b>
                  {k.why_it_matters ? <div style={{ opacity: 0.9 }}>Pourquoi: {k.why_it_matters}</div> : null}
                </li>
              ))}
            </ul>

            <h3>3) Questions en litige</h3>
            <ul>
              {(preview.preview?.issues ?? []).map((it, i) => (
                <li key={i}>{it.issue}</li>
              ))}
            </ul>

            <h3>4) Règles / Tests (candidats)</h3>
            <ul>
              {(preview.preview?.rules_tests ?? []).map((it, i) => (
                <li key={i}>
                  <b>{it.kind.toUpperCase()}:</b> {it.item}
                </li>
              ))}
            </ul>

            <h3>5) Application / Raisonnement (résumé)</h3>
            <ul>
              {(preview.preview?.reasoning ?? []).map((it, i) => (
                <li key={i}>{it.step}</li>
              ))}
            </ul>

            {preview.preview?.uncertainties?.length ? (
              <>
                <h3>Incertitudes / à vérifier</h3>
                <ul>
                  {preview.preview.uncertainties.map((u, i) => (
                    <li key={i}>{u}</li>
                  ))}
                </ul>
              </>
            ) : null}

            <details style={{ marginTop: 12 }}>
              <summary>Voir preview JSON brut</summary>
              <pre style={{ whiteSpace: "pre-wrap", padding: 12, background: "#111", color: "#eee" }}>
                {JSON.stringify(preview, null, 2)}
              </pre>
            </details>
          </div>
        )}

        {finalAnswer && (
          <div style={{ border: "1px solid #444", padding: 16, borderRadius: 10 }}>
            <h2 style={{ marginTop: 0 }}>Résultat final</h2>
            <details>
              <summary>Voir JSON brut</summary>
              <pre style={{ whiteSpace: "pre-wrap", padding: 12, background: "#111", color: "#eee" }}>
                {JSON.stringify(finalAnswer, null, 2)}
              </pre>
            </details>
          </div>
        )}
      </div>
    </div>
  );
}

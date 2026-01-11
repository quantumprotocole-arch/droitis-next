"use client";

import { useMemo, useState } from "react";
import { extractPdfTextFromFile } from "@/lib/case-reader/pdfText.client";

export const dynamic = "force-dynamic";

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
  const [result, setResult] = useState<any | null>(null);

  const [loadingExtract, setLoadingExtract] = useState(false);
  const [loadingAnalyze, setLoadingAnalyze] = useState(false);
  const [downloading, setDownloading] = useState(false);

  const [status, setStatus] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorDetails, setErrorDetails] = useState<any | null>(null);

  const canAnalyze = useMemo(
    () => extractedText.trim().length > 0 && !!sourceKind && !loadingAnalyze && !loadingExtract,
    [extractedText, sourceKind, loadingAnalyze, loadingExtract]
  );

  const canDownload = useMemo(() => result?.type === "answer" && !downloading, [result, downloading]);

  async function onExtractFile() {
    if (!file) return;

    setLoadingExtract(true);
    setError(null);
    setErrorDetails(null);
    setStatus(null);

    setExtractedText("");
    setResult(null);

    try {
      if (isPdfFile(file)) {
        setSourceKind("pdf");
        const text = await extractPdfTextFromFile(file);

        const nonSpace = (text || "").replace(/\s+/g, "");
        if (nonSpace.length < 400) {
          throw new Error("PDF probablement scanné (image-only): aucun texte exploitable détecté.");
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

  async function onAnalyze() {
    if (!canAnalyze) return;

    setLoadingAnalyze(true);
    setError(null);
    setErrorDetails(null);
    setStatus(null);
    setResult(null);

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
        }),
      });

      setStatus(res.status);
      const parsed = await res.json().catch(() => null);

      if (!res.ok) {
        setError(parsed?.error ?? "Analyze error");
        setErrorDetails(parsed);
        return;
      }

      setResult(parsed);
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setLoadingAnalyze(false);
    }
  }

  async function onDownloadDocx() {
    if (!result || result?.type !== "answer") return;

    setDownloading(true);
    setError(null);
    setErrorDetails(null);

    try {
      const res = await fetch("/api/case-reader/docx", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ case_reader_output: result }),
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
        Flux: <b>Upload → Extraction → Analyse → Export DOCX</b>
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
          Cours: <input value={courseSlug} onChange={(e) => setCourseSlug(e.target.value)} />
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
              setResult(null);
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

          <button onClick={onAnalyze} disabled={!canAnalyze}>
            {loadingAnalyze ? "Analyse..." : "2) Analyser"}
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

        {result && (
          <div style={{ border: "1px solid #444", padding: 16, borderRadius: 10 }}>
            <h2 style={{ marginTop: 0 }}>Résultat</h2>
            <details>
              <summary>Voir JSON brut</summary>
              <pre style={{ whiteSpace: "pre-wrap", padding: 12, background: "#111", color: "#eee" }}>
                {JSON.stringify(result, null, 2)}
              </pre>
            </details>
          </div>
        )}
      </div>
    </div>
  );
}

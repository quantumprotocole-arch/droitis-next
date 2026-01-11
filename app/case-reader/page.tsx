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
  meta: any;
  context: any;
  facts: any;
  issues: string[];
  rule_test: any;
  application_reasoning: any;
  scope_for_course: any;
  takeaways: string[];
  anchors: any[];
  clarification_questions?: string[];
};

type Output = Clarify | Answer | any;

function safeStr(x: any) {
  if (x === null || x === undefined) return "";
  if (typeof x === "string") return x;
  return String(x);
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

export default function CaseReaderPage() {
  const [caseText, setCaseText] = useState("");
  const [outputMode, setOutputMode] = useState<"fiche" | "analyse_longue">("analyse_longue");
  const [institutionSlug, setInstitutionSlug] = useState("udes");
  const [courseSlug, setCourseSlug] = useState("obligations-1");

  const [file, setFile] = useState<File | null>(null);

  const [loading, setLoading] = useState(false);
  const [downloading, setDownloading] = useState(false);

  const [status, setStatus] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<Output | null>(null);

  const canDownload = useMemo(() => {
    return data && data.type === "answer";
  }, [data]);

  const elementsImportants = useMemo(() => {
    const takeaways = data && data.type === "answer" ? (data.takeaways ?? []) : [];
    const defs = takeaways.filter((t: string) => {
      const s = String(t ?? "").trim().toLowerCase();
      return s.startsWith("définition —") || s.startsWith("definition —");
    });
    const others = takeaways.filter((t: string) => !defs.includes(t));
    return { definitions: defs, otherTakeaways: others };
  }, [data]);


  async function onExtractFile() {
    if (!file) return;
    setLoading(true);
    setError(null);
    setStatus(null);
    setData(null); // on efface l’ancienne sortie si on change le texte

    try {
      // ✅ 1) PDF => extraction côté client (évite canvas sur Vercel)
      if (isPdfFile(file)) {
        const text = await extractPdfTextFromFile(file);

        // Heuristique "PDF scanné" : trop peu de caractères non-espace
        const compact = text.replace(/\s+/g, "");
        if (compact.length < 200) {
          throw new Error(
            "Ce PDF semble être un scan (image) : il ne contient pas de texte sélectionnable.\n\n" +
              "Solutions :\n" +
              "• Exporter la décision en PDF texte (depuis Word/CanLII/éditeur) ou utiliser un DOCX\n" +
              "• Ou copier-coller le texte directement dans la zone\n"
          );
        }

        setCaseText(text);
        return;
      }

      // ✅ 2) DOCX => extraction côté serveur (ça marche déjà)
      if (isDocxFile(file)) {
        const fd = new FormData();
        fd.append("file", file);

        const res = await fetch("/api/case-reader/extract", { method: "POST", body: fd });
        setStatus(res.status);

        const text = await res.text();
        let json: any;
        try {
          json = JSON.parse(text);
        } catch {
          throw new Error("Réponse non-JSON (extract): " + text.slice(0, 300));
        }

        if (!res.ok) throw new Error(json?.error ?? `Extraction error (${res.status})`);

        setCaseText(json.extracted_text ?? "");
        return;
      }

      throw new Error("Format non supporté. Utilise un fichier .pdf ou .docx.");
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setLoading(false);
    }
  }

  async function onGenerate() {
    setLoading(true);
    setError(null);
    setData(null);
    setStatus(null);

    try {
      const res = await fetch("/api/case-reader", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          output_mode: outputMode,
          case_text: caseText,
          institution_slug: institutionSlug,
          course_slug: courseSlug
        })
      });

      setStatus(res.status);
      const text = await res.text();

      let json: any;
      try {
        json = JSON.parse(text);
      } catch {
        throw new Error("Réponse non-JSON: " + text.slice(0, 300));
      }

      if (!res.ok) {
        throw new Error(json?.error ?? `Erreur API (${res.status})`);
      }

      setData(json);
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
        const t = await res.text();
        throw new Error("Download failed: " + t.slice(0, 300));
      }

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);

      const filename = `droitis-fiche-${institutionSlug}-${courseSlug}.docx`;

      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
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
      <h1>Case Reader</h1>
      <p style={{ opacity: 0.8 }}>
        Dépose un PDF/DOCX ou colle un extrait (avec paragraphes si possible). Si l’extrait est trop vague, Droitis pose 1–3 questions.
      </p>

      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 12 }}>
        <label>
          Output&nbsp;
          <select value={outputMode} onChange={(e) => setOutputMode(e.target.value as any)}>
            <option value="analyse_longue">Analyse longue</option>
            <option value="fiche">Fiche (DOCX)</option>
          </select>
        </label>

        <label>
          institution_slug&nbsp;
          <input value={institutionSlug} onChange={(e) => setInstitutionSlug(e.target.value)} />
        </label>

        <label>
          course_slug&nbsp;
          <input value={courseSlug} onChange={(e) => setCourseSlug(e.target.value)} />
        </label>

        <button onClick={onGenerate} disabled={loading || caseText.trim().length === 0}>
          {loading ? "Génération..." : "Générer"}
        </button>

        <button onClick={onDownloadDocx} disabled={!canDownload || downloading}>
          {downloading ? "Téléchargement..." : "Télécharger (.docx)"}
        </button>

        {status !== null && <span style={{ opacity: 0.8 }}>STATUS: {status}</span>}
        {error && <span style={{ color: "crimson", whiteSpace: "pre-wrap" }}>{error}</span>}
      </div>

      {/* Upload + extraction */}
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 12 }}>
        <input
          type="file"
          accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
        <button onClick={onExtractFile} disabled={!file || loading}>
          {loading ? "Extraction..." : "Extraire le texte"}
        </button>
        {file && (
          <span style={{ opacity: 0.8 }}>
            Fichier: {file.name} ({Math.round(file.size / 1024)} KB)
          </span>
        )}
      </div>

      <textarea
        value={caseText}
        onChange={(e) => setCaseText(e.target.value)}
        placeholder="Colle ici la décision ou un extrait…"
        style={{ width: "100%", minHeight: 220, padding: 12, fontFamily: "inherit" }}
      />

      <hr style={{ margin: "24px 0" }} />

      {!data && <p style={{ opacity: 0.7 }}>Aucun résultat pour le moment.</p>}

      {data?.type === "clarify" && (
        <div>
          <h2>Informations manquantes</h2>
          <ol>
            {(data.clarification_questions ?? []).map((q: string, idx: number) => (
              <li key={idx}>{q}</li>
            ))}
          </ol>
          <p style={{ opacity: 0.8 }}>
            👉 Ajoute ces infos dans le texte (ou colle un extrait plus complet) puis relance.
          </p>
        </div>
      )}

      {data?.type === "answer" && (
        <div>
          <h2>Fiche / Analyse</h2>

          <h2>Éléments importants</h2>
          <p>
            <b>Portée (cours):</b> {safeStr(data.scope_for_course?.course)}
          </p>
          <p style={{ whiteSpace: "pre-wrap" }}>{safeStr(data.scope_for_course?.what_it_changes)}</p>

          <p>
            <b>Attention ! En examen, si tu vois…</b> {safeStr(data.scope_for_course?.exam_spotting_box?.trigger)}
          </p>
          <p>
            <b>Fais ça:</b>
          </p>
          <ul>
            {(data.scope_for_course?.exam_spotting_box?.do_this ?? []).map((x: string, i: number) => (
              <li key={i}>{x}</li>
            ))}
          </ul>
          <p>
            <b>Pièges à éviter:</b>
          </p>
          <ul>
            {(data.scope_for_course?.exam_spotting_box?.pitfalls ?? []).map((x: string, i: number) => (
              <li key={i}>{x}</li>
            ))}
          </ul>

          <p>
            <b>Définitions:</b>
          </p>
          <ul>
            {(elementsImportants.definitions ?? []).map((t: string, i: number) => (
              <li key={i}>{t}</li>
            ))}
          </ul>

          <hr style={{ margin: "24px 0" }} />

          <h3>1) Contexte</h3>
          <pre style={{ whiteSpace: "pre-wrap" }}>{JSON.stringify(data.context, null, 2)}</pre>

          <h3>2) Faits essentiels</h3>
          <p>{safeStr(data.facts?.summary)}</p>
          <ul>
            {(data.facts?.key_facts ?? []).map((kf: any, i: number) => (
              <li key={i}>
                {safeStr(kf.fact)} <span style={{ opacity: 0.7 }}>({safeStr(kf.importance)})</span>
              </li>
            ))}
          </ul>

          <h3>3) Question(s) en litige</h3>
          <ul>
            {(data.issues ?? []).map((iss: string, i: number) => (
              <li key={i}>{iss}</li>
            ))}
          </ul>

          <h3>4) Règle / Test</h3>
          <h4>Règles</h4>
          <ul>
            {(data.rule_test?.rules ?? []).map((r: any, i: number) => (
              <li key={i}>{safeStr(r.rule)}</li>
            ))}
          </ul>

          <h4>Tests</h4>
          <ul>
            {(data.rule_test?.tests ?? []).map((t: any, i: number) => (
              <li key={i}>
                <b>{safeStr(t.name)}:</b> {(t.steps ?? []).join(" · ")}
              </li>
            ))}
          </ul>

          <h3>5) Application / Raisonnement</h3>
          <ul>
            {(data.application_reasoning?.structured_application ?? []).map((s: any, i: number) => (
              <li key={i}>
                <b>{safeStr(s.step)}</b> — {safeStr(s.analysis)}
              </li>
            ))}
          </ul>
          <p>
            <b>Ratio / résultat:</b> {safeStr(data.application_reasoning?.ratio_or_result)}
          </p>

          <h3>Takeaways (autres)</h3>
          <ul>
            {(elementsImportants.otherTakeaways ?? []).map((t: string, i: number) => (
              <li key={i}>{t}</li>
            ))}
          </ul>

          <h3>Anchors (preuves d’ancrage)</h3>
          <ul>
            {(data.anchors ?? []).map((a: any, i: number) => (
              <li key={i}>
                <b>{safeStr(a.id)}</b> — {safeStr(a.anchor_type)} — {safeStr(a.location)} — “
                {safeStr(a.evidence_snippet)}”
              </li>
            ))}
          </ul>

          <details style={{ marginTop: 16 }}>
            <summary>Voir JSON brut</summary>
            <pre style={{ whiteSpace: "pre-wrap", padding: 12, background: "#111", color: "#eee" }}>
              {JSON.stringify(data, null, 2)}
            </pre>
          </details>
        </div>
      )}
    </div>
  );
}

"use client";

import { useState } from "react";

type Output =
  | {
      type: "clarify";
      output_mode: "fiche" | "analyse_longue";
      clarification_questions: string[];
    }
  | any;

export default function CaseReaderPage() {
  const [caseText, setCaseText] = useState("");
  const [outputMode, setOutputMode] = useState<"fiche" | "analyse_longue">("analyse_longue");
  const [institutionSlug, setInstitutionSlug] = useState("udes");
  const [courseSlug, setCourseSlug] = useState("obligations-1");

  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<Output | null>(null);

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

  return (
    <div style={{ maxWidth: 980, margin: "0 auto", padding: 24 }}>
      <h1>Case Reader</h1>
      <p style={{ opacity: 0.8 }}>
        Colle un extrait (avec paragraphes si possible). Le système retournera une fiche ou une analyse longue.
      </p>

      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 12 }}>
        <label>
          Output&nbsp;
          <select value={outputMode} onChange={(e) => setOutputMode(e.target.value as any)}>
            <option value="analyse_longue">Analyse longue</option>
            <option value="fiche">Fiche (téléchargeable)</option>
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
      </div>

      <textarea
        value={caseText}
        onChange={(e) => setCaseText(e.target.value)}
        placeholder="Colle ici la décision ou un extrait..."
        style={{ width: "100%", minHeight: 220, padding: 12, fontFamily: "inherit" }}
      />

      <div style={{ marginTop: 12, display: "flex", gap: 12, alignItems: "center" }}>
        <button onClick={onGenerate} disabled={loading || caseText.trim().length === 0}>
          {loading ? "Génération..." : "Générer"}
        </button>
        {status !== null && <span style={{ opacity: 0.8 }}>STATUS: {status}</span>}
        {error && <span style={{ color: "crimson" }}>{error}</span>}
      </div>

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

      {data && data.type !== "clarify" && (
        <div>
          <h2>Résultat</h2>
          <pre style={{ whiteSpace: "pre-wrap", padding: 12, background: "#111", color: "#eee" }}>
            {JSON.stringify(data, null, 2)}
          </pre>

          {/* Prochaine étape: bouton Download (PDF/Docx) */}
          <p style={{ opacity: 0.8 }}>
            Prochaine étape : bouton “Télécharger la fiche” (PDF/Docx minimal).
          </p>
        </div>
      )}
    </div>
  );
}

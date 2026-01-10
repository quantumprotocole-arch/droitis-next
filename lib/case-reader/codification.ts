/* eslint-disable no-console */

import codificationMap from "@/data/codification-map.v2.json";

export type CodificationRecord = {
  decision: string;
  citation?: string;
  codification_articles?: string;
  recommended_mention?: string;
  principle?: string;

  // optionnels si tu les as dans ta table
  match_patterns?: string; // ex: "Kravitz|Kravitz c.|1990 QCCA"
  domain?: string;
  subdomain?: string;
};

export type CodificationMatch = {
  record: CodificationRecord;
  score: number;
  reason: "citation" | "decision_name" | "pattern";
  matched_value: string;
};

function stripAccents(input: string): string {
  // Compatible TS target ES5/ES6: pas de \p{Diacritic}, pas de flag 'u'
  // On tente normalize(NFKD) si dispo; sinon on retourne tel quel.
  try {
    const s =
      typeof (input as any).normalize === "function"
        ? input.normalize("NFKD")
        : input;
    // Retire les marques combinantes (accents) U+0300 à U+036F
    return s.replace(/[\u0300-\u036f]/g, "");
  } catch {
    return input;
  }
}

export function normalizeForMatch(input: string): string {
  const noAccents = stripAccents(input);
  return noAccents
    .toLowerCase()
    // Remplacer ponctuation par espaces
    .replace(/[^a-z0-9]+/g, " ")
    // Réduire espaces multiples
    .replace(/\s+/g, " ")
    .trim();
}

function includesLoose(haystackNorm: string, needleNorm: string): boolean {
  if (!needleNorm) return false;
  // seuil minimal pour éviter faux positifs
  if (needleNorm.length < 6) return false;
  return haystackNorm.includes(needleNorm);
}

function safeGetRecords(): CodificationRecord[] {
  const raw: any = codificationMap as any;
  if (Array.isArray(raw)) return raw as CodificationRecord[];
  if (Array.isArray(raw?.records)) return raw.records as CodificationRecord[];
  return [];
}

/**
 * Détecte si la décision analysée correspond à une entrée "codifiée".
 * Priorité:
 * 1) citation exacte (score élevé)
 * 2) patterns (score moyen)
 * 3) nom de décision (score moyen/faible)
 */
export function findBestCodificationMatch(caseText: string): CodificationMatch | null {
  if (!caseText || caseText.trim().length === 0) return null;

  const records = safeGetRecords();
  if (records.length === 0) return null;

  const textRaw = caseText;
  const textRawLower = textRaw.toLowerCase();
  const textNorm = normalizeForMatch(caseText);

  let best: CodificationMatch | null = null;

  for (const r of records) {
    if (!r || typeof r.decision !== "string") continue;

    // ---- 1) Citation match (fort) ----
    if (r.citation && typeof r.citation === "string") {
      const cit = r.citation.trim();
      if (cit.length > 0) {
        // match "raw" (pas normalisé) pour conserver formats du type "2007 CSC 34"
        if (textRawLower.includes(cit.toLowerCase())) {
          const m: CodificationMatch = {
            record: r,
            score: 100,
            reason: "citation",
            matched_value: cit,
          };
          if (!best || m.score > best.score) best = m;
          continue; // citation gagne quasi tout
        }
      }
    }

    // ---- 2) Pattern match (moyen) ----
    if (r.match_patterns && typeof r.match_patterns === "string") {
      const patterns = r.match_patterns
        .split("|")
        .map((p) => p.trim())
        .filter(Boolean);

      for (const p of patterns) {
        const pNorm = normalizeForMatch(p);
        if (includesLoose(textNorm, pNorm)) {
          const m: CodificationMatch = {
            record: r,
            score: 80,
            reason: "pattern",
            matched_value: p,
          };
          if (!best || m.score > best.score) best = m;
          break;
        }
      }
    }

    // ---- 3) Decision name match (moyen/faible) ----
    const decisionNorm = normalizeForMatch(r.decision);
    if (includesLoose(textNorm, decisionNorm)) {
      const m: CodificationMatch = {
        record: r,
        score: 70,
        reason: "decision_name",
        matched_value: r.decision,
      };
      if (!best || m.score > best.score) best = m;
    }
  }

  // Seuil anti-faux positifs:
  // - citation: 100
  // - pattern: 80
  // - nom: 70 (mais seulement si needle >= 6 déjà contrôlé)
  if (!best) return null;

  // Option: si match uniquement par nom, on peut exiger un minimum un peu plus strict
  if (best.reason === "decision_name" && best.matched_value.length < 10) {
    return null;
  }

  return best;
}

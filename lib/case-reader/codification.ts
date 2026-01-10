import fs from "node:fs";
import path from "node:path";

export type CodificationRecord = {
  domain: string;
  theme: string;
  decision: string;
  citation: string;
  tribunal: string;
  jurisdiction: string;
  codification_articles: string;
  principle: string;
  recommended_mention: string;
  match_patterns_norm: string[];
};

type CodificationDb = { version: string; records: CodificationRecord[] };

let _db: CodificationDb | null = null;

function stripAccents(input: string): string {
  // Basic accent stripping without external deps
  return input.normalize("NFKD").replace(/\p{Diacritic}/gu, "");
}

export function normalizeForMatch(input: string): string {
  const s = stripAccents(String(input ?? "")).toLowerCase();
  return s.replace(/\s+/g, " ").trim();
}

export function loadCodificationDb(): CodificationDb {
  if (_db) return _db;
  const p = path.join(process.cwd(), "data", "codification-map.v2.json");
  const raw = fs.readFileSync(p, "utf-8");
  _db = JSON.parse(raw) as CodificationDb;
  return _db!;
}

export type CodificationMatch = {
  record: CodificationRecord;
  score: number;
  matched_on: "citation" | "decision";
};

export function findBestCodificationMatch(caseText: string): CodificationMatch | null {
  const textNorm = normalizeForMatch(caseText);
  if (!textNorm || textNorm.length < 80) return null;

  const db = loadCodificationDb();
  let best: CodificationMatch | null = null;

  for (const r of db.records) {
    // score rules:
    // - citation match: +3 (strong)
    // - decision name match: +1 (weak)
    let score = 0;
    let matched_on: CodificationMatch["matched_on"] | null = null;

    const citationNorm = normalizeForMatch(r.citation);
    if (citationNorm && textNorm.includes(citationNorm)) {
      score += 3;
      matched_on = "citation";
    }

    const decisionNorm = normalizeForMatch(r.decision);
    if (decisionNorm && textNorm.includes(decisionNorm)) {
      score += 1;
      matched_on = matched_on ?? "decision";
    }

    if (score <= 0) continue;

    if (!best || score > best.score) {
      best = { record: r, score, matched_on: matched_on ?? "decision" };
    }
  }

  return best;
}

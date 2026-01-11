/* eslint-disable no-console */
import fs from "node:fs";
import path from "node:path";

export type CodificationRow = {
  Domaine?: string;
  "Thème_canonique_suggéré"?: string;
  "Décision"?: string;
  Citation?: string;
  Tribunal?: string;
  Juridiction_applicable?: string;
  Dispositions_codification_ancrage?: string;
  Principe_ciblé_pour_la_fiche?: string;
  Mention_Droitis_recommandée?: string;
};

type CodificationIndex = {
  rows: CodificationRow[];
  byCitation: Map<string, CodificationRow[]>;
  byDecisionName: Map<string, CodificationRow[]>;
};

let CACHE: CodificationIndex | null = null;

const CSV_RELATIVE_PATH = path.join("data", "case-reader", "Droitis_Codification_Jurisprudence_Map_v4.csv");

function isProbablyUrl(s: string): boolean {
  return /(https?:\/\/|www\.)/i.test(s);
}

function redactUrls(s: string): string {
  if (!s) return s;
  return s.replace(/https?:\/\/\S+|www\.\S+/gi, "[LIEN SUPPRIMÉ]");
}

export function normalizeKey(input: string): string {
  const s = String(input ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/['’]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  // Keep only alnum and spaces, collapse spaces
  return s.replace(/[^A-Z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}

// Minimal CSV parser (handles quotes + commas + CRLF)
function parseCsv(text: string): Array<Record<string, string>> {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let i = 0;
  let inQuotes = false;

  const pushField = () => {
    row.push(field);
    field = "";
  };
  const pushRow = () => {
    // Ignore trailing empty line
    if (row.length === 1 && row[0] === "" && rows.length === 0) return;
    rows.push(row);
    row = [];
  };

  while (i < text.length) {
    const c = text[i];

    if (inQuotes) {
      if (c === '"') {
        const next = text[i + 1];
        if (next === '"') {
          field += '"';
          i += 2;
          continue;
        } else {
          inQuotes = false;
          i += 1;
          continue;
        }
      } else {
        field += c;
        i += 1;
        continue;
      }
    }

    if (c === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }

    if (c === ",") {
      pushField();
      i += 1;
      continue;
    }

    if (c === "\r") {
      // CRLF
      if (text[i + 1] === "\n") i += 2;
      else i += 1;
      pushField();
      pushRow();
      continue;
    }

    if (c === "\n") {
      i += 1;
      pushField();
      pushRow();
      continue;
    }

    field += c;
    i += 1;
  }

  // last field/row
  pushField();
  pushRow();

  const [header, ...data] = rows;
  const keys = (header ?? []).map((k) => k.trim());

  return data
    .filter((r) => r.some((x) => String(x ?? "").trim().length > 0))
    .map((r) => {
      const obj: Record<string, string> = {};
      for (let j = 0; j < keys.length; j++) obj[keys[j]] = String(r[j] ?? "").trim();
      return obj;
    });
}

function loadIndex(): CodificationIndex {
  if (CACHE) return CACHE;

  const csvPath = path.join(process.cwd(), CSV_RELATIVE_PATH);
  const raw = fs.readFileSync(csvPath, "utf-8");

  const recs = parseCsv(raw);
  const rows: CodificationRow[] = recs.map((r) => r as any);

  const byCitation = new Map<string, CodificationRow[]>();
  const byDecisionName = new Map<string, CodificationRow[]>();

  for (const row of rows) {
    const cit = String((row as any).Citation ?? "").trim();
    const dec = String((row as any)["Décision"] ?? "").trim();

    const citKey = cit ? normalizeKey(cit) : "";
    const decKey = dec ? normalizeKey(dec) : "";

    if (citKey) byCitation.set(citKey, [...(byCitation.get(citKey) ?? []), row]);
    if (decKey) byDecisionName.set(decKey, [...(byDecisionName.get(decKey) ?? []), row]);
  }

  CACHE = { rows, byCitation, byDecisionName };
  return CACHE;
}

function pickBest(rows: CodificationRow[]): CodificationRow | null {
  if (!rows || rows.length === 0) return null;
  // Prefer rows with a non-empty mention
  const withMention = rows.find((r) => String(r.Mention_Droitis_recommandée ?? "").trim().length > 0);
  return withMention ?? rows[0];
}

export function extractNeutralCitationsFromText(caseText: string): string[] {
  const text = String(caseText ?? "");
  const head = text.slice(0, 6000);

  const out = new Set<string>();

  // Typical neutral citations: 2007 CSC 34 / 2018 QCCA 123 / 2021 QCCS 999 / 2010 SCC 12
  const re1 = /\b(19|20)\d{2}\s+(CSC|SCC|QCCA|QCCS|QCTAT|QCTAQ|QCCQ|QCTDP|QCTMF|QCTP|FC|FCA|ONCA|ONSC|BCCA|BCSC|ABCA|ABQB|MBCA|NBCA|NSCA|NLCA|SKCA|YKCA|NWTCA|PECA)\s+\d+\b/g;
  let m: RegExpExecArray | null;
  while ((m = re1.exec(head)) !== null) out.add(m[0]);

  // Bracket citations: [1979] 1 RCS 790 / [1979] 1 SCR 790
  const re2 = /\[(19|20)\d{2}\]\s+\d+\s+(RCS|SCR)\s+\d+\b/g;
  while ((m = re2.exec(head)) !== null) out.add(m[0]);

  return Array.from(out);
}

export function findCodificationMatch(args: {
  caseNameHint?: string;
  citationHint?: string;
  caseText?: string;
}): CodificationRow | null {
  const idx = loadIndex();

  const citationHint = String(args.citationHint ?? "").trim();
  if (citationHint) {
    const key = normalizeKey(citationHint);
    const rows = idx.byCitation.get(key);
    const best = rows ? pickBest(rows) : null;
    if (best) return best;
  }

  const caseNameHint = String(args.caseNameHint ?? "").trim();
  if (caseNameHint) {
    const key = normalizeKey(caseNameHint);
    const rows = idx.byDecisionName.get(key);
    const best = rows ? pickBest(rows) : null;
    if (best) return best;
  }

  const text = String(args.caseText ?? "");
  if (text) {
    for (const cit of extractNeutralCitationsFromText(text)) {
      const key = normalizeKey(cit);
      const rows = idx.byCitation.get(key);
      const best = rows ? pickBest(rows) : null;
      if (best) return best;
    }
    // Light case-name heuristic: look for lines like "X c. Y" in first 20 lines
    const firstLines = text.split(/\r?\n/).slice(0, 25).join("\n");
    const m = firstLines.match(/([A-Za-zÀ-ÿ0-9][^\n]{3,120}?\s+(c\.|v\.)\s+[A-Za-zÀ-ÿ0-9][^\n]{3,120})/i);
    if (m?.[1]) {
      const key = normalizeKey(m[1]);
      const rows = idx.byDecisionName.get(key);
      const best = rows ? pickBest(rows) : null;
      if (best) return best;
    }
  }

  return null;
}

export function buildCodificationPromptBlock(row: CodificationRow): string {
  // No URLs, no anchors.
  const mention = redactUrls(String(row.Mention_Droitis_recommandée ?? "").trim());
  const dispo = redactUrls(String(row.Dispositions_codification_ancrage ?? "").trim());
  const principe = redactUrls(String(row.Principe_ciblé_pour_la_fiche ?? "").trim());
  const theme = redactUrls(String((row as any)["Thème_canonique_suggéré"] ?? "").trim());

  const lines: string[] = [];
  lines.push("INFO EXTERNE (CSV CODIFICATION) — À NE PAS ANCRER:");
  lines.push("- Cette décision apparaît comme 'codifiée' dans un CSV interne de codification (info externe au jugement).");
  if (theme) lines.push(`- Thème suggéré (CSV): ${theme}`);
  if (principe) lines.push(`- Principe ciblé (CSV): ${principe}`);
  if (dispo) lines.push(`- Dispositions associées (CSV): ${dispo}`);
  if (mention) lines.push(`- Mention recommandée (CSV): ${mention}`);

  lines.push("");
  lines.push("INSTRUCTIONS:");
  lines.push("- Tu DOIS mentionner cette codification dans la fiche comme info externe, étiquetée exactement: 'Codification (info externe CSV): ...'.");
  lines.push("- Place la mention DANS scope_for_course.what_it_changes (et/ou un takeaway), MAIS JAMAIS dans anchors[].");
  lines.push("- En examen: prioriser le texte législatif (dispositions) et mentionner l’origine jurisprudentielle seulement si utile.");
  return lines.join("\n");
}

export function renderCodificationNotice(row: CodificationRow): string {
  const mention = String(row.Mention_Droitis_recommandée ?? "").trim();
  const dispo = String(row.Dispositions_codification_ancrage ?? "").trim();
  const principe = String(row.Principe_ciblé_pour_la_fiche ?? "").trim();

  // Keep it short; URLs will be redacted later anyway.
  const parts: string[] = [];
  if (principe) parts.push(principe);
  if (dispo) parts.push(`Dispositions: ${dispo}`);
  if (mention && mention !== principe) parts.push(mention);

  const msg = parts.join(" — ").trim();
  return redactUrls(msg);
}

export function injectCodificationNoticeIntoAnswer(answer: any, row: CodificationRow) {
  if (!answer || typeof answer !== "object") return;
  if (answer.type !== "answer") return;

  const notice = `Codification (info externe CSV): ${renderCodificationNotice(row)}`.trim();

  // 1) Try scope_for_course.what_it_changes
  if (answer.scope_for_course && typeof answer.scope_for_course === "object") {
    const cur = String(answer.scope_for_course.what_it_changes ?? "").trim();
    const lower = cur.toLowerCase();
    if (!lower.includes("codification (info externe csv)")) {
      let next = cur ? `${cur}\n\n${notice}` : notice;
      // respect maxLength 900 (schema)
      if (next.length > 900) {
        // keep beginning + append truncated notice
        const headMax = Math.max(0, 900 - (notice.length + 2));
        const head = (cur || "").slice(0, headMax).trimEnd();
        const truncatedNotice = notice.slice(0, Math.min(notice.length, 900 - (head.length ? head.length + 2 : 0)));
        next = head ? `${head}\n\n${truncatedNotice}` : truncatedNotice;
      }
      answer.scope_for_course.what_it_changes = next;
      return;
    }
  }

  // 2) Fallback: push into takeaways if possible
  if (Array.isArray(answer.takeaways)) {
    const exists = answer.takeaways.some((t: any) =>
      String(t ?? "").toLowerCase().includes("codification (info externe csv)")
    );
    if (!exists) answer.takeaways.push(notice.slice(0, 220));
  }
}

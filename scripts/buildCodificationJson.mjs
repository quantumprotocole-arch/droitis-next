
/**
 * Build data/codification-map.v2.json from one or more CSV mapping files.
 * No external deps (simple CSV parser with quoted fields).
 *
 * Usage:
 *   node scripts/buildCodificationJson.mjs ./Droitis_Codification_Jurisprudence_Map_v2.csv
 *   node scripts/buildCodificationJson.mjs ./table1.csv ./table2.csv
 */
import fs from "node:fs";
import path from "node:path";

function stripAccents(s) {
  return String(s ?? "")
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "");
}

function normalizeForMatch(s) {
  return stripAccents(s).toLowerCase().replace(/\s+/g, " ").trim();
}

function parseCsv(raw) {
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];

    if (inQuotes) {
      if (ch === '"') {
        const next = raw[i + 1];
        if (next === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      continue;
    }

    if (ch === ",") {
      row.push(cell);
      cell = "";
      continue;
    }

    if (ch === "\n") {
      row.push(cell);
      cell = "";
      // ignore empty last line
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
      continue;
    }

    if (ch === "\r") continue;

    cell += ch;
  }

  // flush
  if (cell.length || row.length) {
    row.push(cell);
    rows.push(row);
  }

  return rows;
}

function toRecords(objects) {
  const out = [];
  for (const r of objects) {
    const decision = String(r["Décision"] ?? "").trim();
    const citation = String(r["Citation"] ?? "").trim();
    if (!decision && !citation) continue;

    const rec = {
      domain: String(r["Domaine"] ?? "").trim(),
      theme: String(r["Thème_canonique_suggéré"] ?? "").trim(),
      decision,
      citation,
      tribunal: String(r["Tribunal"] ?? "").trim(),
      jurisdiction: String(r["Juridiction_applicable"] ?? "").trim(),
      codification_articles: String(r["Dispositions_codification_ancrage"] ?? "").trim(),
      principle: String(r["Principe_ciblé_pour_la_fiche"] ?? "").trim(),
      recommended_mention: String(r["Mention_Droitis_recommandée"] ?? "").trim(),
    };

    const patterns = new Set();
    if (decision) {
      patterns.add(decision);
      patterns.add(stripAccents(decision));
      patterns.add(decision.replace(" c. ", " c "));
      patterns.add(stripAccents(decision.replace(" c. ", " c ")));
    }
    if (citation) {
      patterns.add(citation);
      patterns.add(stripAccents(citation));
      patterns.add(citation.replace(/\s+/g, " "));
    }

    rec.match_patterns_norm = Array.from(patterns)
      .filter(Boolean)
      .map((x) => normalizeForMatch(x));

    out.push(rec);
  }
  return out;
}

function dedupe(records) {
  const seen = new Set();
  const out = [];
  for (const r of records) {
    const k = `${normalizeForMatch(r.decision)}||${normalizeForMatch(r.citation)}||${normalizeForMatch(r.domain)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}

const inputs = process.argv.slice(2);
if (!inputs.length) {
  console.error("Missing CSV file path(s).");
  process.exit(1);
}

let combined = [];

for (const p of inputs) {
  const abs = path.resolve(p);
  const raw = fs.readFileSync(abs, "utf-8");
  const rows = parseCsv(raw);
  const header = rows[0];
  const objects = rows.slice(1).map((r) => {
    const o = {};
    for (let i = 0; i < header.length; i++) o[header[i]] = r[i] ?? "";
    return o;
  });
  combined = combined.concat(toRecords(objects));
}

combined = dedupe(combined);

const outPath = path.join(process.cwd(), "data", "codification-map.v2.json");
fs.writeFileSync(outPath, JSON.stringify({ version: "v2", generated_at: new Date().toISOString(), records: combined }, null, 2), "utf-8");

console.log(`Wrote ${combined.length} records -> ${outPath}`);

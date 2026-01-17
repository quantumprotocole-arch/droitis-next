/* eslint-disable no-console */
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("Missing env: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const headers = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  "Content-Type": "application/json",
  Prefer: "count=exact",
};

function norm(x) {
  return String(x ?? "").trim().toLowerCase();
}

async function getJson(path) {
  const url = `${SUPABASE_URL}${path}`;
  const res = await fetch(url, { headers });
  const text = await res.text();
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status}: ${text}`);
  return JSON.parse(text);
}

async function countLegalVectorsByCodeId(codeId) {
  // Fast existence: limit=1, but we also want count
  const q = `/rest/v1/legal_vectors?select=id&code_id=eq.${encodeURIComponent(codeId)}&limit=1`;
  const res = await fetch(`${SUPABASE_URL}${q}`, { headers });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`count legal_vectors failed for ${codeId}: ${res.status} ${t}`);
  }
  const count = Number(res.headers.get("content-range")?.split("/")?.[1] ?? "0");
  return count;
}

async function main() {
  const failures = [];

  // 1) Pull all law_registry mapped ingested>0
  const lawRegistry = await getJson(
    `/rest/v1/law_registry?select=law_key,canonical_code_id,ingested_articles,status&order=ingested_articles.desc.nullslast`
  );

  // 2) Pull all code_aliases
  const codeAliases = await getJson(`/rest/v1/code_aliases?select=canonical_code,aliases`);

  const aliasMap = new Map(); // canonical -> Set(code_ids)
  for (const r of codeAliases) {
    const c = norm(r.canonical_code);
    if (!c) continue;
    const set = aliasMap.get(c) ?? new Set();
    set.add(c);
    for (const a of r.aliases ?? []) set.add(norm(a));
    aliasMap.set(c, set);
  }

  // 3) Check: every ingested law has a canonical_code_id that exists in code_aliases OR exists as code_id in legal_vectors
  for (const lr of lawRegistry) {
    const cnt = Number(lr.ingested_articles ?? 0);
    const status = norm(lr.status);
    const canonical = norm(lr.canonical_code_id);

    if (cnt <= 0) continue; // not ingested
    if (!canonical) {
      failures.push({ type: "MISSING_CANONICAL_IN_REGISTRY", law_key: lr.law_key });
      continue;
    }

    const aliases = aliasMap.get(canonical);
    let ok = false;

    if (aliases && aliases.size) {
      // Check existence for canonical itself first (fast path)
      const canonicalCount = await countLegalVectorsByCodeId(lr.canonical_code_id);
      if (canonicalCount > 0) ok = true;

      if (!ok) {
        // Try aliases (limit attempts)
        let tries = 0;
        for (const a of aliases) {
          if (tries++ > 8) break;
          const c = await countLegalVectorsByCodeId(a);
          if (c > 0) {
            ok = true;
            break;
          }
        }
      }
    } else {
      // No alias row: at least canonical should exist in legal_vectors
      const canonicalCount = await countLegalVectorsByCodeId(lr.canonical_code_id);
      if (canonicalCount > 0) ok = true;
    }

    if (!ok) {
      failures.push({
        type: "CANONICAL_OR_ALIASES_NOT_IN_LEGAL_VECTORS",
        law_key: lr.law_key,
        canonical_code_id: lr.canonical_code_id,
        ingested_articles: cnt,
        status,
      });
    }
  }

  // 4) A-25 specific smoke
  const a25 = await countLegalVectorsByCodeId("A-25").catch(() => 0);
  if (a25 <= 0) {
    failures.push({ type: "A25_NOT_FOUND_IN_LEGAL_VECTORS", details: "Expected code_id=A-25 to exist" });
  }

  // Print report
  if (failures.length) {
    console.error("\n❌ QA FAILURES:");
    for (const f of failures) console.error("-", JSON.stringify(f));
    process.exit(2);
  } else {
    console.log("✅ QA OK: mappings + aliases + legal_vectors presence look consistent.");
  }
}

main().catch((e) => {
  console.error("QA script error:", e);
  process.exit(1);
});

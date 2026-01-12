/* eslint-disable no-console */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";

const { OPENAI_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;

if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY manquant");
if (!SUPABASE_URL) throw new Error("SUPABASE_URL manquant");
if (!SUPABASE_SERVICE_ROLE_KEY) throw new Error("SUPABASE_SERVICE_ROLE_KEY manquant");

async function createEmbedding(input) {
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "text-embedding-3-small", input }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Embeddings error ${res.status}: ${t}`);
  }
  const data = await res.json();
  return data?.data?.[0]?.embedding;
}

async function supaUpsertKernels(rows) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/course_kernels?on_conflict=id`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=representation",
    },
    body: JSON.stringify(rows),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Supabase upsert failed ${res.status}: ${t}`);
  }
  return await res.json();
}

function assert1536(vec) {
  if (!Array.isArray(vec) || vec.length !== 1536) {
    throw new Error(`Embedding dimension inattendue: ${Array.isArray(vec) ? vec.length : typeof vec} (attendu 1536)`);
  }
}

async function main() {
  const file = process.argv[2] || "kernels.seed.json";
  const p = path.resolve(process.cwd(), file);
  const raw = fs.readFileSync(p, "utf-8");
  const seed = JSON.parse(raw);

  const items = seed?.kernels ?? [];
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error("kernels.seed.json invalide: attendu { kernels: [...] }");
  }

  const prepared = [];
  for (const k of items) {
    const course_slug = String(k.course_slug || "").trim();
    const topic = String(k.topic || "").trim();
    const content = String(k.content || "").trim();

    if (!course_slug || !topic || !content) {
      console.warn("SKIP kernel (missing fields):", k);
      continue;
    }

    const emb = await createEmbedding(`${topic}\n\n${content}`);
    assert1536(emb);

    prepared.push({
      course_slug,
      topic,
      content,
      source: "internal",
      embedding: emb,
    });
  }

  console.log(`Upserting ${prepared.length} kernels...`);
  const out = await supaUpsertKernels(prepared);
  console.log("Done. Inserted/merged:", out.length);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

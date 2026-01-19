/* eslint-disable no-console */
import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";

dotenv.config({ path: [".env.local", ".env"] });


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
  const res = await fetch(`${SUPABASE_URL}/rest/v1/course_kernels?on_conflict=course_slug,topic`, {
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
async function supaUpsertCourseCatalog(rows) {
  // Ensure course slugs exist before inserting kernels (FK safety).
  // We ignore duplicates to avoid overwriting curated titles/metadata.
  const res = await fetch(`${SUPABASE_URL}/rest/v1/course_catalog?on_conflict=course_slug`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "resolution=ignore-duplicates,return=representation",
    },
    body: JSON.stringify(rows),
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Supabase upsert course_catalog failed ${res.status}: ${t}`);
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
    // --- FK safety: make sure all course slugs exist in course_catalog before upserting kernels ---
  const slugs = Array.from(
    new Set(
      items
        .map((it) => (typeof it?.course_slug === "string" ? it.course_slug.trim() : ""))
        .filter(Boolean)
    )
  );

  // Always ensure the default "general" course exists (even if not present in the seed file).
  if (!slugs.includes("general")) slugs.unshift("general");

  const courseRows = slugs.map((slug) => ({
    course_slug: slug,
    course_title: slug === "general" ? "Général (non mappé)" : slug,
    scope: "all",
    institution_note:
      slug === "general"
        ? "Mode général : explications et méthode, moins ciblé qu’un cours précis."
        : null,
    tags: slug === "general" ? ["general", "default"] : [],
  }));

  console.log(`Ensuring ${courseRows.length} course slugs exist in course_catalog...`);
  await supaUpsertCourseCatalog(courseRows);
  // --- end FK safety block ---


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

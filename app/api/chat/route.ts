import { NextResponse } from "next/server";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

/**
 * Phase 4B — Droitis (Next.js 14)
 * - Jurisdiction Gate (1 question si ambigu + pièges)
 * - Retrieval en passes QC → CA-FED → OTHER
 * - Hybrid search keyword + vector + fusion RRF + dédup
 * - rag_quality 0–3 + seuils répondre/clarifier/refuser
 * - Anti-hallucination strict: citations seulement via allowlist + post-check serveur
 * - Logs QA: had_qc_source, jurisdiction_selected, rag_quality, article_confidence, refused_reason
 *
 * Spécifications:
 * - Route: /app/api/chat/route.ts:contentReference[oaicite:6]{index=6}
 * - RPC PROD stable: search_legal_vectors_v2(query_embedding vector, match_count int default 6):contentReference[oaicite:7]{index=7}
 * - Similarity calc (cosine <=>) côté DB:contentReference[oaicite:8]{index=8}
 * - Prompt verrouillé + allowlist + post-check serveur:contentReference[oaicite:9]{index=9}:contentReference[oaicite:10]{index=10}
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Jurisdiction = "QC" | "CA-FED" | "OTHER" | "UNKNOWN";

type EnrichedRow = {
  id: number;
  code_id: string | null;
  citation: string | null;
  title: string | null;
  text: string | null;
  jurisdiction_norm: string | null;
  code_id_struct: string | null;
  article_num: string | null;
  url_struct: string | null;
};

type VectorHit = {
  id: number;
  code_id: string | null;
  jurisdiction: string | null;
  citation: string | null;
  title: string | null;
  text: string | null;
  similarity: number | null;
};

type SourceOut = {
  id: number;
  citation: string;
  jurisdiction_norm: Jurisdiction | "OTHER";
  url_struct?: string | null;
  excerpt: string;
};

type RetrievalOut = {
  jurisdiction_expected: Jurisdiction;
  jurisdiction_selected: Jurisdiction;
  sources: SourceOut[];
  allowed_citations: string[];
  used_hybrid: boolean;
  had_qc_source: boolean;
  rag_quality: 0 | 1 | 2 | 3;
  article_confidence: number; // 0..1
  refused_reason?: string;
  debug?: any;
};

type ModelJson = {
  type: "answer" | "clarify" | "refuse";
  jurisdiction: "QC" | "CA-FED" | "OTHER" | "UNKNOWN";
  ilac?: {
    probleme: string;
    regle: string;
    application: string;
    conclusion: string;
  };
  clarification_question?: string;
  refusal_reason?: string;
  ingest_needed?: string[];
  citations_used?: string[];
  warning?: string;
};

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const POLICY_VERSION = "v1.0"; // versioning per policy:contentReference[oaicite:11]{index=11}

// ===== Policy “verrouillé” (texte exact) =====:contentReference[oaicite:12]{index=12}
const SYSTEM_PROMPT = `Tu es Droitis, tuteur IA spécialisé en droit québécois (QC).
Tu réponds en ILAC/IRAC : Problème → Règle → Application → Conclusion.
Interdiction absolue : inventer une loi, un article, une décision, une citation, ou un lien.
Tu ne cites QUE ce qui est présent dans sources[] et dans l’allowlist fournie.
Si une information n’est pas disponible dans les sources : tu dois le dire et expliquer quoi ingérer.
Tu dois annoncer la juridiction applicable avant d’énoncer la règle.
Si la juridiction est incertaine, tu poses 1 question de clarification avant de répondre.`;

const CORPUS_MISS_TEMPLATE =
  "Information non disponible dans le corpus actuel. Pour répondre avec certitude, il faut ingérer : ";

// ===== Jurisdiction heuristics (min) =====:contentReference[oaicite:13]{index=13}
function detectJurisdictionExpected(q: string): Jurisdiction {
  const s = q.toLowerCase();

  const qcSignals = [
    "c.c.q",
    "ccq",
    "code civil du québec",
    "charte québécoise",
    "québec",
    "quebec",
    "loi du québec",
    "cpc",
    "code de procédure civile",
    "legisquebec",
    "légisquébec",
  ];

  const fedSignals = [
    "code canadien du travail",
    "charte canadienne",
    "loi fédérale",
    "loi federale",
    "canada labour code",
    "code criminel",
    "criminal code",
  ];

  for (let i = 0; i < qcSignals.length; i++) if (s.includes(qcSignals[i])) return "QC";
  for (let i = 0; i < fedSignals.length; i++) if (s.includes(fedSignals[i])) return "CA-FED";

  const otherSignals = ["ontario", "alberta", "colombie-britannique", "british columbia"];
  for (let i = 0; i < otherSignals.length; i++) if (s.includes(otherSignals[i])) return "OTHER";

  return "UNKNOWN";
}

// Pièges juridictionnels (seed minimal):contentReference[oaicite:14]{index=14}
function isJurisdictionTrap(q: string): boolean {
  const s = q.toLowerCase();
  const trap = [
    "droit du travail",
    "emploi",
    "relations de travail",
    "banque",
    "banques",
    "télécom",
    "telecom",
    "radiodiffusion",
    "aviation",
    "transport interprovincial",
    "transport aérien",
    "pipeline",
    "maritime",
    "ferroviaire",
  ];
  for (let i = 0; i < trap.length; i++) if (s.includes(trap[i])) return true;
  return false;
}

// 1 question max si ambigu (Policy):contentReference[oaicite:15]{index=15}
function buildClarificationQuestion(q: string): string {
  const s = q.toLowerCase();
  if (s.includes("travail") || s.includes("emploi")) {
    return "Avant de répondre : est-ce que ton cas concerne un employeur de compétence fédérale (ex. banque, télécom, transport interprovincial/aviation) ou un employeur de compétence provinciale (Québec) ?";
  }
  return "Avant de répondre : quelle juridiction veux-tu appliquer (Québec, fédéral canadien, ou autre province/pays) ?";
}

// ===== Keyword extraction (sans \p{...}) =====
const STOPWORDS_FR = new Set([
  "alors","aucun","avec","dans","donc","elle","elles","enfin","entre","être","mais","même","pour",
  "sans","sera","sont","tout","toute","tous","vous","votre","vos","leur","leurs",
  "le","la","les","un","une","des","de","du","au","aux","et","ou","dans","sur","par",
  "que","qui","quoi","dont","est","sont","etre","a","à","en","se","sa","son","ses","ce","cet","cette","ces"
]);

function extractKeywords(q: string, max = 6): string[] {
  // Regex compatible sans Unicode property escapes
  const cleaned = q
    .toLowerCase()
    .replace(/[^a-z0-9à-öø-ÿ\s.-]/gi, " ") // lettres latines + accents (Latin-1)
    .replace(/\s+/g, " ")
    .trim();

  const parts = cleaned.split(" ");
  const uniq: string[] = [];

  for (let i = 0; i < parts.length; i++) {
    const t = parts[i].trim();
    if (!t) continue;
    if (t.length < 4) continue;
    if (STOPWORDS_FR.has(t)) continue;
    if (uniq.indexOf(t) !== -1) continue;
    uniq.push(t);
    if (uniq.length >= max) break;
  }

  return uniq;
}

function detectArticleMention(q: string): { mentioned: boolean; nums: string[] } {
  const s = q.toLowerCase();
  const nums: string[] = [];
  const re = /\b(?:art\.?|article)\s+([0-9]{1,5})\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) nums.push(m[1]);
  return { mentioned: nums.length > 0, nums };
}

// ===== RRF =====:contentReference[oaicite:16]{index=16}
function rrfScore(rank: number, k = 60): number {
  return 1 / (k + rank);
}

function makeExcerpt(text: string, maxLen = 900): string {
  const t = (text || "").replace(/\s+/g, " ").trim();
  if (t.length <= maxLen) return t;
  return t.slice(0, maxLen) + "…";
}

// ===== Supabase helpers =====
async function embedQuery(q: string): Promise<number[]> {
  const emb = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: q,
  });
  return emb.data[0].embedding as unknown as number[];
}

async function vectorSearch(qEmbedding: number[], matchCount: number): Promise<VectorHit[]> {
  const { data, error } = await supabase.rpc("search_legal_vectors_v2", {
    query_embedding: qEmbedding,
    match_count: matchCount,
  });

  if (error) throw new Error(`RPC search_legal_vectors_v2 failed: ${error.message}`);
  return (data ?? []) as VectorHit[];
}

async function enrichByIds(ids: number[]): Promise<Map<number, EnrichedRow>> {
  const map = new Map<number, EnrichedRow>();
  if (!ids.length) return map;

  const { data, error } = await supabase
    .from("legal_vectors_enriched")
    .select(
      "id,code_id,citation,title,text,jurisdiction_norm,code_id_struct,article_num,url_struct"
    )
    .in("id", ids);

  if (error) throw new Error(`Fetch legal_vectors_enriched failed: ${error.message}`);
  const rows = (data ?? []) as EnrichedRow[];
  for (let i = 0; i < rows.length; i++) map.set(rows[i].id, rows[i]);
  return map;
}

/**
 * Keyword search fallback (ILIKE).
 * Phase 4B veut FTS Postgres, mais ce fallback garde le “hybrid keyword+vector” côté app. :contentReference[oaicite:17]{index=17}
 */
async function keywordSearchFallback(
  jurisdiction: Jurisdiction,
  keywords: string[],
  limit = 24
): Promise<EnrichedRow[]> {
  let q = supabase
    .from("legal_vectors_enriched")
    .select(
      "id,code_id,citation,title,text,jurisdiction_norm,code_id_struct,article_num,url_struct"
    )
    .limit(limit);

  if (jurisdiction !== "UNKNOWN") {
    q = q.eq("jurisdiction_norm", jurisdiction);
  }

  const ors: string[] = [];
  for (let i = 0; i < keywords.length; i++) {
    const safe = keywords[i].replace(/[%_]/g, "");
    ors.push(`citation.ilike.%${safe}%`);
    ors.push(`title.ilike.%${safe}%`);
    ors.push(`text.ilike.%${safe}%`);
  }
  if (ors.length) q = q.or(ors.join(","));

  const { data, error } = await q;
  if (error) throw new Error(`Keyword search fallback failed: ${error.message}`);
  return (data ?? []) as EnrichedRow[];
}

// ===== Dedup key =====:contentReference[oaicite:18]{index=18}
function dedupKey(r: EnrichedRow): string {
  if (r.code_id_struct && r.article_num) return `${r.code_id_struct}::${r.article_num}`;
  if (r.citation) return `CIT::${r.citation}`;
  return `ID::${r.id}`;
}

// ===== Hit scoring =====:contentReference[oaicite:19]{index=19}
function scoreHit(args: {
  row: EnrichedRow;
  expected: Jurisdiction;
  keywords: string[];
  article: { mentioned: boolean; nums: string[] };
  similarity?: number | null;
}): { hit_quality_score: number; article_conf: number } {
  const { row, expected, keywords, article, similarity } = args;

  let score = 0;
  const jur = (row.jurisdiction_norm as Jurisdiction | null) ?? "OTHER";
  const jurMatch = expected === "UNKNOWN" ? true : jur === expected;

  if (expected === "UNKNOWN") score += 0.3;
  else if (jurMatch) score += 1.0;
  else score -= 0.8;

  let articleConf = 0.5;
  if (article.mentioned) {
    articleConf = 0.2;
    if (row.article_num && article.nums.indexOf(row.article_num) !== -1) {
      score += 0.8;
      articleConf = 1.0;
    }
  }

  const hay = `${row.citation ?? ""} ${row.title ?? ""} ${row.text ?? ""}`.toLowerCase();
  let overlap = 0;
  for (let i = 0; i < keywords.length; i++) if (hay.includes(keywords[i])) overlap++;

  if (overlap >= 1) score += 0.2;
  if (overlap >= 2) score += 0.4;
  if (overlap >= 3) score += 0.6;

  if (typeof similarity === "number") {
    if (similarity >= 0.78) score += 0.4;
    else if (similarity >= 0.72) score += 0.2;
  }

  return { hit_quality_score: score, article_conf: articleConf };
}

async function hybridPass(args: {
  passJurisdiction: Jurisdiction;
  expected: Jurisdiction;
  embedding: number[];
  keywords: string[];
  article: { mentioned: boolean; nums: string[] };
  vectorN: number;
  keywordN: number;
}): Promise<{ rows: EnrichedRow[]; used_hybrid: boolean; debug: any }> {
  const { passJurisdiction, expected, embedding, keywords, article, vectorN, keywordN } = args;

  // 1) Vector
  const vHits = await vectorSearch(embedding, vectorN);
  const vIds: number[] = [];
  for (let i = 0; i < vHits.length; i++) vIds.push(vHits[i].id);

  const vEnriched = await enrichByIds(vIds);

  const vList: { row: EnrichedRow; similarity: number | null }[] = [];
  for (let i = 0; i < vHits.length; i++) {
    const h = vHits[i];
    const r = vEnriched.get(h.id);
    if (!r) continue;
    const jur = (r.jurisdiction_norm as Jurisdiction | null) ?? "OTHER";
    if (passJurisdiction !== "UNKNOWN" && jur !== passJurisdiction) continue;
    vList.push({ row: r, similarity: h.similarity ?? null });
    if (vList.length >= vectorN) break;
  }

  // 2) Keyword
  const kRows = await keywordSearchFallback(passJurisdiction, keywords, keywordN);

  // 3) RRF fusion
  const fused = new Map<number, { row: EnrichedRow; rrf: number; similarity: number | null }>();

  for (let i = 0; i < vList.length; i++) {
    const it = vList[i];
    const prev = fused.get(it.row.id);
    const add = rrfScore(i + 1);
    fused.set(it.row.id, {
      row: it.row,
      rrf: (prev ? prev.rrf : 0) + add,
      similarity: it.similarity ?? (prev ? prev.similarity : null),
    });
  }

  for (let i = 0; i < kRows.length; i++) {
    const r = kRows[i];
    const prev = fused.get(r.id);
    const add = rrfScore(i + 1);
    fused.set(r.id, {
      row: r,
      rrf: (prev ? prev.rrf : 0) + add,
      similarity: prev ? prev.similarity : null,
    });
  }

  // 4) Dédup + bonus score
  const byDedup = new Map<
    string,
    { row: EnrichedRow; score: number; rrf: number; article_conf: number }
  >();

  const fusedValues = Array.from(fused.values());
  for (let i = 0; i < fusedValues.length; i++) {
    const it = fusedValues[i];
    const { hit_quality_score, article_conf } = scoreHit({
      row: it.row,
      expected,
      keywords,
      article,
      similarity: it.similarity,
    });

    const key = dedupKey(it.row);
    const composite = it.rrf + hit_quality_score * 0.15;
    const existing = byDedup.get(key);
    if (!existing || composite > existing.rrf + existing.score * 0.15) {
      byDedup.set(key, { row: it.row, score: hit_quality_score, rrf: it.rrf, article_conf });
    }
  }

  const ranked = Array.from(byDedup.values())
    .sort((a, b) => b.rrf + b.score * 0.15 - (a.rrf + a.score * 0.15))
    .map((x) => x.row);

  return {
    rows: ranked,
    used_hybrid: true,
    debug: {
      passJurisdiction,
      vectorReturned: vHits.length,
      vectorKept: vList.length,
      keywordReturned: kRows.length,
      fusedUnique: fused.size,
      dedupUnique: byDedup.size,
    },
  };
}

function buildSourcesOut(rows: EnrichedRow[], max = 8): SourceOut[] {
  const out: SourceOut[] = [];
  for (let i = 0; i < rows.length && out.length < max; i++) {
    const r = rows[i];
    if (!r.citation) continue;
    out.push({
      id: r.id,
      citation: r.citation,
      jurisdiction_norm: (r.jurisdiction_norm as Jurisdiction) ?? "OTHER",
      url_struct: r.url_struct ?? null,
      excerpt: makeExcerpt(`${r.title ?? ""}\n${r.text ?? ""}`, 900),
    });
  }
  return out;
}

// rag_quality (déterministe) + seuils Policy:contentReference[oaicite:20]{index=20}
function computeRagQuality(args: {
  expected: Jurisdiction;
  sources: SourceOut[];
  veryPertinent: boolean;
}): 0 | 1 | 2 | 3 {
  const { expected, sources, veryPertinent } = args;
  const n = sources.length;
  const hadQC = sources.some((s) => s.jurisdiction_norm === "QC");

  if (n === 0) return 0;
  if (expected === "QC" && !hadQC) return 0;

  if (n >= 2 && (expected !== "QC" || hadQC) && veryPertinent) return 3;
  if ((expected === "QC" && hadQC) || (expected !== "QC" && n >= 1)) return 2;

  return 1;
}

async function retrieveAll(question: string): Promise<RetrievalOut> {
  const jurisdiction_expected = detectJurisdictionExpected(question);
  const trap = isJurisdictionTrap(question);

  // Ask-before-answer (1 question max) si UNKNOWN ou piège:contentReference[oaicite:21]{index=21}
  if (jurisdiction_expected === "UNKNOWN" && trap) {
    return {
      jurisdiction_expected,
      jurisdiction_selected: "UNKNOWN",
      sources: [],
      allowed_citations: [],
      used_hybrid: false,
      had_qc_source: false,
      rag_quality: 0,
      article_confidence: 0,
      refused_reason: "jurisdiction_ambiguous_clarification_required",
    };
  }

  const embedding = await embedQuery(question);
  const keywords = extractKeywords(question, 6);
  const article = detectArticleMention(question);

  // Passes QC → CA-FED → OTHER:contentReference[oaicite:22]{index=22}
  const passOrder: Jurisdiction[] = ["QC", "CA-FED", "OTHER"];
  const vectorN = 36;
  const keywordN = 24;

  const TOP_FINAL = 10;
  const TOP_CHECK_GOOD = 8;
  const K_GOOD = 4;

  const allRows: EnrichedRow[] = [];
  const debugPasses: any[] = [];
  let used_hybrid = false;

  for (let p = 0; p < passOrder.length; p++) {
    const passJur = passOrder[p];
    const pass = await hybridPass({
      passJurisdiction: passJur,
      expected: jurisdiction_expected,
      embedding,
      keywords,
      article,
      vectorN,
      keywordN,
    });

    used_hybrid = used_hybrid || pass.used_hybrid;
    debugPasses.push(pass.debug);

    // append
    for (let i = 0; i < pass.rows.length; i++) allRows.push(pass.rows[i]);

    // Pass A stop condition: assez de “bons hits”
    if (passJur === "QC") {
      let good = 0;
      for (let i = 0; i < pass.rows.length && i < TOP_CHECK_GOOD; i++) {
        const { hit_quality_score } = scoreHit({
          row: pass.rows[i],
          expected: jurisdiction_expected,
          keywords,
          article,
          similarity: null,
        });
        if (hit_quality_score >= 1.2) good++;
      }
      if (good >= K_GOOD) break;
    }
  }

  // Final dedup across passes
  const seen = new Set<string>();
  const finalRows: EnrichedRow[] = [];
  for (let i = 0; i < allRows.length; i++) {
    const r = allRows[i];
    const k = dedupKey(r);
    if (seen.has(k)) continue;
    seen.add(k);
    finalRows.push(r);
    if (finalRows.length >= TOP_FINAL) break;
  }

  const sources = buildSourcesOut(finalRows, 8);
  const allowed_citations = sources.map((s) => s.citation);
  const had_qc_source = sources.some((s) => s.jurisdiction_norm === "QC");

  // jurisdiction_selected = expected si connu, sinon majorité des sources
  let jurisdiction_selected: Jurisdiction = jurisdiction_expected;
  if (jurisdiction_selected === "UNKNOWN") {
    const counts = new Map<Jurisdiction, number>();
    counts.set("QC", 0);
    counts.set("CA-FED", 0);
    counts.set("OTHER", 0);
    counts.set("UNKNOWN", 0);

    for (let i = 0; i < sources.length; i++) {
      const j = (sources[i].jurisdiction_norm as Jurisdiction) ?? "OTHER";
      counts.set(j, (counts.get(j) ?? 0) + 1);
    }

    const entries = Array.from(counts.entries());
    entries.sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0));
    jurisdiction_selected = entries.length ? entries[0][0] : "UNKNOWN";
  }

  const expectedForQuality =
    jurisdiction_expected === "UNKNOWN" ? jurisdiction_selected : jurisdiction_expected;

  const veryPertinent =
    sources.length >= 2 &&
    (expectedForQuality !== "QC" || sources.some((s) => s.jurisdiction_norm === "QC"));

  const rag_quality = computeRagQuality({
    expected: expectedForQuality,
    sources,
    veryPertinent,
  });

  // article_confidence: max sur top 6 rows
  let article_confidence = 0;
  const maxScan = Math.min(finalRows.length, 6);
  for (let i = 0; i < maxScan; i++) {
    const { article_conf } = scoreHit({
      row: finalRows[i],
      expected: jurisdiction_expected,
      keywords,
      article,
      similarity: null,
    });
    if (article_conf > article_confidence) article_confidence = article_conf;
  }

  return {
    jurisdiction_expected,
    jurisdiction_selected,
    sources,
    allowed_citations,
    used_hybrid,
    had_qc_source,
    rag_quality,
    article_confidence,
    debug: { keywords, article, debugPasses },
  };
}

// ===== Output JSON + post-check serveur (Phase 4B) =====:contentReference[oaicite:23]{index=23}
function safeJsonParse(text: string): ModelJson | null {
  try {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) return null;
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

function enforceAllowlist(parsed: ModelJson, allowlist: string[]): { ok: boolean; bad: string[] } {
  const used = parsed.citations_used ?? [];
  const bad: string[] = [];
  for (let i = 0; i < used.length; i++) if (allowlist.indexOf(used[i]) === -1) bad.push(used[i]);
  return { ok: bad.length === 0, bad };
}

// “Sources citées” format Policy:contentReference[oaicite:24]{index=24}
function formatFinalAnswer(parsed: ModelJson, sources: SourceOut[], allowlist: string[]): string {
  if (parsed.type === "clarify") {
    return parsed.clarification_question ?? "Avant de répondre : peux-tu préciser la juridiction applicable ?";
  }

  if (parsed.type === "refuse") {
    const ingest = (parsed.ingest_needed ?? []).map((x) => `- ${x}`).join("\n");
    return [
      parsed.refusal_reason ?? "Je ne peux pas répondre de façon fiable avec le corpus actuel.",
      "",
      `${CORPUS_MISS_TEMPLATE}${ingest || "[préciser la loi / l’article / la juridiction à ingérer]."}`,
    ].join("\n");
  }

  const ilac = parsed.ilac!;
  const used = (parsed.citations_used ?? []).filter((c) => allowlist.indexOf(c) !== -1);

  const citedLines = used
    .map((cit) => {
      const s = sources.find((x) => x.citation === cit);
      const jur = s?.jurisdiction_norm ?? "OTHER";
      const id = s?.id ?? "";
      const url = s?.url_struct ?? "";
      const tail = [id ? `id:${id}` : null, url ? url : null].filter(Boolean).join(" — ");
      return `- ${cit} — (${jur})${tail ? " — " + tail : ""}`;
    })
    .join("\n");

  const warning = parsed.warning ? `\n\n⚠️ ${parsed.warning}\n` : "";

  return [
    `**Juridiction applicable (selon le corpus) : ${parsed.jurisdiction}**`,
    warning,
    `**Problème**\n${ilac.probleme}`,
    `\n**Règle**\n${ilac.regle}`,
    `\n**Application**\n${ilac.application}`,
    `\n**Conclusion**\n${ilac.conclusion}`,
    `\n**Sources citées (allowlist uniquement)**\n${citedLines || "- (aucune)"}\n`,
  ].join("\n");
}

export async function POST(req: Request) {
  const startedAt = Date.now();

  try {
    const body = await req.json();

    const messages: { role: "user" | "assistant" | "system"; content: string }[] =
      body?.messages ?? [];
    const question: string =
      body?.question ??
      (function () {
        for (let i = messages.length - 1; i >= 0; i--) {
          if (messages[i].role === "user") return messages[i].content;
        }
        return "";
      })();

    const institution = body?.institution ?? "";
    const cours = body?.cours ?? "";
    const profile_slug = body?.profile_slug ?? null;
    const user_id = body?.user_id ?? null;

    if (!question || typeof question !== "string") {
      return NextResponse.json({ error: "Missing question" }, { status: 400 });
    }

    const retrieval = await retrieveAll(question);

    // Clarification required
    if (retrieval.refused_reason === "jurisdiction_ambiguous_clarification_required") {
      const clarify = buildClarificationQuestion(question);

      // log (table logs):contentReference[oaicite:25]{index=25}
      await supabase.from("logs").insert({
        question,
        profile_slug,
        top_ids: [],
        response: {
          type: "clarify",
          clarification_question: clarify,
          qa: {
            policy_version: POLICY_VERSION,
            jurisdiction_expected: retrieval.jurisdiction_expected,
            jurisdiction_selected: retrieval.jurisdiction_selected,
            rag_quality: retrieval.rag_quality,
            had_qc_source: retrieval.had_qc_source,
            used_hybrid: retrieval.used_hybrid,
            article_confidence: retrieval.article_confidence,
            refused_reason: retrieval.refused_reason,
          },
        },
        usage: { latency_ms: Date.now() - startedAt },
        user_id,
      });

      return NextResponse.json({
        type: "clarify",
        message: clarify,
        qa: {
          jurisdiction_expected: retrieval.jurisdiction_expected,
          jurisdiction_selected: retrieval.jurisdiction_selected,
          rag_quality: retrieval.rag_quality,
          had_qc_source: retrieval.had_qc_source,
          refused_reason: retrieval.refused_reason,
        },
      });
    }

    // rag_quality thresholds (Policy):contentReference[oaicite:26]{index=26}
    if (retrieval.rag_quality === 0) {
      const refusalText =
        CORPUS_MISS_TEMPLATE +
        "- la loi / le règlement applicable (avec juridiction)\n- l’article précis si tu en as un\n- ou la décision/jurisprudence pertinente\n";

      await supabase.from("logs").insert({
        question,
        profile_slug,
        top_ids: retrieval.sources.map((s) => s.id),
        response: {
          type: "refuse",
          message: refusalText,
          qa: {
            policy_version: POLICY_VERSION,
            jurisdiction_expected: retrieval.jurisdiction_expected,
            jurisdiction_selected: retrieval.jurisdiction_selected,
            rag_quality: retrieval.rag_quality,
            had_qc_source: retrieval.had_qc_source,
            used_hybrid: retrieval.used_hybrid,
            article_confidence: retrieval.article_confidence,
            refused_reason: "rag_quality_0",
          },
        },
        usage: { latency_ms: Date.now() - startedAt },
        user_id,
      });

      return NextResponse.json({
        type: "refuse",
        message: refusalText,
        qa: {
          jurisdiction_expected: retrieval.jurisdiction_expected,
          jurisdiction_selected: retrieval.jurisdiction_selected,
          rag_quality: retrieval.rag_quality,
          had_qc_source: retrieval.had_qc_source,
          refused_reason: "rag_quality_0",
        },
      });
    }

    const warning =
      retrieval.rag_quality === 2
        ? "Contexte partiel : je réponds prudemment selon les extraits disponibles."
        : retrieval.rag_quality === 1
          ? "Contexte faible : réponse limitée (il manque probablement des sources clés)."
          : undefined;

    // Payload exact (Policy):contentReference[oaicite:27]{index=27}
    const allowed = retrieval.allowed_citations.map((c) => `- ${c}`).join("\n");

    const context = retrieval.sources
      .map(
        (s) =>
          `SOURCE id=${s.id}\nCitation: ${s.citation}\nJuridiction: ${s.jurisdiction_norm}\nURL: ${s.url_struct ?? ""}\nExtrait:\n${s.excerpt}\n`
      )
      .join("\n---\n");

    const userPayload = [
      `Question: ${question}`,
      `Institution: ${institution}`,
      `Cours: ${cours}`,
      `Juridiction attendue: ${retrieval.jurisdiction_expected}`,
      `Contexte:\n${context || "(aucun extrait)"}`,
      `Allowed citations:\n${allowed || "(vide)"}`,
      "",
      "INSTRUCTIONS DE SORTIE (JSON strict):",
      `- Réponds en JSON uniquement, structure:
{
  "type": "answer" | "clarify" | "refuse",
  "jurisdiction": "QC" | "CA-FED" | "OTHER" | "UNKNOWN",
  "ilac": { "probleme": "...", "regle": "...", "application": "...", "conclusion": "..." },
  "citations_used": ["..."],
  "warning": "...",
  "ingest_needed": ["..."],
  "refusal_reason": "...",
  "clarification_question": "..."
}
- IMPORTANT: "citations_used" ⊆ Allowed citations (exact match).
- N'invente rien. Si insuffisant: type="refuse" et utilise: "${CORPUS_MISS_TEMPLATE}[X]".`,
    ].join("\n\n");

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.2,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        // petite mémoire (évite prompt trop long)
        ...messages.filter((m) => m.role !== "system").slice(-6),
        { role: "user", content: userPayload },
      ],
    });

    const raw = completion.choices?.[0]?.message?.content ?? "";
    const parsed = safeJsonParse(raw);

    // Post-check serveur (Phase 4B):contentReference[oaicite:28]{index=28}
    if (!parsed) {
      const msg =
        "Je ne peux pas répondre de façon fiable (sortie invalide). " +
        CORPUS_MISS_TEMPLATE +
        "- préciser la loi / l’article / la juridiction à ingérer.";

      await supabase.from("logs").insert({
        question,
        profile_slug,
        top_ids: retrieval.sources.map((s) => s.id),
        response: {
          type: "refuse",
          message: msg,
          qa: {
            policy_version: POLICY_VERSION,
            jurisdiction_expected: retrieval.jurisdiction_expected,
            jurisdiction_selected: retrieval.jurisdiction_selected,
            rag_quality: retrieval.rag_quality,
            had_qc_source: retrieval.had_qc_source,
            used_hybrid: retrieval.used_hybrid,
            article_confidence: retrieval.article_confidence,
            refused_reason: "json_parse_failed",
          },
        },
        usage: { latency_ms: Date.now() - startedAt, openai_usage: completion.usage ?? null },
        user_id,
      });

      return NextResponse.json({ type: "refuse", message: msg });
    }

    if (warning && parsed.type === "answer") parsed.warning = warning;

    const allow = enforceAllowlist(parsed, retrieval.allowed_citations);
    if (!allow.ok) {
      const msg =
        "Je ne peux pas répondre de façon fiable (citations hors allowlist détectées). " +
        CORPUS_MISS_TEMPLATE +
        "- ajouter les sources manquantes au corpus (loi/article/jurisprudence).";

      await supabase.from("logs").insert({
        question,
        profile_slug,
        top_ids: retrieval.sources.map((s) => s.id),
        response: {
          type: "refuse",
          message: msg,
          bad_citations: allow.bad,
          qa: {
            policy_version: POLICY_VERSION,
            jurisdiction_expected: retrieval.jurisdiction_expected,
            jurisdiction_selected: retrieval.jurisdiction_selected,
            rag_quality: retrieval.rag_quality,
            had_qc_source: retrieval.had_qc_source,
            used_hybrid: retrieval.used_hybrid,
            article_confidence: retrieval.article_confidence,
            refused_reason: "citation_leakage",
          },
        },
        usage: { latency_ms: Date.now() - startedAt, openai_usage: completion.usage ?? null },
        user_id,
      });

      return NextResponse.json({ type: "refuse", message: msg });
    }

    const finalText = formatFinalAnswer(parsed, retrieval.sources, retrieval.allowed_citations);

    // Logs QA complets (Phase 4B):contentReference[oaicite:29]{index=29}
    await supabase.from("logs").insert({
      question,
      profile_slug,
      top_ids: retrieval.sources.map((s) => s.id),
      response: {
        type: parsed.type,
        parsed,
        finalText,
        qa: {
          policy_version: POLICY_VERSION,
          jurisdiction_expected: retrieval.jurisdiction_expected,
          jurisdiction_selected: parsed.jurisdiction,
          rag_quality: retrieval.rag_quality,
          had_qc_source: retrieval.had_qc_source,
          used_hybrid: retrieval.used_hybrid,
          article_confidence: retrieval.article_confidence,
          refused_reason: parsed.type === "refuse" ? parsed.refusal_reason ?? null : null,
        },
      },
      usage: { latency_ms: Date.now() - startedAt, openai_usage: completion.usage ?? null },
      user_id,
    });

    return NextResponse.json({
      type: parsed.type,
      message: finalText,
      qa: {
        policy_version: POLICY_VERSION,
        jurisdiction_expected: retrieval.jurisdiction_expected,
        jurisdiction_selected: parsed.jurisdiction,
        rag_quality: retrieval.rag_quality,
        had_qc_source: retrieval.had_qc_source,
        used_hybrid: retrieval.used_hybrid,
        article_confidence: retrieval.article_confidence,
      },
      sources: retrieval.sources.map((s) => ({
        id: s.id,
        citation: s.citation,
        jurisdiction: s.jurisdiction_norm,
        url: s.url_struct ?? null,
      })),
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "Unknown error" }, { status: 500 });
  }
}

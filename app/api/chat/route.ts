/* eslint-disable no-console */
import { NextResponse } from "next/server";
import { createClient } from "../../../lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ------------------------------
// Types
// ------------------------------
type Jurisdiction = "QC" | "CA-FED" | "OTHER" | "UNKNOWN";

type VectorHit = {
  id?: string | number;
  code_id?: string | null;
  jurisdiction?: string | null;
  citation?: string | null;
  title?: string | null;
  text?: string | null;
  similarity?: number | null;
  distance?: number | null;
};

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

type Source = {
  id: string | number;
  citation: string | null;
  title?: string | null;
  jur?: string | null;
  url?: string | null;
  snippet?: string | null;
};

type ChatRequest = {
  // Phase 3
  message?: string;
  profile?: string | null;
  top_k?: number | null;
  mode?: string | null; // "dev" force dev
  // Phase 4 compatibility
  question?: string;
  messages?: Array<{ role: "user" | "assistant" | "system"; content: string }>;
};

// ------------------------------
// Env
// ------------------------------
const { OPENAI_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;

// ------------------------------
// Helpers
// ------------------------------
function json(data: any, init?: number | ResponseInit) {
  return new Response(JSON.stringify(data, null, 2), {
    status: typeof init === "number" ? init : init?.status ?? 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(typeof init !== "number" ? init?.headers : undefined),
    },
  });
}

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "Content-Type, Authorization",
};

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

async function safeJson(res: Response) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function normalizeJurisdiction(j: string | null | undefined): Jurisdiction | "OTHER" {
  const s = (j ?? "").toUpperCase();
  if (s === "QC") return "QC";
  if (s === "CA-FED" || s === "CA" || s.includes("CANADA")) return "CA-FED";
  if (s.includes("QUEBEC") || s.includes("QUÉBEC")) return "QC";
  return "OTHER";
}

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

function buildClarificationQuestion(q: string): string {
  const s = q.toLowerCase();
  if (s.includes("travail") || s.includes("emploi")) {
    return "Avant de répondre : est-ce que ton cas concerne un employeur de compétence fédérale (ex. banque, télécom, transport interprovincial/aviation) ou un employeur de compétence provinciale (Québec) ?";
  }
  return "Avant de répondre : quelle juridiction veux-tu appliquer (Québec, fédéral canadien, ou autre province/pays) ?";
}

const STOPWORDS_FR = new Set([
  "alors","aucun","avec","dans","donc","elle","elles","entre","être","mais","même","pour","sans","sont","tout","toute","tous",
  "le","la","les","un","une","des","de","du","au","aux","et","ou","sur","par","que","qui","quoi","dont","est","etre","a","à","en","se","sa","son","ses","ce","cet","cette","ces"
]);

function extractKeywords(q: string, max = 6): string[] {
  const cleaned = q
    .toLowerCase()
    .replace(/[^a-z0-9à-öø-ÿ\s.-]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  const parts = cleaned.split(" ");
  const uniq: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const t = parts[i].trim();
    if (!t) continue;

    const keepShort = t === "ccq" || t === "cpc" || t === "cp";
    if (t.length < 4 && !keepShort) continue;

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

function extractArticleNumFromRow(row: EnrichedRow): string | null {
  // 1) DB value if present
  if (row.article_num && String(row.article_num).trim()) return String(row.article_num).trim();

  // 2) Fallback: parse from citation/title/text
  const hay = `${row.citation ?? ""} ${row.title ?? ""} ${row.text ?? ""}`.toLowerCase();
  const m = hay.match(/\b(?:art\.?|article)\s*([0-9]{1,5})\b/);
  return m?.[1] ?? null;
}

function rrfScore(rank: number, k = 60): number {
  return 1 / (k + rank);
}

function makeExcerpt(text: string, maxLen = 1000): string {
  const t = (text || "").replace(/\s+/g, " ").trim();
  if (t.length <= maxLen) return t;
  return t.slice(0, maxLen) + "…";
}

function dedupKey(r: EnrichedRow): string {
  const code = (r.code_id_struct ?? "").trim();
  const art = extractArticleNumFromRow(r);
  if (code && art) return `${code}::${art}`;
  if (r.citation) return `CIT::${r.citation}`;
  return `ID::${r.id}`;
}

function scoreHit(args: {
  row: EnrichedRow;
  expected: Jurisdiction;
  keywords: string[];
  article: { mentioned: boolean; nums: string[] };
  similarity?: number | null;
}): { hit_quality_score: number; article_conf: number } {
  const { row, expected, keywords, article, similarity } = args;

  let score = 0;
  const jur = normalizeJurisdiction(row.jurisdiction_norm);
  const jurMatch = expected === "UNKNOWN" ? true : jur === expected;

  if (expected === "UNKNOWN") score += 0.3;
  else if (jurMatch) score += 1.0;
  else score -= 0.8;

  let articleConf = 0.5;
  if (article.mentioned) {
    articleConf = 0.2;
    const rowArt = extractArticleNumFromRow(row);
    if (rowArt && article.nums.indexOf(rowArt) !== -1) {
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

function computeRagQuality(args: {
  expected: Jurisdiction;
  sources: Source[];
  had_qc_source: boolean;
}): 0 | 1 | 2 | 3 {
  const { expected, sources, had_qc_source } = args;
  const n = sources.length;

  if (n === 0) return 0;
  if (expected === "QC" && !had_qc_source) return 0;

  if (n >= 2 && (expected !== "QC" || had_qc_source)) return 3;
  if (n >= 1 && (expected !== "QC" || had_qc_source)) return 2;
  return 1;
}

// ------------------------------
// OpenAI (fetch) — embeddings + chat
// ------------------------------
async function createEmbedding(input: string) {
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY manquant");
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "text-embedding-3-small", input }),
  });
  if (!res.ok) {
    const err = await safeJson(res);
    throw new Error(`OpenAI embeddings error: ${res.status} ${res.statusText} — ${JSON.stringify(err)}`);
  }
  const data = (await res.json()) as { data: { embedding: number[] }[] };
  return data.data?.[0]?.embedding as number[] | undefined;
}

async function createChatCompletion(messages: Array<{ role: "system" | "user" | "assistant"; content: string }>) {
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY manquant");
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "gpt-4o-mini", temperature: 0.2, messages }),
  });
  if (!res.ok) {
    const err = await safeJson(res);
    throw new Error(`OpenAI chat error: ${res.status} ${res.statusText} — ${JSON.stringify(err)}`);
  }
  const data = (await res.json()) as any;
  return {
    content: (data.choices?.[0]?.message?.content as string | undefined) ?? "",
    usage: data.usage ?? null,
  };
}

function safeJsonParse<T>(text: string): T | null {
  try {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) return null;
    return JSON.parse(text.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}

// ------------------------------
// Supabase REST calls (service role)
// ------------------------------
async function supaPost(path: string, body: any) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) throw new Error("SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY manquant");
  const res = await fetch(`${SUPABASE_URL}${path}`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "count=none",
    },
    body: JSON.stringify(body),
  });
  return res;
}

async function supaGet(path: string) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) throw new Error("SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY manquant");
  const res = await fetch(`${SUPABASE_URL}${path}`, {
    method: "GET",
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "count=none",
    },
  });
  return res;
}

async function vectorSearchRPC(rpcName: string, query_embedding: number[], match_count: number): Promise<VectorHit[]> {
  const rpcRes = await supaPost(`/rest/v1/rpc/${rpcName}`, { query_embedding, match_count });
  if (!rpcRes.ok) {
    const t = await rpcRes.text().catch(() => "");
    throw new Error(`RPC ${rpcName} failed: ${rpcRes.status} ${t}`);
  }
  return ((await rpcRes.json()) ?? []) as VectorHit[];
}

async function enrichByIds(ids: Array<string | number>): Promise<Map<number, EnrichedRow>> {
  const map = new Map<number, EnrichedRow>();
  if (!ids.length) return map;

  const numericIds: number[] = [];
  for (let i = 0; i < ids.length; i++) {
    const n = Number(ids[i]);
    if (!Number.isNaN(n)) numericIds.push(n);
  }
  if (!numericIds.length) return map;

  const list = numericIds.join(",");
  const url =
    `/rest/v1/legal_vectors_enriched` +
    `?select=id,code_id,citation,title,text,jurisdiction_norm,code_id_struct,article_num,url_struct` +
    `&id=in.(${encodeURIComponent(list)})`;

  const res = await supaGet(url);
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`enrichByIds failed: ${res.status} ${t}`);
  }
  const rows = ((await res.json()) ?? []) as EnrichedRow[];
  for (let i = 0; i < rows.length; i++) map.set(rows[i].id, rows[i]);
  return map;
}

async function keywordSearchFallback(passJur: Jurisdiction, keywords: string[], limit: number): Promise<EnrichedRow[]> {
  let base =
    `/rest/v1/legal_vectors_enriched?select=id,code_id,citation,title,text,jurisdiction_norm,code_id_struct,article_num,url_struct&limit=${limit}`;

  if (passJur !== "UNKNOWN") base += `&jurisdiction_norm=eq.${encodeURIComponent(passJur)}`;

  const ors: string[] = [];
  for (let i = 0; i < keywords.length; i++) {
    const kw = keywords[i].replace(/[%_]/g, "");
    ors.push(`citation.ilike.%${kw}%`);
    ors.push(`title.ilike.%${kw}%`);
    ors.push(`text.ilike.%${kw}%`);
  }
  if (ors.length) base += `&or=(${encodeURIComponent(ors.join(","))})`;

  const res = await supaGet(base);
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    console.warn("keywordSearchFallback failed:", res.status, t);
    return [];
  }
  return ((await res.json()) ?? []) as EnrichedRow[];
}

/**
 * Lookup déterministe quand l’utilisateur mentionne "art. XXXX".
 * On s’appuie sur citation (qui est fiable dans ton ingestion), car article_num peut être NULL
 * si extract_article_num(...) ne matche pas le format. :contentReference[oaicite:2]{index=2}
 */
async function directArticleLookupQC(args: {
  articleNums: string[];
  mustLookLikeCCQ: boolean;
  limit: number;
}): Promise<EnrichedRow[]> {
  const { articleNums, mustLookLikeCCQ, limit } = args;

  const out: EnrichedRow[] = [];
  const seen = new Set<number>();

  for (let i = 0; i < articleNums.length; i++) {
    const n = articleNums[i];

    // 1) strict: QC + citation contains number + (optional) ccq marker
    let url =
      `/rest/v1/legal_vectors_enriched` +
      `?select=id,code_id,citation,title,text,jurisdiction_norm,code_id_struct,article_num,url_struct` +
      `&jurisdiction_norm=eq.QC` +
      `&citation=ilike.${encodeURIComponent(`*${n}*`)}`;

    if (mustLookLikeCCQ) {
      url += `&citation=ilike.${encodeURIComponent(`*c.c.q*`)}`;
    }

    url += `&limit=${limit}`;

    const res = await supaGet(url);
    if (res.ok) {
      const rows = ((await res.json()) ?? []) as EnrichedRow[];
      for (let j = 0; j < rows.length; j++) {
        if (!seen.has(rows[j].id)) {
          seen.add(rows[j].id);
          out.push(rows[j]);
        }
      }
    }

    // 2) fallback: QC + citation contains number (no ccq requirement)
    if (mustLookLikeCCQ && out.length === 0) {
      const url2 =
        `/rest/v1/legal_vectors_enriched` +
        `?select=id,code_id,citation,title,text,jurisdiction_norm,code_id_struct,article_num,url_struct` +
        `&jurisdiction_norm=eq.QC` +
        `&citation=ilike.${encodeURIComponent(`*${n}*`)}` +
        `&limit=${limit}`;

      const res2 = await supaGet(url2);
      if (res2.ok) {
        const rows2 = ((await res2.json()) ?? []) as EnrichedRow[];
        for (let j = 0; j < rows2.length; j++) {
          if (!seen.has(rows2[j].id)) {
            seen.add(rows2[j].id);
            out.push(rows2[j]);
          }
        }
      }
    }
  }

  return out;
}

async function hybridPass(args: {
  passJurisdiction: Jurisdiction;
  expected: Jurisdiction;
  embedding: number[];
  keywords: string[];
  article: { mentioned: boolean; nums: string[] };
  vectorN: number;
  keywordN: number;
  rpcName: string;
}): Promise<{ rows: EnrichedRow[]; debug: any }> {
  const { passJurisdiction, expected, embedding, keywords, article, vectorN, keywordN, rpcName } = args;

  // Vector
  const vHits = await vectorSearchRPC(rpcName, embedding, vectorN);
  const vIds: Array<string | number> = [];
  for (let i = 0; i < vHits.length; i++) vIds.push(vHits[i].id ?? "");
  const enriched = await enrichByIds(vIds);

  const vList: Array<{ row: EnrichedRow; similarity: number | null }> = [];
  for (let i = 0; i < vHits.length; i++) {
    const h = vHits[i];
    const idNum = Number(h.id);
    if (Number.isNaN(idNum)) continue;
    const r = enriched.get(idNum);
    if (!r) continue;
    const jur = normalizeJurisdiction(r.jurisdiction_norm);
    if (passJurisdiction !== "UNKNOWN" && jur !== passJurisdiction) continue;
    vList.push({ row: r, similarity: h.similarity ?? null });
    if (vList.length >= vectorN) break;
  }

  // Keyword
  const kRows = await keywordSearchFallback(passJurisdiction, keywords, keywordN);

  // RRF fusion
  const fused = new Map<number, { row: EnrichedRow; rrf: number; similarity: number | null }>();

  for (let i = 0; i < vList.length; i++) {
    const it = vList[i];
    const prev = fused.get(it.row.id);
    fused.set(it.row.id, {
      row: it.row,
      rrf: (prev ? prev.rrf : 0) + rrfScore(i + 1),
      similarity: it.similarity ?? (prev ? prev.similarity : null),
    });
  }

  for (let i = 0; i < kRows.length; i++) {
    const r = kRows[i];
    const prev = fused.get(r.id);
    fused.set(r.id, {
      row: r,
      rrf: (prev ? prev.rrf : 0) + rrfScore(i + 1),
      similarity: prev ? prev.similarity : null,
    });
  }

  // Dedup + rank
  const byDedup = new Map<string, { row: EnrichedRow; composite: number }>();
  const values = Array.from(fused.values());

  for (let i = 0; i < values.length; i++) {
    const it = values[i];
    const scored = scoreHit({
      row: it.row,
      expected,
      keywords,
      article,
      similarity: it.similarity,
    });
    const composite = it.rrf + scored.hit_quality_score * 0.15;
    const key = dedupKey(it.row);
    const ex = byDedup.get(key);
    if (!ex || composite > ex.composite) byDedup.set(key, { row: it.row, composite });
  }

  const ranked = Array.from(byDedup.values())
    .sort((a, b) => b.composite - a.composite)
    .map((x) => x.row);

  return {
    rows: ranked,
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

// ------------------------------
// Prompt “verrouillé” + JSON output
// ------------------------------
const SYSTEM_PROMPT = `Tu es Droitis, tuteur IA spécialisé en droit québécois (QC).
Tu réponds en ILAC/IRAC : Problème → Règle → Application → Conclusion.
Interdiction absolue : inventer une loi, un article, une décision, une citation, ou un lien.
Tu ne cites QUE ce qui est présent dans sources[] et dans l’allowlist fournie.
Si une information n’est pas disponible dans les sources : tu dois le dire et expliquer quoi ingérer.
Tu dois annoncer la juridiction applicable avant d’énoncer la règle.
Si la juridiction est incertaine, tu poses 1 question de clarification avant de répondre.`;

type ModelJson = {
  type: "answer" | "clarify" | "refuse";
  jurisdiction: "QC" | "CA-FED" | "OTHER" | "UNKNOWN";
  ilac?: { probleme: string; regle: string; application: string; conclusion: string };
  clarification_question?: string;
  refusal_reason?: string;
  ingest_needed?: string[];
  citations_used?: string[];
  warning?: string;
};

function enforceAllowlist(parsed: ModelJson, allowlist: string[]): { ok: boolean; bad: string[] } {
  const used = parsed.citations_used ?? [];
  const bad: string[] = [];
  for (let i = 0; i < used.length; i++) if (allowlist.indexOf(used[i]) === -1) bad.push(used[i]);
  return { ok: bad.length === 0, bad };
}

function formatAnswerFromModel(parsed: ModelJson, allowlist: string[], sources: Source[], warning?: string): string {
  if (parsed.type === "clarify") {
    return parsed.clarification_question ?? "Avant de répondre : peux-tu préciser la juridiction applicable ?";
  }

  if (parsed.type === "refuse") {
    const ingest = (parsed.ingest_needed ?? []).map((x) => `- ${x}`).join("\n");
    return [
      parsed.refusal_reason ?? "Je ne peux pas répondre de façon fiable avec le corpus actuel.",
      "",
      `${"Information non disponible dans le corpus actuel. Pour répondre avec certitude, il faut ingérer : "}${ingest || "[préciser la loi / l’article / la juridiction à ingérer]."}`,
    ].join("\n");
  }

  const ilac = parsed.ilac!;
  const used = (parsed.citations_used ?? []).filter((c) => allowlist.indexOf(c) !== -1);

  const citedLines = used
    .map((cit) => {
      const s = sources.find((x) => x.citation === cit);
      const jur = s?.jur ?? "";
      const id = s?.id ?? "";
      const url = s?.url ?? "";
      const tail = [id ? `id:${id}` : null, url ? url : null].filter(Boolean).join(" — ");
      return `- ${cit}${jur ? ` — (${jur})` : ""}${tail ? " — " + tail : ""}`;
    })
    .join("\n");

  const warn = warning ? `\n\n⚠️ ${warning}\n` : "";

  return [
    `**Juridiction applicable (selon le corpus) : ${parsed.jurisdiction}**`,
    warn,
    `**Problème**\n${ilac.probleme}`,
    `\n**Règle**\n${ilac.regle}`,
    `\n**Application**\n${ilac.application}`,
    `\n**Conclusion**\n${ilac.conclusion}`,
    `\n**Sources citées (allowlist uniquement)**\n${citedLines || "- (aucune)"}\n`,
  ].join("\n");
}

// ------------------------------
// POST
// ------------------------------
export async function POST(req: Request) {
  // ✅ Auth gate (Phase 3)
  const supabaseAuth = createClient();
  const { data: { user } } = await supabaseAuth.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: CORS_HEADERS });
  }

  const startedAt = Date.now();

  try {
    // Env validation
    if (!OPENAI_API_KEY) return json({ error: "OPENAI_API_KEY manquant" }, 500);
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return json({ error: "SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY manquant" }, 500);
    }

    const body = (await req.json().catch(() => ({}))) as ChatRequest;

    // ✅ Compat parsing: Phase 3 uses `message`
    let message =
      (typeof body.message === "string" && body.message.trim()) ||
      (typeof body.question === "string" && body.question.trim()) ||
      "";

    if (!message && Array.isArray(body.messages)) {
      for (let i = body.messages.length - 1; i >= 0; i--) {
        const m = body.messages[i];
        if (m && m.role === "user" && typeof m.content === "string" && m.content.trim()) {
          message = m.content.trim();
          break;
        }
      }
    }

    // If still empty -> professional 400 with expected fields
    if (!message) {
      return json(
        {
          error: "Missing question",
          details: "Le body JSON doit contenir soit { message: string } (Phase 3), soit { question: string }, soit { messages: [{role:'user', content:string}, ...] }.",
        },
        { status: 400, headers: CORS_HEADERS }
      );
    }

    const profile = body.profile ?? null;
    const top_k = Math.max(1, Math.min(body.top_k ?? 5, 20));
    const mode = (body.mode ?? "prod").toLowerCase();

    // Phase4B: Gate juridiction
    const jurisdiction_expected = detectJurisdictionExpected(message);
    const trap = isJurisdictionTrap(message);

    if (jurisdiction_expected === "UNKNOWN" && trap) {
      const clarify = buildClarificationQuestion(message);

      // Log QA
      await supaPost("/rest/v1/logs", {
        question: message,
        profile_slug: profile ?? null,
        top_ids: [],
        response: {
          answer: clarify,
          sources: [],
          qa: {
            jurisdiction_expected,
            jurisdiction_selected: "UNKNOWN",
            rag_quality: 0,
            had_qc_source: false,
            article_confidence: 0,
            refused_reason: "jurisdiction_ambiguous_clarification_required",
          },
        },
        usage: { mode, top_k, latency_ms: Date.now() - startedAt },
        user_id: user.id,
      }).catch((e) => console.warn("log insert failed:", e));

      // Return with Phase 3 schema
      return json(
        {
          answer: clarify,
          sources: [],
          usage: {
            type: "clarify",
            jurisdiction_expected,
            jurisdiction_selected: "UNKNOWN",
            rag_quality: 0,
            had_qc_source: false,
          },
        },
        { status: 200, headers: CORS_HEADERS }
      );
    }

    // Embedding
    const queryEmbedding = await createEmbedding(message);
    if (!queryEmbedding) return json({ error: "Échec embedding" }, 500);

    // RPC name (Phase 3 behavior)
    const isDev = mode === "dev";
    const rpcName = isDev ? "search_legal_vectors_dev" : "search_legal_vectors_v2";

    // Phase4B: passes QC → CA-FED → OTHER
    const keywords = extractKeywords(message, 6);
    const article = detectArticleMention(message);

    // --- PINNING DÉTERMINISTE (articles) ---
    // Si la question mentionne "art. XXXX", on force la récupération via citation.
    let pinnedRows: EnrichedRow[] = [];
    if (article.mentioned) {
      const mustLookLikeCCQ = /c\.c\.q|ccq|code civil/i.test(message);
      pinnedRows = await directArticleLookupQC({
        articleNums: article.nums,
        mustLookLikeCCQ,
        limit: 5,
      });
    }

    const passOrder: Jurisdiction[] = ["QC", "CA-FED", "OTHER"];
    const vectorN = 36;
    const keywordN = 24;

    // Start with pinned rows to ensure they survive dedup/top_k
    const allRows: EnrichedRow[] = [];
    for (let i = 0; i < pinnedRows.length; i++) allRows.push(pinnedRows[i]);

    const debugPasses: any[] = [];
    for (let p = 0; p < passOrder.length; p++) {
      const passJur = passOrder[p];
      const pass = await hybridPass({
        passJurisdiction: passJur,
        expected: jurisdiction_expected,
        embedding: queryEmbedding,
        keywords,
        article,
        vectorN,
        keywordN,
        rpcName,
      });
      debugPasses.push(pass.debug);

      for (let i = 0; i < pass.rows.length; i++) allRows.push(pass.rows[i]);

      // stop early if QC pass good enough
      if (passJur === "QC") {
        let good = 0;
        const checkN = Math.min(pass.rows.length, 8);
        for (let i = 0; i < checkN; i++) {
          const s = scoreHit({ row: pass.rows[i], expected: jurisdiction_expected, keywords, article, similarity: null });
          if (s.hit_quality_score >= 1.2) good++;
        }
        if (good >= 4) break;
      }
    }

    // Final dedup & top_k
    const seen = new Set<string>();
    const finalRows: EnrichedRow[] = [];
    for (let i = 0; i < allRows.length; i++) {
      const k = dedupKey(allRows[i]);
      if (seen.has(k)) continue;
      seen.add(k);
      finalRows.push(allRows[i]);
    }

    // If article mentioned, prioritize exact article matches first (stable-ish)
    if (article.mentioned) {
      finalRows.sort((a, b) => {
        const aArt = extractArticleNumFromRow(a);
        const bArt = extractArticleNumFromRow(b);
        const aMatch = aArt && article.nums.indexOf(aArt) !== -1 ? 1 : 0;
        const bMatch = bArt && article.nums.indexOf(bArt) !== -1 ? 1 : 0;
        return bMatch - aMatch;
      });
    }

    // Cut to top_k after ordering
    const limitedRows = finalRows.slice(0, top_k);

    const sources: Source[] = [];
    for (let i = 0; i < limitedRows.length; i++) {
      const r = limitedRows[i];
      sources.push({
        id: r.id,
        citation: r.citation,
        title: r.title,
        jur: r.jurisdiction_norm,
        url: r.url_struct,
        snippet: makeExcerpt(`${r.title ?? ""}\n${r.text ?? ""}`, 1100),
      });
    }

    const had_qc_source = sources.some((s) => normalizeJurisdiction(s.jur ?? "") === "QC");
    const rag_quality = computeRagQuality({
      expected: jurisdiction_expected === "UNKNOWN" ? "QC" : jurisdiction_expected, // conservative
      sources,
      had_qc_source,
    });

    // article_confidence (max on first 6)
    let article_confidence = 0;
    const scanN = Math.min(limitedRows.length, 6);
    for (let i = 0; i < scanN; i++) {
      const sc = scoreHit({ row: limitedRows[i], expected: jurisdiction_expected, keywords, article, similarity: null });
      if (sc.article_conf > article_confidence) article_confidence = sc.article_conf;
    }

    // rag_quality=0 -> refuse
    if (rag_quality === 0) {
      const refusal =
        "Information non disponible dans le corpus actuel. Pour répondre avec certitude, il faut ingérer :\n" +
        "- la loi / le règlement applicable (avec juridiction)\n" +
        "- l’article précis si tu en as un\n" +
        "- ou la décision/jurisprudence pertinente\n";

      await supaPost("/rest/v1/logs", {
        question: message,
        profile_slug: profile ?? null,
        top_ids: limitedRows.map((r) => r.id),
        response: {
          answer: refusal,
          sources,
          qa: {
            jurisdiction_expected,
            jurisdiction_selected: "UNKNOWN",
            rag_quality,
            had_qc_source,
            article_confidence,
            refused_reason: "rag_quality_0",
          },
        },
        usage: { mode, top_k, latency_ms: Date.now() - startedAt, debugPasses },
        user_id: user.id,
      }).catch((e) => console.warn("log insert failed:", e));

      return json(
        {
          answer: refusal,
          sources: [],
          usage: {
            type: "refuse",
            jurisdiction_expected,
            jurisdiction_selected: "UNKNOWN",
            rag_quality,
            had_qc_source,
          },
        },
        { status: 200, headers: CORS_HEADERS }
      );
    }

    const warning =
      rag_quality === 2
        ? "Contexte partiel : je réponds prudemment selon les extraits disponibles."
        : rag_quality === 1
          ? "Contexte faible : réponse limitée (il manque probablement des sources clés)."
          : undefined;

    // allowlist citations (strict)
    const allowlist: string[] = [];
    for (let i = 0; i < sources.length; i++) if (sources[i].citation) allowlist.push(String(sources[i].citation));

    const context =
      sources
        .map((s) => `SOURCE id=${s.id}\nCitation: ${s.citation}\nJuridiction: ${s.jur}\nURL: ${s.url ?? ""}\nExtrait:\n${s.snippet ?? ""}`)
        .join("\n---\n") || "(aucun extrait)";

    const userPayload = [
      `Question: ${message}`,
      `Juridiction attendue: ${jurisdiction_expected}`,
      `Contexte:\n${context}`,
      `Allowed citations:\n${allowlist.map((c) => `- ${c}`).join("\n") || "(vide)"}`,
      "",
      "INSTRUCTIONS DE SORTIE (JSON strict):",
      `Réponds en JSON uniquement:
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
IMPORTANT: "citations_used" doit être un sous-ensemble exact de Allowed citations.
Si insuffisant: type="refuse" et utilise la phrase "Information non disponible dans le corpus actuel..."`,
    ].join("\n\n");

    const completion = await createChatCompletion([
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userPayload },
    ]);

    const parsed = safeJsonParse<ModelJson>(completion.content);

    // Post-check serveur
    if (!parsed) {
      const refusal =
        "Je ne peux pas répondre de façon fiable (sortie invalide). " +
        "Information non disponible dans le corpus actuel. Pour répondre avec certitude, il faut ingérer : " +
        "- préciser la loi / l’article / la juridiction à ingérer.";

      await supaPost("/rest/v1/logs", {
        question: message,
        profile_slug: profile ?? null,
        top_ids: limitedRows.map((r) => r.id),
        response: {
          answer: refusal,
          sources,
          qa: {
            jurisdiction_expected,
            jurisdiction_selected: "UNKNOWN",
            rag_quality,
            had_qc_source,
            article_confidence,
            refused_reason: "json_parse_failed",
          },
        },
        usage: { mode, top_k, latency_ms: Date.now() - startedAt, openai_usage: completion.usage ?? null, debugPasses },
        user_id: user.id,
      }).catch((e) => console.warn("log insert failed:", e));

      return json({ answer: refusal, sources: [], usage: { type: "refuse", rag_quality } }, { status: 200, headers: CORS_HEADERS });
    }

    if (warning && parsed.type === "answer") parsed.warning = warning;

    const allow = enforceAllowlist(parsed, allowlist);
    if (!allow.ok) {
      const refusal =
        "Je ne peux pas répondre de façon fiable (citations hors allowlist détectées). " +
        "Information non disponible dans le corpus actuel. Pour répondre avec certitude, il faut ingérer : " +
        "- ajouter les sources manquantes au corpus (loi/article/jurisprudence).";

      await supaPost("/rest/v1/logs", {
        question: message,
        profile_slug: profile ?? null,
        top_ids: limitedRows.map((r) => r.id),
        response: {
          answer: refusal,
          sources,
          bad_citations: allow.bad,
          qa: {
            jurisdiction_expected,
            jurisdiction_selected: parsed.jurisdiction,
            rag_quality,
            had_qc_source,
            article_confidence,
            refused_reason: "citation_leakage",
          },
        },
        usage: { mode, top_k, latency_ms: Date.now() - startedAt, openai_usage: completion.usage ?? null, debugPasses },
        user_id: user.id,
      }).catch((e) => console.warn("log insert failed:", e));

      return json({ answer: refusal, sources: [], usage: { type: "refuse", rag_quality } }, { status: 200, headers: CORS_HEADERS });
    }

    const answer = formatAnswerFromModel(parsed, allowlist, sources, warning);

    // Log
    await supaPost("/rest/v1/logs", {
      question: message,
      profile_slug: profile ?? null,
      top_ids: limitedRows.map((r) => r.id),
      response: {
        answer,
        sources,
        qa: {
          jurisdiction_expected,
          jurisdiction_selected: parsed.jurisdiction,
          rag_quality,
          had_qc_source,
          article_confidence,
          refused_reason: parsed.type === "refuse" ? parsed.refusal_reason ?? null : null,
        },
      },
      usage: { mode, top_k, latency_ms: Date.now() - startedAt, openai_usage: completion.usage ?? null, debugPasses },
      user_id: user.id,
    }).catch((e) => console.warn("log insert failed:", e));

    // ✅ Phase 3 response contract
    return json(
      {
        answer,
        sources,
        usage: {
          type: parsed.type,
          jurisdiction_expected,
          jurisdiction_selected: parsed.jurisdiction,
          rag_quality,
          had_qc_source,
          article_confidence,
        },
      },
      { status: 200, headers: CORS_HEADERS }
    );
  } catch (e: any) {
    console.error("chat route error:", e);
    return json({ error: e?.message ?? "Unknown error" }, { status: 500, headers: CORS_HEADERS });
  }
}

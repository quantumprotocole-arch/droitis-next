import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const message = (body.message || "").trim();
    const profile = (body.profile || "default").trim();
    const top_k = Number(body.top_k ?? 6);

    if (!message) return NextResponse.json({ error: "Missing message" }, { status: 400 });

    // 1) Embedding
    const embRes = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({ model: "text-embedding-3-small", input: message }),
    });
    if (!embRes.ok) {
      return NextResponse.json({ error: "OpenAI embeddings failed", detail: await embRes.text() }, { status: 502 });
    }
    const embJson = await embRes.json();
    const queryEmbedding = embJson.data[0].embedding;

    // 2) Supabase RPC -> fallback ilike
    const hits: any[] = [];
    const rpc = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/rpc/search_legal_vector`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY as string,
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      },
      body: JSON.stringify({ query_embedding: queryEmbedding, match_count: top_k }),
    });

    let results: any[] = [];
    if (rpc.ok) {
      results = await rpc.json();
    } else {
      const q = encodeURIComponent(message.slice(0, 64));
      const fb = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/legal_vectors?select=id,code_id,jurisdiction,citation,title,text&text=ilike.*${q}*`, {
        headers: {
          apikey: process.env.SUPABASE_SERVICE_ROLE_KEY as string,
          Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        },
      });
      if (fb.ok) results = (await fb.json()).slice(0, top_k).map((r: any) => ({ ...r, similarity: null }));
    }

    const context = (results || [])
      .map((h: any, i: number) => {
        const lead = h.citation?.length ? h.citation : h.title || h.code_id || `Source ${i + 1}`;
        const jur = h.jurisdiction || "QC/CA";
        const snip = (h.text || "").slice(0, 900);
        return `Source ${i + 1}: ${lead} [${jur}]\n${snip}`;
      })
      .join("\n\n---\n\n");

    const system = `Tu es Droitis, tuteur IA en droit (Québec/Canada).
- Réponds en français en IRAC/ILAC et cite exactement les sources (articles, décisions) avec juridiction.
- Si le contexte ne suffit pas, dis-le et propose la bonne démarche.`;

    const chatRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: process.env.OPENAI_CHAT_MODEL || "gpt-4o-mini",
        temperature: 0,
        max_tokens: 900,
        messages: [
          { role: "system", content: system },
          { role: "system", content: `Contexte (extraits):\n\n${context}` },
          { role: "user", content: `Profil: ${profile}\n\nQuestion: ${message}\n\nRéponds en IRAC/ILAC et liste les sources exactes en fin de réponse.` },
        ],
      }),
    });
    if (!chatRes.ok) return NextResponse.json({ error: "OpenAI chat failed", detail: await chatRes.text() }, { status: 502 });
    const chatJson = await chatRes.json();
    const answer = chatJson.choices?.[0]?.message?.content || "";

    const sources_text = (results || [])
      .map((s: any, i: number) => {
        const lead = s.citation || s.title || s.code_id || `#${s.id || i + 1}`;
        const jur = s.jurisdiction ? ` [${s.jurisdiction}]` : "";
        return `• Source ${i + 1}: ${lead}${jur}`;
      })
      .join("\n");

    return NextResponse.json({ answer, sources: results, sources_text });
  } catch (e: any) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

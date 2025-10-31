// app/api/hello/route.ts
export async function GET() {
  return new Response(JSON.stringify({ ok: true, app: "droitis" }), {
    headers: { "Content-Type": "application/json" },
  });
}

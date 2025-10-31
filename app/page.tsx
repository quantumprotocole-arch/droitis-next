// app/page.tsx
export default function Home() {
  return (
    <main style={{ maxWidth: "960px", margin: "0 auto", padding: "40px 16px" }}>
      <header style={{ display: "flex", justifyContent: "space-between", marginBottom: 32 }}>
        <h1 style={{ fontWeight: 700 }}>Droitis</h1>
        <div style={{ display: "flex", gap: 12 }}>
          <a href="/login">Se connecter</a>
          <a
            href="/login#signup"
            style={{ background: "black", color: "white", padding: "8px 16px", borderRadius: 6 }}
          >
            Créer un compte
          </a>
        </div>
      </header>

      <section style={{ marginBottom: 24 }}>
        <h2 style={{ fontSize: 20, fontWeight: 600 }}>Tuteur IA en droit (Québec / Canada)</h2>
        <p style={{ color: "#555" }}>
          Pose tes questions sur le C.c.Q., le C.p.c., le droit criminel, et reçois une réponse en IRAC/ILAC.
        </p>
      </section>

      <section style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))" }}>
        <div style={{ border: "1px solid #eee", padding: 16, borderRadius: 8 }}>
          <h3 style={{ fontWeight: 600 }}>Plan gratuit</h3>
          <ul>
            <li>Droit de la famille – Essai</li>
            <li>Droit criminel – Essai</li>
            <li>Procédure civile – Essai</li>
          </ul>
          <p style={{ fontSize: 12, color: "#777" }}>
            1 exercice sur 5 → pop-up vers le plan payant.
          </p>
        </div>
        <div style={{ border: "1px solid #eee", padding: 16, borderRadius: 8, background: "#f8fafc" }}>
          <h3 style={{ fontWeight: 600 }}>Droitis – Excellence</h3>
          <p style={{ fontSize: 14, color: "#555" }}>
            19,99 $/mois — cours complets, examens, correction, adaptation par université.
          </p>
          <button
            onClick={() => (window.location.href = "/login#pay")}
            style={{ marginTop: 12, background: "black", color: "white", padding: "8px 16px", borderRadius: 6 }}
          >
            Passer au plan Excellence
          </button>
        </div>
      </section>

      <footer style={{ marginTop: 48, borderTop: "1px solid #eee", paddingTop: 16, fontSize: 12, color: "#aaa" }}>
        Droitis © {new Date().getFullYear()} — IA éducative (non avis juridique).
      </footer>
    </main>
  );
}

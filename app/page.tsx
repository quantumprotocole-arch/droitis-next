// app/page.tsx
"use client";

export default function HomePage() {
  const goToLogin = () => {
    window.location.href = "/login";
  };

  return (
    <div style={{ minHeight: "100vh", padding: "3rem 1.5rem", background: "#f6f6f6" }}>
      <main style={{ maxWidth: 780, margin: "0 auto" }}>
        <h1 style={{ fontSize: "2.8rem", fontWeight: 700, marginBottom: "1rem" }}>
          Droitis — tuteur IA en droit
        </h1>
        <p style={{ fontSize: "1.05rem", marginBottom: "1.5rem" }}>
          Plan gratuit (3 cours) + plan Excellence 19,99 $/mois (cours + examens + adaptation par université).
        </p>

        <div style={{ display: "flex", gap: "1rem" }}>
          <button
            onClick={goToLogin}
            style={{
              background: "black",
              color: "white",
              border: "none",
              padding: "0.8rem 1.4rem",
              borderRadius: 9999,
              cursor: "pointer",
              fontWeight: 500
            }}
          >
            Se connecter / Créer un compte
          </button>
          <a href="/api/hello" style={{ alignSelf: "center", fontSize: "0.9rem" }}>
            Tester l’API →
          </a>
        </div>

        <section style={{ marginTop: "3rem" }}>
          <h2 style={{ fontSize: "1.4rem", marginBottom: "0.5rem" }}>
            Plan gratuit
          </h2>
          <ul style={{ marginLeft: "1.2rem" }}>
            <li>Droit de la famille — Essai</li>
            <li>Droit criminel — Essai</li>
            <li>Procédure civile — Essai</li>
          </ul>
        </section>

        <section style={{ marginTop: "2rem" }}>
          <h2 style={{ fontSize: "1.4rem", marginBottom: "0.5rem" }}>
            Droitis – Excellence (19,99 $/mois)
          </h2>
          <p>
            Tous les cours, génération/correction d’examens, grilles adaptées à UdeM, Laval, Sherbrooke, UQAM, Ottawa, McGill, Barreau.
          </p>
        </section>
      </main>
    </div>
  );
}

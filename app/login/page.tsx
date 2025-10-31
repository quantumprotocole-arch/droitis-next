// app/login/page.tsx
"use client";

import { useState } from "react";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [pwd, setPwd] = useState("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    alert("Ici on mettra Supabase auth (login/signup).");
  };

  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <form
        onSubmit={handleSubmit}
        style={{ background: "white", padding: "2rem", borderRadius: 12, width: "100%", maxWidth: 420 }}
      >
        <h1 style={{ fontSize: "1.8rem", marginBottom: "1.5rem" }}>Connexion Droitis</h1>
        <label style={{ display: "block", marginBottom: "0.5rem" }}>Courriel</label>
        <input
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          type="email"
          required
          style={{ width: "100%", padding: "0.6rem", marginBottom: "1rem", border: "1px solid #ddd", borderRadius: 8 }}
        />
        <label style={{ display: "block", marginBottom: "0.5rem" }}>Mot de passe</label>
        <input
          value={pwd}
          onChange={(e) => setPwd(e.target.value)}
          type="password"
          required
          style={{ width: "100%", padding: "0.6rem", marginBottom: "1.5rem", border: "1px solid #ddd", borderRadius: 8 }}
        />
        <button
          type="submit"
          style={{ width: "100%", background: "black", color: "white", padding: "0.7rem", borderRadius: 8, border: "none" }}
        >
          Continuer
        </button>
        <p style={{ marginTop: "1rem", fontSize: "0.85rem" }}>
          Pas de compte ? Retour à la{" "}
          <a href="/" style={{ textDecoration: "underline" }}>
            page d’accueil
          </a>
        </p>
      </form>
    </div>
  );
}

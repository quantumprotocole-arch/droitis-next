"use client";

import { useState } from "react";

export default function LoginPage() {
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [msg, setMsg] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setMsg("Ici on branchera Supabase auth.");
  }

  return (
    <main style={{ maxWidth: 480, margin: "40px auto", padding: 16 }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 16 }}>Connexion / Inscription</h1>
      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <button onClick={() => setMode("login")} style={{ fontWeight: mode === "login" ? 600 : 400 }}>
          Se connecter
        </button>
        <button onClick={() => setMode("signup")} style={{ fontWeight: mode === "signup" ? 600 : 400 }}>
          Créer un compte
        </button>
      </div>
      <form onSubmit={handleSubmit} style={{ display: "grid", gap: 12 }}>
        <input
          type="email"
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          style={{ border: "1px solid #ddd", padding: 8, borderRadius: 6 }}
        />
        <input
          type="password"
          placeholder="Mot de passe"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          style={{ border: "1px solid #ddd", padding: 8, borderRadius: 6 }}
        />
        <button style={{ background: "black", color: "white", padding: "8px 16px", borderRadius: 6 }}>
          {mode === "login" ? "Se connecter" : "Créer mon compte"}
        </button>
      </form>
      {msg && <p style={{ marginTop: 12 }}>{msg}</p>}
    </main>
  );
}

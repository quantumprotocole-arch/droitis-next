// app/layout.tsx
import "./globals.css";

export const metadata = {
  title: "Droitis",
  description: "Tuteur IA en droit pour étudiants au Québec / Canada"
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="fr">
      <body>{children}</body>
    </html>
  );
}
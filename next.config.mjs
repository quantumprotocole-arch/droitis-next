/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    // Next 14: permet d’éviter que Next tente de bundler ces libs côté serveur
    serverComponentsExternalPackages: ["pdfjs-dist", "pdf-parse", "@napi-rs/canvas"],
  },
};

export default nextConfig;

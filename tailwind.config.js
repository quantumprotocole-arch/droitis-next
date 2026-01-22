/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        droitis: {
          ink: "#0B2233",
          ink2: "#123449",
          paper: "#F5FBFF",
          glass: "rgba(255,255,255,0.72)",
          stroke: "rgba(16,38,55,0.22)",
          pink: "#F7B6E6",
          blue: "#B9E7FF",
          blue2: "#7AD3FF",
        },
      },
      boxShadow: {
        soft: "0 10px 30px rgba(11,34,51,0.16)",
      },
      borderRadius: {
        xl2: "1.25rem",
      },
      backgroundImage: {
        "droitis-gradient": "linear-gradient(90deg, rgba(247,182,230,0.95) 0%, rgba(185,231,255,0.95) 100%)",
      },
    },
  },
  plugins: [],
} 

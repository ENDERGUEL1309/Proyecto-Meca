import { defineConfig } from "vite";

// base relativa para poder servir el build desde cualquier ruta (p. ej. GitHub Pages)
export default defineConfig({
  base: "./",
  build: { target: "es2022", chunkSizeWarningLimit: 1500 },
});

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: { sourcemap: true },
  // maplibre-gl spawns its render worker from a URL relative to its own
  // module; the dep optimizer's rewritten bundle points that URL at a
  // maplibre-gl-worker.mjs that never exists, which kills all basemap
  // rendering in dev (DOM markers survive, tiles never paint).
  optimizeDeps: { exclude: ["maplibre-gl"] },
});

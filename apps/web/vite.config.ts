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
  // `pnpm --filter web dev` runs the client with HMR against a stack that is
  // already up (`make demo` / `make dev`), which owns the API, the WebSocket
  // and the database on 4173. Dev only; the production image serves the built
  // bundle from the Fastify server and never reads this block.
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": { target: "http://127.0.0.1:4173", changeOrigin: true },
      "/ws": { target: "ws://127.0.0.1:4173", ws: true },
    },
  },
});

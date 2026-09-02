import { setWorkerUrl } from "maplibre-gl";
// `?worker&url`: Vite bundles the worker WITH its `./maplibre-gl-shared.mjs`
// import and hands back the emitted asset's URL.
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";

/**
 * maplibre-gl resolves its render worker as `new URL("./maplibre-gl-worker.mjs",
 * import.meta.url)` at runtime — a string Vite cannot see, so the production
 * bundle asks for `/assets/maplibre-gl-worker.mjs`, which does not exist, the
 * SPA fallback answers with index.html, the worker throws "Unexpected token
 * '<'", and the basemap never paints (DOM markers survive, tiles do not).
 * Dev mode escaped this only because `optimizeDeps.exclude` (vite.config.ts)
 * keeps the module's URL inside node_modules, where the file is.
 *
 * Production only. Dev already works through `optimizeDeps.exclude`, and
 * routing dev through the `?worker&url` path made Vite transform the 1 MB
 * worker bundle on first request, delaying the map's `load` event enough to
 * race the e2e specs that capture marker positions after the on-load fit.
 * Imported for its side effect, before the first Map mounts.
 */
if (import.meta.env.PROD) setWorkerUrl(workerUrl);

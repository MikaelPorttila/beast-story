import { defineConfig } from "vite";
// Save a .blend, get a .glb, get a reloaded page. Serve-time only — see the
// note at the top of tools/blend-glb.mjs for why it lives in the dev server
// rather than in a second process.
import { blendGlb } from "./tools/blend-glb.mjs";

export default defineConfig({
  base: "./",
  plugins: [blendGlb()],
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      input: {
        main: "index.html",
        lab: "lab.html",
      },
    },
  },
  server: {
    // The capture and test tools in tools/ hardcode this port, so keep it
    // pinned — strictPort makes a clash fail loudly instead of drifting to 5188.
    port: 5187,
    strictPort: true,
  },
});

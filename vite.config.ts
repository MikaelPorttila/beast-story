import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      input: {
        main: 'index.html',
        lab: 'lab.html',
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

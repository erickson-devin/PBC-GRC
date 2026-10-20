import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  // Build identity: the git commit (BUILD_COMMIT, set by the Docker build) and build time, shown in the UI
  define: {
    __BUILD_COMMIT__: JSON.stringify(process.env.BUILD_COMMIT || 'dev'),
    __BUILD_DATE__: JSON.stringify(new Date().toISOString()),
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
    open: false,
    proxy: {
      // Must match the Express server's PORT (server/index.ts defaults to 3000).
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        secure: false,
      },
    },
  },
  build: {
    chunkSizeWarningLimit: 1500, // the generated NIST SP 800-53 catalog is one 1.2 MB file by nature
    rollupOptions: {
      output: {
        manualChunks: (id: string) => {
          // ── React core runtime ──────────────────────────────────────────
          if (id.includes('node_modules/react/') || id.includes('node_modules/react-dom/')) {
            return 'vendor-react';
          }

          // ── Lucide icon library ─────────────────────────────────────────
          if (id.includes('node_modules/lucide-react')) {
            return 'vendor-icons';
          }

          // ── Animation & utility libraries ───────────────────────────────
          if (
            id.includes('node_modules/framer-motion') ||
            id.includes('node_modules/canvas-confetti') ||
            id.includes('node_modules/clsx') ||
            id.includes('node_modules/tailwind-merge')
          ) {
            return 'vendor-ui';
          }

          // ── PDF / HTML report compilers & exporters ─────────────────────
          if (
            id.includes('/src/data/reports/') ||
            id.includes('/src/data/stigs/scriptGenerators')
          ) {
            return 'report-compilers';
          }

          // ── Browser-safe crypto primitives (shared by audit + reports) ──
          if (id.includes('/src/data/audit/cryptoUtils')) {
            return 'crypto-utils';
          }

          // ── Photon SCAP telemetry engine ────────────────────────────────
          if (
            id.includes('/src/data/telemetry/') ||
            id.includes('/src/components/telemetry/')
          ) {
            return 'telemetry-engine';
          }

          // ── STIG catalog data (large static asset) ──────────────────────
          if (id.includes('/src/data/stigs/stigCatalog')) {
            return 'stig-catalog';
          }

          // ── NIST SP 800-53 Rev. 5 generated data (~1,000 controls): its own file, so it is cached apart from the app ──
          if (id.includes('/src/data/frameworks/nist80053/') && id.endsWith('.json')) {
            // the SP 800-53A objectives are fetched on demand, so they must not share a file with the catalog
            return id.includes('objectives.generated') ? 'nist-80053a-objectives' : 'nist-80053-catalog';
          }

          // ── Framework & Control Catalog definitions ─────────────────────
          if (
            id.includes('/src/data/cmmcLevel1Controls') ||
            id.includes('/src/data/frameworks/')
          ) {
            return 'framework-catalogs';
          }
        },
      },
    },
  },
});

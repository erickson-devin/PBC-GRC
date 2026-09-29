import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
    open: false,
    proxy: {
      '/api': {
        target: 'http://localhost:8080',
        changeOrigin: true,
      },
    },
  },
  build: {
    chunkSizeWarningLimit: 1000,
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

          // ── Firebase SDK ────────────────────────────────────────────────
          if (id.includes('node_modules/firebase') || id.includes('node_modules/@firebase')) {
            return 'vendor-firebase';
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

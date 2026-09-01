import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The built UI is served by the management API (@fastify/static) which may host
// it under any root, so we use a relative base and absolute-path-free assets.
export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
});
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The dev and preview servers carry the same /api/llm proxy the production
// server does, because Particle (the default upstream) sends no CORS headers.
const upstream = new URL(process.env.HARNESS_UPSTREAM ?? 'https://api.particle.ai/v1');
const proxy = {
  '/api/llm': {
    target: upstream.origin,
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/api\/llm/, upstream.pathname.replace(/\/$/, '')),
  },
};

export default defineConfig({
  plugins: [react()],
  server: { port: 5199, strictPort: true, proxy },
  preview: { port: 4173, strictPort: true, proxy },
  build: { target: 'es2022' },
});

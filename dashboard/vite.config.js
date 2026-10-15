import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// The dashboard calls /api/*; the dev server proxies it to the HTTP API and adds the API key
// server-side, so the key never reaches the browser. API_URL and API_KEY come from
// .env.local, written by `terraform apply` in infra/stack (gitignored).
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  if (!env.API_URL || !env.API_KEY) {
    throw new Error('dashboard/.env.local is missing API_URL / API_KEY: run terraform apply in infra/stack');
  }
  return {
    plugins: [react(), tailwindcss()],
    server: {
      port: 5173,
      proxy: {
        '/api': {
          target: env.API_URL,
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api/, ''),
          headers: { 'x-api-key': env.API_KEY },
        },
      },
    },
  };
});

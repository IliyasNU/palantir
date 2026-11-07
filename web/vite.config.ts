import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { apiBaseUrl } from './src/api/config.ts';

export default defineConfig(({ command, mode }) => {
  if (command === 'build') {
    try {
      apiBaseUrl(process.env.VITE_API_URL ?? loadEnv(mode, process.cwd(), 'VITE_').VITE_API_URL);
    } catch {
      throw new Error('Build requires VITE_API_URL: a complete HTTP(S) API base URL without credentials, query or hash. Configure it before building; it is public in the browser bundle.');
    }
  }
  return {
  plugins: [react()],
  server: {
    host: 'localhost',
    port: 5173,
    strictPort: true,
  },
  preview: {
    host: 'localhost',
    port: 5173,
    strictPort: true,
  },
  };
});

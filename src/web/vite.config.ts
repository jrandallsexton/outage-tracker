import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { mockApi } from './dev/mock-api.ts';

export default defineConfig(({ command }) => ({
  // In `npm run dev` a fake in-memory API stands in for Azure, so the app can be tried without any cloud setup.
  plugins: command === 'serve' ? [mockApi()] : [],
  server: { fs: { allow: ['..'] } }, // the address list lives in ../data
  build: {
    target: 'es2020',
    rollupOptions: {
      input: { main: resolve(import.meta.dirname, 'index.html'), admin: resolve(import.meta.dirname, 'admin.html') },
    },
  },
}));

import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 8080,
    host: 'localhost',
  },
  build: {
    target: 'es2020',
  },
});

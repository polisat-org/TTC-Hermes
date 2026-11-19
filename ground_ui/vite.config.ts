import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Em dev (npm run dev) o Vite faz proxy do WebSocket para o bridge.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/ws': { target: 'ws://localhost:8765', ws: true } },
  },
});

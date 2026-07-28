// webex/board/vite.config.js
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: '/webex/collab/board/',
  plugins: [react()],
});

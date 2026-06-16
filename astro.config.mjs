import { defineConfig } from 'astro/config';
import vercel from '@astrojs/vercel';

export default defineConfig({
  site: 'https://inca-import.re',
  output: 'server',
  adapter: vercel(),
  vite: {
    ssr: {
      external: ['pdfkit'],
    },
  },
});

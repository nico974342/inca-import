import { defineConfig } from 'astro/config';
import node from '@astrojs/node';

export default defineConfig({
  site: 'https://inca-import.re',
  output: 'server',
  adapter: node({ mode: 'standalone' }),
  vite: {
    ssr: {
      external: ['pdfkit'],
    },
  },
});

import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    // SPA: Blocks Hosting serves build/ from S3 and falls back to /index.html
    // for client-side routes (see `framework: 'spa'` in aws-blocks/index.cdk.ts).
    adapter: adapter({ fallback: 'index.html' }),
    typescript: {
      // Type-check the backend and tests alongside the app. Paths are relative
      // to the generated .svelte-kit/tsconfig.json.
      config: (tsconfig) => {
        tsconfig.include.push('../aws-blocks/**/*', '../shared/**/*', '../scripts/seed/**/*', '../scripts/admin/**/*', '../scripts/data/**/*', '../vitest.config.ts', '../test/**/*', '../.blocks/**/*.d.ts');
      }
    }
  }
};

export default config;

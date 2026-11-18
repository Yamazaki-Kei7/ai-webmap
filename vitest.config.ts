import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vitest/config';

// Kept apart from vite.config.ts so the Tailwind plugin stays out of tests.
// The SvelteKit plugin provides `$lib` / `$app/*` and the Svelte compiler for
// `.svelte.ts` rune modules.
export default defineConfig({
  plugins: [sveltekit()],
  test: {
    projects: [
      {
        extends: true,
        // Svelte's `browser` entry points make runes and `$effect` run as on the client.
        resolve: { conditions: ['browser'] },
        test: { name: 'src', include: ['src/**/*.test.ts'], environment: 'jsdom' }
      },
      {
        // Shared code runs in both the backend and the browser; keep it DOM-free.
        extends: true,
        test: { name: 'shared', include: ['shared/**/*.test.ts'], environment: 'node' }
      },
      {
        // Backend modules under test construct no Building Blocks at import.
        extends: true,
        test: { name: 'aws-blocks', include: ['aws-blocks/**/*.test.ts'], environment: 'node' }
      },
      {
        // Operator scripts. The block-backed test moves the working directory to a throwaway one (forks, not threads).
        extends: true,
        test: { name: 'scripts', include: ['scripts/**/*.test.ts'], environment: 'node', pool: 'forks' }
      }
    ],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,svelte}', 'shared/**/*.ts', 'aws-blocks/**/*.ts', 'scripts/**/*.ts'],
      exclude: ['**/*.test.ts', '**/*.d.ts', 'src/lib/test-support/**', 'scripts/admin/test-support.ts'],
      reporter: ['text', 'html']
    }
  }
});

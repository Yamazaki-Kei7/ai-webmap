import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [tailwindcss(), sveltekit()],
  ssr: {
    // SvelteKit needs cookie@0.6, but a Blocks dependency hoists cookie@2 (a
    // different API) to the root node_modules. Left external, the build's
    // server output imports the hoisted copy and fails; bundling it resolves
    // SvelteKit's own copy instead.
    noExternal: ['cookie']
  }
});

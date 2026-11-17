# AWS Blocks App

Real-time todo app with authentication, per-user data isolation, and live sync across tabs.

## Getting Started

```bash
npm run dev          # Start local dev server (mocks, no AWS needed)
npm run test:e2e     # Run API tests
npm run sandbox      # Deploy to AWS sandbox
npm run sandbox:deploy # Deploy to AWS once and exit (no watch)
```

Open http://localhost:3000 after `npm run dev`.

## Project Structure

| Path | Purpose |
|------|---------|
| `aws-blocks/index.ts` | Backend: auth, data model, API, real-time channels |
| `src/routes/` | Frontend pages (SvelteKit): `+layout.svelte` has the account menu, `+page.svelte` the home page |
| `src/lib/components/TodoList.svelte` | Todo UI with live updates |
| `src/app.css` | Tailwind CSS entry point and theme |
| `src/app.html` | HTML shell |
| `test/e2e.test.ts` | Tests: auth, CRUD, conflicts, real-time |

## Frontend

The frontend is [SvelteKit](https://svelte.dev/docs/kit) (Svelte 5) styled with [Tailwind CSS](https://tailwindcss.com) v4. It is built as a static single-page app: `@sveltejs/adapter-static` writes it to `build/`, and server-side rendering is off (`src/routes/+layout.ts`).

- Hosting serves `build/` from S3 and CloudFront. This depends on `framework: 'spa'` in `aws-blocks/index.cdk.ts`; without it, Hosting deploys SvelteKit as SSR on Lambda, which does not build with `adapter-static`.
- Server-only SvelteKit files (`+page.server.ts`, `+server.ts`, `hooks.server.ts`) do not run in the deployed app. Put server logic in `aws-blocks/index.ts`.
- Tailwind has no config file. `src/app.css` imports it, limits class scanning to `src/`, and maps the Blocks UI design tokens to theme colors such as `bg-bb-surface` and `text-bb-muted`.

## What's Included

- **AuthBasic** — sign up / sign in / sign out with JWT sessions
- **DistributedTable** — todos stored in DynamoDB with Zod schema validation
- **Optimistic locking** — `version` field + `ifFieldEquals` prevents lost updates
- **Realtime** — todo changes broadcast to all connected tabs via WebSocket

## Commands

| Command | Description |
|---------|-------------|
| `npm run dev` | Local dev with mock storage |
| `npm run test:e2e` | Test API via direct imports |
| `npm run typecheck` | Type-check Svelte and TypeScript (frontend, backend and tests) with `svelte-check` |
| `npm run build` | Type-check, then build the frontend to `build/` |
| `npm run sandbox` | Deploy backend to AWS, serve frontend locally |
| `npm run sandbox:deploy` | Deploy the backend to AWS once and exit (no watch, no dev server); for scripts and CI |
| `npm run sandbox:preview` | Deploy a hosted preview: the sandbox backend plus the app in preview shape (API Gateway, no CloudFront); prints the URL. Same stack as `sandbox`: a plain sandbox deploy removes the preview, and re-adding it gives a new URL. Tear down with `npm run sandbox:destroy` |
| `npm run deploy` | Full production deploy |
| `npm run sandbox:destroy` | Tear down sandbox resources |

## Building on this template

The test file (`test/e2e.test.ts`) is structured in sections — Auth, CRUD, Conflicts, Realtime. Add your own tests by copying a `test(...)` block and changing the assertion. The API methods in `aws-blocks/index.ts` follow a consistent pattern: authenticate → do work → broadcast.

To replace the todo domain with your own: update the Zod schema, rename the API methods, and adjust the tests. The auth and real-time wiring stays the same.

## Stack naming

Your CloudFormation stack names are derived from the `stackId` in `.blocks/config.json` — generated at scaffold time from your project name plus a random suffix (e.g., `my-app-a3x9kf`). Production deploys as `<stackId>-prod` and sandbox as `<stackId>-<username>-<random>`, where the sandbox identifier is per-machine and stored in `.blocks-sandbox/sandbox-id.txt` (gitignored). This lets multiple developers share a testing account without colliding.

To change the stack name, edit `stackId` in `.blocks/config.json`. For dynamic naming logic, modify `aws-blocks/index.cdk.ts` directly.

## For Agents

Full Building Block documentation: `node_modules/@aws-blocks/blocks/README.md`

**Do not use local files or in-memory storage** — use Building Blocks for all data persistence and cloud abstractions (they mock locally and deploy to AWS automatically).

Start in `aws-blocks/index.ts` (backend) and `src/routes/+page.svelte` (frontend). Test via `npm run test:e2e`. The API transport (JSON-RPC) is auto-generated and intentionally invisible — do not curl endpoints directly. Testing is best done through the e2e tests which use the same typed client as the frontend. If you do need to call the API directly (e.g. troubleshooting a deployed app), every namespace shares one endpoint — `POST /aws-blocks/api` with the export name and method in the JSON-RPC `method` field (`"api.listTodos"`, `"authApi.getAuthState"`); there are no per-namespace paths like `/aws-blocks/authApi`. See `TROUBLESHOOTING.md` in `node_modules/@aws-blocks/blocks/docs` for curl examples.

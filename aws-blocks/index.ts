/**
 * Backend — aws-blocks/index.ts
 *
 * Exports the app's API namespaces. The frontend imports these exports directly
 * via `import { ... } from 'aws-blocks'`.
 *
 * Use Building Blocks for persistence and other cloud abstractions; they work
 * locally with automatic mocks and deploy to AWS with zero configuration.
 * Docs: node_modules/@aws-blocks/blocks/README.md
 */
import { ApiError, ApiNamespace, DEFAULT_API_ERROR_NAME, isWireSafeError } from '@aws-blocks/blocks';
import type { AuthActionInput, AuthState } from '@aws-blocks/blocks';
import { requireAdmin, requireAllowedUser } from './access.js';
import { auth } from './auth.js';
import { conversationMethods } from './conversation.js';
import { signedDownloadUrl, signedUploadUrl } from './datasets.js';
import { type LlmMode } from './llm-mode.js';
import { mapsMethods } from './maps.js';
import { llmMode } from './runtime-config.js';
import { scope } from './scope.js';
import {
  datasetFileName,
  datasetIds,
  duckdbWasmFileName,
  invalidUploadFileMessage,
  uploadErrors,
  uploadFileSchema,
  uploadStatus,
} from '../shared/datasets.js';
import { signedUrlExpiresAt } from '../shared/signed-url.js';

// ─── Auth ────────────────────────────────────────────────────────────────────
// The app's own namespace instead of `auth.createApi()`: only sign-in and
// sign-out are accepted. Users are created by the operator (scripts/seed), so
// sign-up and the other account actions are rejected and create nothing.
const signedOutState: AuthState = {
  state: 'signedOut',
  actions: [
    {
      name: 'signIn',
      label: 'Sign In',
      fields: [
        { name: 'username', label: 'Username', type: 'text', required: true },
        { name: 'password', label: 'Password', type: 'password', required: true },
      ],
    },
  ],
};

const signedInActions: AuthState['actions'] = [{ name: 'signOut', label: 'Sign Out', fields: [] }];

// Same wording and wire-safety rule as the block's own `createApi()`: only
// wire-safe errors show their message, anything else gets a generic one.
function errorFields(error: Error | undefined): Pick<AuthState, 'error' | 'errorName'> {
  const errorName = error instanceof ApiError && error.name !== DEFAULT_API_ERROR_NAME ? error.name : undefined;
  return {
    error: error && isWireSafeError(error) ? error.message : 'An unexpected error occurred',
    ...(errorName ? { errorName } : {}),
  };
}

export const authApi = new ApiNamespace(scope, 'authApi', (context) => {
  async function getAuthState(): Promise<AuthState> {
    const user = await auth.getCurrentUser(context);
    return user ? { state: 'signedIn', user, actions: signedInActions } : signedOutState;
  }

  async function setAuthState(input: AuthActionInput): Promise<AuthState> {
    switch (input.action) {
      case 'signIn':
        try {
          const user = await auth.signIn(input.username, input.password, context);
          return { state: 'signedIn', user, actions: signedInActions };
        } catch (error) {
          return { ...(await getAuthState()), ...errorFields(error instanceof Error ? error : undefined) };
        }
      case 'signOut':
        // The cookie is cleared even when revocation fails, so report signed out either way.
        try {
          await auth.signOut(context);
          return signedOutState;
        } catch (error) {
          return { ...signedOutState, ...errorFields(error instanceof Error ? error : undefined) };
        }
      default:
        // Creates nothing and leaves the session as it is: report the current state with the error.
        return { ...(await getAuthState()), error: `Action not supported: ${input.action}` };
    }
  }

  return { getAuthState, setAuthState };
});

// ─── API ─────────────────────────────────────────────────────────────────────
// Each method starts with `requireAllowedUser(context)` (sign-in, then the allow-list); the methods only
// an administrator may call start with `requireAdmin(context)`, which includes it.
export const api = new ApiNamespace(scope, 'api', (context) => ({
  async getAppInfo(): Promise<{ llmMode: LlmMode }> {
    await requireAllowedUser(context);
    return { llmMode };
  },

  async getDatasetSources(): Promise<{ sources: { id: string; url: string }[]; wasmUrl: string; expiresAt: number }> {
    await requireAllowedUser(context);
    const issuedAt = Date.now();
    const [sources, wasmUrl] = await Promise.all([
      Promise.all(datasetIds.map(async (id) => ({ id, url: await signedDownloadUrl(datasetFileName(id)) }))),
      signedDownloadUrl(duckdbWasmFileName),
    ]);
    return { sources, wasmUrl, expiresAt: signedUrlExpiresAt(issuedAt) };
  },

  async createDatasetUpload(file: string): Promise<{ url: string }> {
    // Admin first: a caller who is not an administrator learns nothing about which names are valid.
    await requireAdmin(context);
    const parsed = uploadFileSchema.safeParse(file);
    if (!parsed.success) {
      throw new ApiError(invalidUploadFileMessage, uploadStatus.badRequest, { name: uploadErrors.InvalidFile });
    }
    return { url: await signedUploadUrl(parsed.data) };
  },

  // The chat's conversation API (`aws-blocks/conversation.ts`): the same access check, then ownership of the conversation.
  ...conversationMethods(context),

  // The saved maps (`aws-blocks/maps.ts`): the same access check, then only the signed-in user's own records.
  ...mapsMethods(context),
}));

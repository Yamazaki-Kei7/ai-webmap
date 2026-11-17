import { AuthBasic } from '@aws-blocks/blocks';
import { passwordPolicy } from './password-policy.js';
import { scope } from './scope.js';

// Not exported from `index.ts`: the typed client must never reach `signUp`.
// The operator-only seed script (`scripts/seed/seed-users.ts`) imports it from here.
export const auth = new AuthBasic(scope, 'auth', { passwordPolicy });

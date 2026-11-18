import type { AuthBasicOptions } from '@aws-blocks/blocks';
import { authConfig } from '../shared/config.js';
import { passwordPolicy } from './password-policy.js';

// Kept apart from `auth.ts` (which builds the block) so that a test can build the same block without the app's scope.
export const authOptions: AuthBasicOptions = { passwordPolicy, lockout: authConfig.lockout };

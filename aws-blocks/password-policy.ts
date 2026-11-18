import type { PasswordPolicy } from '@aws-blocks/blocks';

// Kept apart from `auth.ts` so the operator's user-creation helper (`scripts/admin/`) can apply the very
// same policy without constructing a Building Block. A direct table write bypasses the block's own check.
export const passwordPolicy: PasswordPolicy = { minLength: 8 };

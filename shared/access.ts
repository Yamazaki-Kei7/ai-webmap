/** Error names and statuses for access control. The frontend recognises these (design 5.1). */

export const accessErrors = {
  /** The caller is signed in but is not on the allow-list. */
  NotAllowed: 'NotAllowedException',
  /** The caller is allowed but is not on the admin list. */
  AdminRequired: 'AdminRequiredException'
} as const;

export const accessStatus = {
  forbidden: 403
} as const;

/** Reveals nothing about the lists. */
export const notAllowedMessage = 'Access denied';
export const adminRequiredMessage = 'Administrator access required';

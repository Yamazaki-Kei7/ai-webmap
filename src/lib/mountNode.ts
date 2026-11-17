import type { Attachment } from 'svelte/attachments';

/**
 * Attachment that mounts a vanilla-DOM node into the host element — e.g. the
 * element returned by a Blocks UI factory (`AccountMenuBar`, `StatusMessage`):
 * `<div {@attach mountNode(() => AccountMenuBar(authApi))}></div>`
 */
export function mountNode(create: () => Node): Attachment {
  return (host) => {
    const node = create();
    host.appendChild(node);
    return () => host.removeChild(node);
  };
}

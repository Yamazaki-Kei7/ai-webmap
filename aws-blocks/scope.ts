import { Scope } from '@aws-blocks/blocks';

// One scope for the whole backend; its name also names the local mock stores in `.bb-data/`.
export const scope = new Scope('ai-webmap');

import { MediaQuery } from 'svelte/reactivity';
import { layoutConfig } from '../../../shared/config';

/** True on a narrow screen (`layoutConfig.narrowViewportMaxPx` or less): the shell stacks its parts and the layer panel starts collapsed. */
export const narrowViewport = new MediaQuery(`max-width: ${layoutConfig.narrowViewportMaxPx}px`);

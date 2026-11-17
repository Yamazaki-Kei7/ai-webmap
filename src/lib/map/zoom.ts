import { styleConfig } from '../../../shared/config';

/** A zoom within what a style (and a saved map) allows. */
export const clampZoom = (zoom: number): number => Math.min(Math.max(zoom, styleConfig.zoom.min), styleConfig.zoom.max);

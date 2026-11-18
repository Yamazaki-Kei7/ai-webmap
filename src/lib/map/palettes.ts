import { dataConfig } from '../../../shared/config';
import type { HexColor, QualitativePalette, SequentialPalette } from '../../../shared/mapSpec';

const { maxClasses } = dataConfig.classification;

/*
 * The colours behind the palette names of `shared/mapSpec.ts`, all lowercase `#rrggbb`, with the values of
 * d3-scale-chromatic 3.0.0 (ISC licence) as the one source:
 * - ColorBrewer 2.0 by Cynthia Brewer (Apache-2.0-style licence, https://colorbrewer2.org): `schemeBlues[9]`, `schemeGreens[9]`,
 *   `schemeReds[9]`, `schemeOranges[9]`, `schemePurples[9]`, `schemeYlOrRd[9]`, `schemeSet2` and `schemePaired`.
 * - viridis by Nathaniel Smith, Stefan van der Walt and Eric Firing (CC0): `interpolateViridis` sampled at 9 even stops.
 * - Tableau 10: `schemeTableau10`, from Tableau's palette (as ported by d3-scale-chromatic, BSD-3-Clause / ISC).
 *
 * Sequential ramps have 9 colours, light to dark (viridis is stored from yellow to dark purple to match).
 * `first` is the index of the lightest colour a ramp hands out: the near-white first colour of the ColorBrewer ramps
 * vanishes on the light basemap at the default opacity, so they start at index 1 (see `sequentialColors`).
 */
const sequentialRamps: Record<SequentialPalette, { colors: readonly HexColor[]; first: number }> = {
  blues: { first: 1, colors: ['#f7fbff', '#deebf7', '#c6dbef', '#9ecae1', '#6baed6', '#4292c6', '#2171b5', '#08519c', '#08306b'] },
  greens: { first: 1, colors: ['#f7fcf5', '#e5f5e0', '#c7e9c0', '#a1d99b', '#74c476', '#41ab5d', '#238b45', '#006d2c', '#00441b'] },
  reds: { first: 1, colors: ['#fff5f0', '#fee0d2', '#fcbba1', '#fc9272', '#fb6a4a', '#ef3b2c', '#cb181d', '#a50f15', '#67000d'] },
  oranges: { first: 1, colors: ['#fff5eb', '#fee6ce', '#fdd0a2', '#fdae6b', '#fd8d3c', '#f16913', '#d94801', '#a63603', '#7f2704'] },
  purples: { first: 1, colors: ['#fcfbfd', '#efedf5', '#dadaeb', '#bcbddc', '#9e9ac8', '#807dba', '#6a51a3', '#54278f', '#3f007d'] },
  ylorrd: { first: 1, colors: ['#ffffcc', '#ffeda0', '#fed976', '#feb24c', '#fd8d3c', '#fc4e2a', '#e31a1c', '#bd0026', '#800026'] },
  viridis: { first: 0, colors: ['#fde725', '#addc30', '#5ec962', '#28ae80', '#21918c', '#2c728e', '#3b528b', '#472d7b', '#440154'] }
};

/** Distinct colours for categories. */
const qualitativeSets: Record<QualitativePalette, readonly HexColor[]> = {
  // schemeSet2 (ColorBrewer)
  set2: ['#66c2a5', '#fc8d62', '#8da0cb', '#e78ac3', '#a6d854', '#ffd92f', '#e5c494', '#b3b3b3'],
  // schemeTableau10
  tableau10: ['#4e79a7', '#f28e2c', '#e15759', '#76b7b2', '#59a14f', '#edc949', '#af7aa1', '#ff9da7', '#9c755f', '#bab0ab'],
  // schemePaired (ColorBrewer)
  paired: [
    '#a6cee3', '#1f78b4', '#b2df8a', '#33a02c', '#fb9a99', '#e31a1c',
    '#fdbf6f', '#ff7f00', '#cab2d6', '#6a3d9a', '#ffff99', '#b15928'
  ]
};

/**
 * `classes` colours of a sequential palette, light to dark (`reverse` flips that), picked evenly between the palette's
 * lightest handed-out colour and its darkest, both always in; one class takes the middle one. The ColorBrewer ramps
 * skip their near-white first colour (index 0) as long as the classes fit in the other 8; with more classes the whole
 * ramp is used. `classes` is a whole number from 1 to `maxClasses`: anything else is a programming error, not an input
 * to clamp.
 */
export function sequentialColors(name: SequentialPalette, classes: number, reverse = false): HexColor[] {
  const { colors: ramp, first } = sequentialRamps[name];
  if (!Number.isInteger(classes) || classes < 1 || classes > maxClasses) {
    throw new RangeError(`classes must be a whole number from 1 to ${maxClasses} (got ${classes}).`);
  }
  const last = ramp.length - 1;
  const start = classes > last - first + 1 ? 0 : first;
  const picked = Array.from({ length: classes }, (_, i) => {
    const offset = classes === 1 ? (last - start) / 2 : (i * (last - start)) / (classes - 1);
    return ramp[start + Math.round(offset)];
  });
  return reverse ? picked.reverse() : picked;
}

/** All the colours of a qualitative palette, in their order. */
export function qualitativeColors(name: QualitativePalette): HexColor[] {
  return [...qualitativeSets[name]];
}

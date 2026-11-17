import { describe, expect, it } from 'vitest';
import { dataConfig } from '../../../shared/config';
import { qualitativePaletteSchema, sequentialPaletteSchema } from '../../../shared/mapSpec';
import { qualitativeColors, sequentialColors } from './palettes';

const { minClasses, maxClasses } = dataConfig.classification;
const hex = /^#[0-9a-f]{6}$/;

/** Relative luminance (WCAG) of a `#rrggbb` colour. */
function luminance(color: string): number {
  const [r, g, b] = [1, 3, 5].map((start) => {
    const channel = parseInt(color.slice(start, start + 2), 16) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

const classCounts = Array.from({ length: maxClasses - minClasses + 1 }, (_, i) => minClasses + i);

/** Every colour of every ramp as d3-scale-chromatic 3.0.0 has it, light to dark (viridis reversed, so yellow first). */
const ramps = {
  blues: ['#f7fbff', '#deebf7', '#c6dbef', '#9ecae1', '#6baed6', '#4292c6', '#2171b5', '#08519c', '#08306b'],
  greens: ['#f7fcf5', '#e5f5e0', '#c7e9c0', '#a1d99b', '#74c476', '#41ab5d', '#238b45', '#006d2c', '#00441b'],
  reds: ['#fff5f0', '#fee0d2', '#fcbba1', '#fc9272', '#fb6a4a', '#ef3b2c', '#cb181d', '#a50f15', '#67000d'],
  oranges: ['#fff5eb', '#fee6ce', '#fdd0a2', '#fdae6b', '#fd8d3c', '#f16913', '#d94801', '#a63603', '#7f2704'],
  purples: ['#fcfbfd', '#efedf5', '#dadaeb', '#bcbddc', '#9e9ac8', '#807dba', '#6a51a3', '#54278f', '#3f007d'],
  ylorrd: ['#ffffcc', '#ffeda0', '#fed976', '#feb24c', '#fd8d3c', '#fc4e2a', '#e31a1c', '#bd0026', '#800026'],
  viridis: ['#fde725', '#addc30', '#5ec962', '#28ae80', '#21918c', '#2c728e', '#3b528b', '#472d7b', '#440154']
} as const;

/** The ramp indices picked for 1 to 9 classes: evenly over 1-8 (ColorBrewer, 9 classes: all) or over 0-8 (viridis). */
const brewerIndices = [[5], [1, 8], [1, 5, 8], [1, 3, 6, 8], [1, 3, 5, 6, 8], [1, 2, 4, 5, 7, 8], [1, 2, 3, 5, 6, 7, 8], [1, 2, 3, 4, 5, 6, 7, 8], [0, 1, 2, 3, 4, 5, 6, 7, 8]];
const viridisIndices = [[4], [0, 8], [0, 4, 8], [0, 3, 5, 8], [0, 2, 4, 6, 8], [0, 2, 3, 5, 6, 8], [0, 1, 3, 4, 5, 7, 8], [0, 1, 2, 3, 5, 6, 7, 8], [0, 1, 2, 3, 4, 5, 6, 7, 8]];

describe('sequentialColors', () => {
  it('has as many classes as the palette can give', () => {
    expect(maxClasses).toBe(9);
    expect(minClasses).toBe(2);
  });

  for (const name of sequentialPaletteSchema.options) {
    const indices = name === 'viridis' ? viridisIndices : brewerIndices;

    it.each(classCounts)(`${name}: %i classes pick the pinned ramp colours`, (classes) => {
      expect(sequentialColors(name, classes)).toEqual(indices[classes - 1].map((i) => ramps[name][i]));
    });

    it(`${name}: one class takes the pinned middle colour`, () => {
      expect(sequentialColors(name, 1)).toEqual(indices[0].map((i) => ramps[name][i]));
    });

    it.each(classCounts)(`${name}: %i distinct lowercase hex colours, light to dark`, (classes) => {
      const colors = sequentialColors(name, classes);
      expect(colors).toHaveLength(classes);
      expect(new Set(colors).size).toBe(classes);
      for (const color of colors) expect(color).toMatch(hex);
      const lums = colors.map(luminance);
      for (let i = 1; i < lums.length; i++) expect(lums[i]).toBeLessThan(lums[i - 1]);
    });

    it(`${name}: reverse flips the order`, () => {
      for (const classes of classCounts) {
        expect(sequentialColors(name, classes, true)).toEqual(sequentialColors(name, classes).reverse());
      }
    });

    it(`${name}: 9 classes are the whole ramp`, () => {
      expect(sequentialColors(name, 9)).toEqual([...ramps[name]]);
    });
  }

  it('skips the near-white first colour of a ColorBrewer ramp up to 8 classes', () => {
    for (const name of sequentialPaletteSchema.options.filter((n) => n !== 'viridis')) {
      for (const classes of [1, ...classCounts].filter((n) => n <= 8)) {
        expect(sequentialColors(name, classes), `${name} ${classes}`).not.toContain(ramps[name][0]);
      }
    }
  });

  it('starts viridis at its first colour', () => {
    for (const classes of classCounts) expect(sequentialColors('viridis', classes)[0]).toBe(ramps.viridis[0]);
  });

  it('refuses a class count it cannot serve', () => {
    for (const classes of [0, maxClasses + 1, 2.5, Number.NaN]) {
      expect(() => sequentialColors('blues', classes), String(classes)).toThrow(RangeError);
    }
  });
});

describe('qualitativeColors', () => {
  const lengths = { set2: 8, tableau10: 10, paired: 12 } as const;

  for (const name of qualitativePaletteSchema.options) {
    it(`${name}: ${lengths[name]} distinct lowercase hex colours`, () => {
      const colors = qualitativeColors(name);
      expect(colors).toHaveLength(lengths[name]);
      expect(new Set(colors).size).toBe(colors.length);
      for (const color of colors) expect(color).toMatch(hex);
    });
  }

  it('pins every colour as d3-scale-chromatic 3.0.0 has it', () => {
    expect(qualitativeColors('set2')).toEqual(['#66c2a5', '#fc8d62', '#8da0cb', '#e78ac3', '#a6d854', '#ffd92f', '#e5c494', '#b3b3b3']);
    expect(qualitativeColors('tableau10')).toEqual([
      '#4e79a7', '#f28e2c', '#e15759', '#76b7b2', '#59a14f', '#edc949', '#af7aa1', '#ff9da7', '#9c755f', '#bab0ab'
    ]);
    expect(qualitativeColors('paired')).toEqual([
      '#a6cee3', '#1f78b4', '#b2df8a', '#33a02c', '#fb9a99', '#e31a1c', '#fdbf6f', '#ff7f00', '#cab2d6', '#6a3d9a', '#ffff99', '#b15928'
    ]);
  });

  it('hands out a copy, so a caller cannot change the palette', () => {
    qualitativeColors('set2').pop();
    expect(qualitativeColors('set2')).toHaveLength(8);
  });
});

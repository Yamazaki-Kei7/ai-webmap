import { readFileSync } from 'node:fs';
import type { LngLatLike } from 'maplibre-gl';
import { describe, expect, it } from 'vitest';
import {
  agentConfig,
  dataConfig,
  engineConfig,
  mapConfig,
  promptConfig,
  queryConfig,
  resultConfig,
  styleConfig,
  toolConfig,
  urlConfig
} from './config';

// Fails `npm run typecheck` if the initial view stops being assignable to MapLibre.
const initialCenter: LngLatLike = mapConfig.initialView.center;

describe('config invariants', () => {
  it('keeps one tool result within the per-response total', () => {
    expect(resultConfig.maxToolResultBytes).toBeLessThanOrEqual(resultConfig.maxTotalResultBytes);
  });

  it('uses positive durations and limits', () => {
    const numbers = [
      queryConfig.timeoutMs,
      queryConfig.cancelGraceMs,
      queryConfig.maxRows,
      queryConfig.maxSqlChars,
      queryConfig.maxFeaturesPerLayer,
      urlConfig.signedUrlTtlSeconds,
      urlConfig.refreshMarginSeconds,
      engineConfig.threads,
      engineConfig.initTimeoutMs,
      engineConfig.dataFetchTimeoutMs,
      engineConfig.maxErrorChars,
      agentConfig.maxLlmCalls,
      agentConfig.maxToolIterations,
      agentConfig.maxUtteranceChars,
      toolConfig.maxLayerNameChars,
      toolConfig.maxQueryColumns,
      toolConfig.maxResultLayers,
      promptConfig.maxChars,
      promptConfig.maxRepeatedFailures,
      promptConfig.coarseMetresPerDegree,
      promptConfig.approxMetresPerDegree
    ];
    for (const value of numbers) expect(value).toBeGreaterThan(0);
  });

  it('gives a data fetch longer than one query, so a slow file is not aborted on every try', () => {
    expect(engineConfig.dataFetchTimeoutMs).toBeGreaterThan(queryConfig.timeoutMs);
  });

  it('refreshes the signed URLs before they expire', () => {
    expect(urlConfig.refreshMarginSeconds).toBeLessThan(urlConfig.signedUrlTtlSeconds);
  });

  it('keeps the default class count inside the allowed range', () => {
    const { defaultClasses, minClasses, maxClasses } = dataConfig.classification;
    expect(minClasses).toBeLessThanOrEqual(defaultClasses);
    expect(defaultClasses).toBeLessThanOrEqual(maxClasses);
  });

  it('keeps the style defaults inside their bounds', () => {
    const { defaults, opacity } = styleConfig;
    for (const value of Object.values(defaults.opacity)) {
      expect(value).toBeGreaterThanOrEqual(opacity.min);
      expect(value).toBeLessThanOrEqual(opacity.max);
    }
    expect(defaults.strokeWidth).toBeLessThanOrEqual(styleConfig.maxStrokeWidth);
    expect(defaults.size.point).toBeLessThanOrEqual(styleConfig.maxSize);
    expect(defaults.size.line).toBeLessThanOrEqual(styleConfig.maxSize);
    expect(defaults.minRadius).toBeGreaterThan(0);
    expect(defaults.minRadius).toBeLessThan(defaults.maxRadius);
    expect(defaults.maxRadius).toBeLessThanOrEqual(styleConfig.maxRadius);
    expect(styleConfig.zoom.min).toBeLessThan(styleConfig.zoom.max);
    expect(styleConfig.noDataColor).not.toBe(styleConfig.otherColor);
    for (const color of [defaults.strokeColor, styleConfig.otherColor, styleConfig.noDataColor]) expect(color).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it('matches the DuckDB-WASM version pinned in package.json', () => {
    const pkg: { dependencies: Record<string, string> } = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8')
    );
    expect(dataConfig.duckdbWasmVersion).toBe(pkg.dependencies['@duckdb/duckdb-wasm']);
  });

  it('starts the map at a valid longitude and latitude', () => {
    expect(initialCenter).toBe(mapConfig.initialView.center);
    const [lng, lat] = mapConfig.initialView.center;
    expect(Math.abs(lng)).toBeLessThanOrEqual(180);
    expect(Math.abs(lat)).toBeLessThanOrEqual(90);
  });

  it('gives layers a palette of distinct hex colours', () => {
    const colors = mapConfig.defaultLayerColors;
    expect(colors.length).toBeGreaterThan(0);
    for (const color of colors) expect(color).toMatch(/^#[0-9a-f]{6}$/i);
    expect(new Set(colors).size).toBe(colors.length);
  });

  it('keeps the model layer summary within one tool result, and gives its caps positive values', () => {
    expect(mapConfig.summaryMaxBytes).toBeLessThanOrEqual(resultConfig.maxToolResultBytes);
    const caps = [
      mapConfig.summaryMaxLayers,
      mapConfig.summarySqlChars,
      mapConfig.summaryMaxColumns,
      mapConfig.summaryMaxColumnNameChars,
      mapConfig.summaryMaxStringChars,
      mapConfig.summaryMaxWarnings,
      mapConfig.summaryMaxWarningChars,
      mapConfig.summaryShrunkCategories
    ];
    for (const cap of caps) expect(cap).toBeGreaterThan(0);
  });

  it('draws a feature without a number smaller than the smallest proportional symbol', () => {
    expect(styleConfig.noDataRadius).toBeLessThan(styleConfig.defaults.minRadius);
  });

  it('gives labels hex colours and a font stack', () => {
    expect(styleConfig.labelDefaults.color).toMatch(/^#[0-9a-f]{6}$/i);
    expect(styleConfig.labelDefaults.haloColor).toMatch(/^#[0-9a-f]{6}$/i);
    expect(mapConfig.label.fontStack.length).toBeGreaterThan(0);
    expect(mapConfig.localIdeographFontFamily).toContain('sans-serif');
  });
});

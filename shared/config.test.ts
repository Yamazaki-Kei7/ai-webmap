import { readFileSync } from 'node:fs';
import type { LngLatLike } from 'maplibre-gl';
import { describe, expect, it } from 'vitest';
import {
  agentConfig,
  dataConfig,
  engineConfig,
  mapConfig,
  queryConfig,
  resultConfig,
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
      engineConfig.maxErrorChars,
      agentConfig.maxLlmCalls,
      agentConfig.maxToolIterations,
      agentConfig.maxUtteranceChars
    ];
    for (const value of numbers) expect(value).toBeGreaterThan(0);
  });

  it('refreshes the signed URLs before they expire', () => {
    expect(urlConfig.refreshMarginSeconds).toBeLessThan(urlConfig.signedUrlTtlSeconds);
  });

  it('keeps the default class count inside the allowed range', () => {
    const { defaultClasses, minClasses, maxClasses } = dataConfig.classification;
    expect(minClasses).toBeLessThanOrEqual(defaultClasses);
    expect(defaultClasses).toBeLessThanOrEqual(maxClasses);
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
});

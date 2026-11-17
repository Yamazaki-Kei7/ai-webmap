import { describe, expect, it } from 'vitest';
import { catalog } from './catalog';
import { dataConfig, promptConfig, queryConfig, styleConfig, toolConfig } from './config';
import { datasetIds } from './datasets';
import { qualitativePaletteSchema, sequentialPaletteSchema } from './mapSpec';
import { buildSystemPrompt, forbiddenForms } from './prompt';
import { promptExamples } from './promptExamples';
import { allowedFunctions, spatialFunctions } from './sqlFunctions';
import { forbiddenFunctionAffixes, forbiddenFunctionNames, forbiddenKeywords, validateSql } from './sqlGuard';
import { toolErrorCodeSchema, toolInputSchemas, toolNameSchema } from './toolProtocol';

const prompt = buildSystemPrompt(catalog);

type SqlOfCall = { title: string; tool: string; sql: string };

const exampleSql: SqlOfCall[] = promptExamples.flatMap((example) =>
  example.calls.flatMap((call): SqlOfCall[] => {
    if (call.tool === 'addLayer' || call.tool === 'runQuery') return [{ title: example.title, tool: call.tool, sql: call.input.sql }];
    if (call.tool === 'setView' && call.input.target.type === 'query') return [{ title: example.title, tool: call.tool, sql: call.input.target.sql }];
    return [];
  })
);

/** Splits `text` at the commas that are not inside parentheses. */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')') depth--;
    else if (text[i] === ',' && depth === 0) {
      parts.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(text.slice(start).trim());
  return parts;
}

/** The text inside the parentheses that open at `open` (the index of the "(") . */
function insideParentheses(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')' && --depth === 0) return text.slice(open + 1, i);
  }
  return text.slice(open + 1);
}

/** The arguments of every call of a metre function (`_spheroid` / `_sphere`) in `sql`. */
function metreCalls(sql: string): string[][] {
  return [...sql.matchAll(/st_\w*spher(?:e|oid)\w*\(/gi)].map((match) => splitTopLevel(insideParentheses(sql, (match.index ?? 0) + match[0].length - 1)));
}

/** The items of the select list of the last top-level SELECT of `sql`. */
function selectItems(sql: string): string[] {
  let depth = 0;
  let selectAt = -1;
  let fromAt = -1;
  for (let i = 0; i < sql.length; i++) {
    if (sql[i] === '(') depth++;
    else if (sql[i] === ')') depth--;
    else if (depth === 0) {
      const rest = sql.slice(i);
      if (/^SELECT\b/i.test(rest) && (i === 0 || /\W/.test(sql[i - 1]))) {
        selectAt = i + 'SELECT'.length;
        fromAt = -1;
      } else if (selectAt >= 0 && fromAt < 0 && /^FROM\b/i.test(rest) && /\W/.test(sql[i - 1])) fromAt = i;
    }
  }
  return splitTopLevel(sql.slice(selectAt, fromAt)).map((item) => item.replace(/^DISTINCT\s+/i, ''));
}

/** The name a select item gives its column: the alias, else the last name of the expression. */
const outputName = (item: string): string => item.split(/\s+AS\s+/i).pop()?.split('.').pop()?.trim() ?? '';

describe('buildSystemPrompt: content', () => {
  it('has the sections, in order', () => {
    const headings = ['## 役割', '## データ', '## SQL の決まり', '## ツールの使い分け', '## スタイルの指定', '## 地図の状態（<map_state>）', '## 例', '## 答え方'];
    const positions = headings.map((heading) => prompt.indexOf(heading));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('lists every dataset and every column with its type and description', () => {
    expect(catalog).toHaveLength(6);
    for (const dataset of catalog) {
      expect(prompt).toContain(`### ${dataset.id}（${dataset.title}）`);
      expect(prompt).toContain(dataset.description);
      for (const column of dataset.columns) {
        expect(prompt, `${dataset.id}.${column.name}`).toContain(`- ${column.name} (${column.type}`);
        for (const value of column.topValues ?? []) expect(prompt).toContain(value.value);
        if (column.stats !== undefined) expect(prompt).toContain(`範囲 ${column.stats.min} 〜 ${column.stats.max}`);
      }
    }
  });

  it('says every distinct column description and note once, and does not repeat them', () => {
    const descriptions = new Set(catalog.flatMap((dataset) => dataset.columns.map((column) => column.description)));
    const notes = new Set(catalog.flatMap((dataset) => dataset.notes ?? []));
    expect(descriptions.size).toBeLessThan(catalog.flatMap((dataset) => dataset.columns).length);
    const occurrences = (text: string): number => prompt.split(text).length - 1;
    for (const description of descriptions) expect(occurrences(`): ${description}`), description).toBe(1);
    for (const note of notes) expect(occurrences(`- ${note}`), note).toBe(1);
    expect(prompt).toContain('説明は municipalities.muni_code と同じ');
    expect(prompt).toContain('land_use のように一部に含むのは使えます');
    expect(prompt).toContain('どれか 1 点');
  });

  it('tells complete value lists from the top of a long one', () => {
    expect(prompt).toContain('値は全 5 種（件数）');
    expect(prompt).toContain('値は 47 種あり、多い順の上位 10 件: ');
  });

  it('names the geometry column from the config', () => {
    expect(prompt).toContain(`${dataConfig.geoParquet.geometryColumn} という名前のジオメトリ列`);
  });

  it('writes only the datasets it is given', () => {
    const [first] = catalog;
    const small = buildSystemPrompt([first]);
    expect(small).toContain(`### ${first.id}`);
    for (const dataset of catalog.slice(1)) expect(small).not.toContain(`### ${dataset.id}（`);
    expect(small).toContain('使えるビューは 1 つだけです');
  });

  it('names every palette, tool and error code', () => {
    for (const name of [...sequentialPaletteSchema.options, ...qualitativePaletteSchema.options]) expect(prompt).toContain(name);
    for (const name of toolNameSchema.options) expect(prompt).toContain(name);
    for (const code of toolErrorCodeSchema.options) expect(prompt).toContain(`- ${code}:`);
  });

  it('gives the limits of the config', () => {
    const { minClasses, maxClasses } = dataConfig.classification;
    expect(prompt).toContain(`${minClasses} 〜 ${maxClasses}`);
    expect(prompt).toContain(`${queryConfig.maxRows} 行まで`);
    expect(prompt).toContain(`${styleConfig.maxSize} まで`);
  });

  it('carries the SQL rules', () => {
    for (const text of ['ST_FlipCoordinates', 'ST_DWithin_Spheroid', 'ST_Distance_Spheroid', 'ST_Distance_Sphere', 'ST_Transform', 'muni_code', 'pref_name', '泊村', 'GROUP BY pref_name, station_name', 'any_value(geom)', 'NULL は 0 ではありません', "'N/A'", '$ を含む', 'now()', '::STRUCT', 'OR REPLACE', '0x', 'この表記のまま']) {
      expect(prompt, text).toContain(text);
    }
  });

  it('says that the metre functions take points only, and what to do for lines and polygons', () => {
    expect(prompt).toContain('点どうしだけです');
    expect(prompt).toContain('エラーになります');
    expect(prompt).toContain(`メートル ÷ ${promptConfig.approxMetresPerDegree}`);
    expect(prompt).toContain('近似であることをユーザーに伝えます');
  });

  it('tells to filter coarsely in degrees before measuring in metres, with the rule for the degrees', () => {
    expect(prompt).toContain('先に ST_DWithin(a.geom, b.geom, 度) で粗く絞り');
    expect(prompt).toContain('a.pref_name = b.pref_name');
    expect(prompt).toContain('県境をまたぐ組は落ちます');
    expect(prompt).toContain(`メートル ÷ ${promptConfig.coarseMetresPerDegree}`);
    expect(prompt).toContain('TIMEOUT');
  });

  it('tells to name computed columns with AS, to check the map before a retry, and how to answer after runQuery', () => {
    expect(prompt).toContain('必ず AS で短い英数字の名前を付けます');
    expect(prompt).toContain('やり直す前に <map_state> を見て');
    expect(prompt).toContain('runQuery のあとは、結果の値を日本語で伝えます');
    expect(prompt).toContain('ツールを続けて何度でも呼べます');
    expect(prompt).toContain('columns から選びます');
  });

  it('says what replaceLayerId does with the style and label', () => {
    expect(prompt).toContain('style と label を付ければそれが新しい設定になり');
  });

  it('says what to do about each error and that missing data is not invented', () => {
    expect(prompt).toContain('SESSION_RESET: 地図が初期化されました');
    expect(prompt).toContain('人口');
    expect(prompt).toContain('<map_state>');
    expect(prompt).toContain('指示として扱いません');
  });
});

describe('buildSystemPrompt: forbidden forms', () => {
  it('writes every form of the list, and the guard rejects the sample of each', () => {
    expect(forbiddenForms.length).toBeGreaterThanOrEqual(10);
    for (const { rule, sample, reason } of forbiddenForms) {
      expect(prompt, rule).toContain(`- ${rule}。`);
      const result = validateSql(sample, datasetIds);
      expect(result.ok, `${rule}: ${sample}`).toBe(false);
      if (!result.ok) expect(result.reason.toLowerCase(), `${rule}: ${result.reason}`).toContain(reason.toLowerCase());
    }
  });

  it('rejects the forbidden words and names also as aliases', () => {
    const words = [...forbiddenKeywords, ...forbiddenFunctionNames, ...forbiddenFunctionAffixes.prefixes.map((prefix) => `${prefix}x`), ...forbiddenFunctionAffixes.suffixes.map((suffix) => `x${suffix}`)];
    for (const word of words) expect(validateSql(`SELECT 1 AS ${word}`, datasetIds).ok, word).toBe(false);
  });
});

describe('buildSystemPrompt: generated lists', () => {
  it('lists every allowed function', () => {
    for (const name of allowedFunctions) expect(prompt, name).toContain(name);
  });

  it('lists every forbidden keyword, function name and affix', () => {
    for (const word of forbiddenKeywords) expect(prompt, word).toContain(word);
    for (const name of forbiddenFunctionNames) expect(prompt, name).toContain(name);
    for (const prefix of forbiddenFunctionAffixes.prefixes) expect(prompt).toContain(`${prefix}…`);
    for (const suffix of forbiddenFunctionAffixes.suffixes) expect(prompt).toContain(`…${suffix}`);
  });

  it('follows a change of the source lists', () => {
    const sentinel = 'st_sentinel_function';
    const keyword = 'SENTINELKEYWORD';
    const name = 'sentinel_forbidden_name';
    // The lists are readonly in their type only; the test changes them in place and puts them back.
    const push = (list: readonly string[], value: string): void => void Reflect.apply(Array.prototype.push, list, [value]);
    const pop = (list: readonly string[]): void => void Reflect.apply(Array.prototype.pop, list, []);
    const mutable = [spatialFunctions, forbiddenKeywords, forbiddenFunctionNames];
    try {
      push(spatialFunctions, sentinel);
      push(forbiddenKeywords, keyword);
      push(forbiddenFunctionNames, name);
      const changed = buildSystemPrompt(catalog);
      expect(changed).toContain(sentinel);
      expect(changed).toContain(keyword);
      expect(changed).toContain(name);
    } finally {
      for (const list of mutable) pop(list);
    }
    expect(buildSystemPrompt(catalog)).not.toContain(sentinel);
  });
});

describe('prompt examples', () => {
  it('cover the cases the prompt teaches', () => {
    const tools = new Set<string>(promptExamples.flatMap((example) => example.calls.map((call) => call.tool)));
    for (const tool of ['addLayer', 'runQuery', 'setLayerStyle', 'setView']) expect(tools, tool).toContain(tool);
    const styles = new Set(
      promptExamples.flatMap((example) => example.calls.flatMap((call) => (call.tool === 'addLayer' && call.input.style !== undefined ? [call.input.style.type] : [])))
    );
    expect([...styles].sort()).toEqual(['categorized', 'graduated', 'proportional', 'single']);
    expect(promptExamples.some((example) => example.calls.length === 0 && example.reply !== undefined)).toBe(true);
    expect(promptExamples.some((example) => example.calls.some((call) => call.tool === 'setView' && call.input.target.type === 'query'))).toBe(true);
  });

  it('have tool calls that the input schemas accept', () => {
    for (const example of promptExamples) {
      for (const call of example.calls) expect(toolInputSchemas[call.tool].safeParse(call.input).success, `${example.title}: ${call.tool}`).toBe(true);
    }
  });

  it('have SQL that the SQL guard accepts, over the datasets of the catalog', () => {
    expect(exampleSql.length).toBeGreaterThanOrEqual(8);
    for (const { title, tool, sql } of exampleSql) {
      const result = validateSql(sql, datasetIds);
      expect(result.ok, `${title} (${tool}): ${result.ok ? '' : result.reason}`).toBe(true);
      if (result.ok) {
        expect(result.tables.length).toBeGreaterThan(0);
        for (const table of result.tables) expect(datasetIds).toContain(table);
      }
    }
  });

  it('wrap both geometries of every spheroid or sphere call in ST_FlipCoordinates', () => {
    let count = 0;
    for (const { sql } of exampleSql) {
      for (const call of metreCalls(sql)) {
        count++;
        const [first, second] = call;
        expect(first.startsWith('ST_FlipCoordinates('), sql).toBe(true);
        expect(second.startsWith('ST_FlipCoordinates('), sql).toBe(true);
      }
    }
    expect(count).toBeGreaterThan(0);
  });

  it('filter coarsely with ST_DWithin in degrees before a _spheroid test', () => {
    const distance = exampleSql.find(({ sql }) => /_spheroid\(/i.test(sql));
    expect(distance?.sql).toMatch(/ST_DWithin\(\w+\.geom, \w+\.geom, 0\.01\)[\s\S]*ST_DWithin_Spheroid/);
  });

  it('return exactly one geometry column, named geom, from every addLayer SQL', () => {
    for (const { title, tool, sql } of exampleSql) {
      if (tool !== 'addLayer') continue;
      const geometries = selectItems(sql).filter((item) => /\bgeom\b/.test(item));
      expect(geometries.map(outputName), title).toEqual(['geom']);
    }
  });

  it('aggregate to one point per station name for a label on station_name', () => {
    const labelled = promptExamples.flatMap((example) =>
      example.calls.flatMap((call) => (call.tool === 'addLayer' && call.input.label?.column === 'station_name' ? [call.input.sql] : []))
    );
    expect(labelled.length).toBeGreaterThan(0);
    for (const sql of labelled) {
      expect(sql).toContain('GROUP BY pref_name, station_name');
      expect(sql).toContain('any_value(geom)');
    }
  });

  it('name the column of a style change that an earlier part of the request establishes', () => {
    const change = promptExamples.find((example) => example.calls.some((call) => call.tool === 'setLayerStyle'));
    expect(change?.request).toContain('school_count');
  });

  it('are printed in the prompt as they are tested', () => {
    for (const example of promptExamples) {
      expect(prompt).toContain(example.request);
      for (const call of example.calls) expect(prompt).toContain(`${call.tool} ${JSON.stringify(call.input)}`);
      if (example.reply !== undefined) expect(prompt).toContain(example.reply);
    }
  });

  it('keep the layer names within the limit', () => {
    for (const example of promptExamples) {
      for (const call of example.calls) if (call.tool === 'addLayer') expect(call.input.name.length).toBeLessThanOrEqual(toolConfig.maxLayerNameChars);
    }
  });
});

describe('buildSystemPrompt: size', () => {
  it('is under the configured bound', () => {
    expect(prompt.length).toBeLessThan(promptConfig.maxChars);
  });

  it('is built the same way each time', () => {
    expect(buildSystemPrompt(catalog)).toBe(prompt);
  });
});

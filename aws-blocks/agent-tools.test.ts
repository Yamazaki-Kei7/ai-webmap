import { describe, expect, it, vi } from 'vitest';
import { interruptName, toolError, toolInputSchemas, type ToolName } from '../shared/toolProtocol';
import { cannedExample } from './agent-canned';
import { runClientTool, toolSettings, type Interrupt } from './agent-tools';

const okRunQuery = JSON.stringify({ ok: true, data: { columns: [{ name: 'n', type: 'number' }], rows: [{ n: 1 }], rowCount: 1, truncated: false } });

/** An `interrupt` that answers with `answer` and records its calls. */
function fakeInterrupt(answer: string) {
  const interrupt = vi.fn<Interrupt>(() => answer);
  return interrupt;
}

describe('runClientTool', () => {
  it('interrupts once with the fixed name and the validated request, and returns the parsed answer', () => {
    const interrupt = fakeInterrupt(okRunQuery);
    const result = runClientTool('runQuery', { sql: 'SELECT 1 AS n' }, interrupt);
    expect(interrupt).toHaveBeenCalledTimes(1);
    expect(interrupt).toHaveBeenCalledWith({ name: interruptName('runQuery'), reason: { tool: 'runQuery', input: { sql: 'SELECT 1 AS n' } } });
    expect(result).toEqual({ ok: true, data: { columns: [{ name: 'n', type: 'number' }], rows: [{ n: 1 }], rowCount: 1, truncated: false } });
  });

  it('passes a well-formed error of the browser on as it is', () => {
    const answer = toolError('SQL_ERROR', 'no such column', 'check the columns');
    expect(runClientTool('runQuery', { sql: 'SELECT 1' }, fakeInterrupt(JSON.stringify(answer)))).toEqual(answer);
  });

  it('answers SQL_REJECTED with the guard reason and does not interrupt, for each tool that carries SQL', () => {
    const rejected = 'DROP TABLE stations';
    const calls = [
      () => runClientTool('runQuery', { sql: rejected }, interrupt),
      () => runClientTool('addLayer', { name: 'x', sql: rejected }, interrupt),
      () => runClientTool('setView', { target: { type: 'query', sql: rejected } }, interrupt)
    ];
    const interrupt = fakeInterrupt(okRunQuery);
    for (const call of calls) {
      const result = call();
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SQL_REJECTED');
        expect(result.error.message).not.toBe('');
      }
    }
    expect(interrupt).not.toHaveBeenCalled();
  });

  it('does not run the guard on the tools without SQL, nor on a setView that is not a query', () => {
    const interrupt = fakeInterrupt(JSON.stringify({ ok: true, data: { removed: 'L1', remaining: [] } }));
    expect(runClientTool('removeLayer', { layerId: 'L1' }, interrupt).ok).toBe(true);
    expect(interrupt).toHaveBeenCalledTimes(1);
    const viewAnswer = fakeInterrupt(JSON.stringify({ ok: true, data: { center: [139.7, 35.7], zoom: 9 } }));
    expect(runClientTool('setView', { target: { type: 'layer', layerId: 'L1' } }, viewAnswer).ok).toBe(true);
    expect(viewAnswer).toHaveBeenCalledTimes(1);
  });

  it.each(['not json', '{}', '[]', '', 'null', JSON.stringify({ ok: true, data: { wrong: 1 } })])('turns the answer %j into ENGINE_UNAVAILABLE, never a throw', (answer) => {
    const result = runClientTool('runQuery', { sql: 'SELECT 1' }, fakeInterrupt(answer));
    expect(result).toMatchObject({ ok: false, error: { code: 'ENGINE_UNAVAILABLE' } });
  });

  it('checks the answer against the schema of the tool that was called', () => {
    // A valid runQuery answer is not a valid removeLayer answer.
    const result = runClientTool('removeLayer', { layerId: 'L1' }, fakeInterrupt(okRunQuery));
    expect(result).toMatchObject({ ok: false, error: { code: 'ENGINE_UNAVAILABLE' } });
  });

  it('returns a tool error (no interrupt, no throw) for an input the schema rejects', () => {
    const interrupt = fakeInterrupt(okRunQuery);
    const result = runClientTool('removeLayer', { layerId: 'not a layer id' } /* a string the schema's pattern rejects */, interrupt);
    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(interrupt).not.toHaveBeenCalled();
  });
});

describe('toolSettings', () => {
  it('marks the output untrusted for the tools that carry dataset values (rows, categories, column names), and no other', () => {
    const untrusted = Object.entries(toolSettings).filter(([, setting]) => setting.untrustedOutput).map(([name]) => name);
    expect(untrusted.sort()).toEqual(['addLayer', 'runQuery', 'setLayerStyle']);
  });
});

describe('cannedExample', () => {
  it('names the optional fields of addLayer whose canned placeholder ("sample") the schema rejects', () => {
    expect(cannedExample('addLayer')).toMatchObject({ replaceLayerId: 'L1', label: { column: 'station_name' } });
  });

  const tools = Object.keys(toolInputSchemas).filter((name): name is ToolName => name in toolInputSchemas);

  it('gives every tool an input its schema accepts', () => {
    expect(tools).toHaveLength(6);
    for (const tool of tools) {
      expect(toolInputSchemas[tool].safeParse(cannedExample(tool)).success, tool).toBe(true);
    }
  });

  it('gives every tool an input that reaches the browser (the SQL guard accepts it)', () => {
    for (const tool of tools) {
      const interrupt = fakeInterrupt(okRunQuery);
      // The call must get as far as the interrupt; the answer is not the point here.
      const input = toolInputSchemas[tool].parse(cannedExample(tool));
      runClientTool(tool, input, interrupt);
      expect(interrupt, tool).toHaveBeenCalledTimes(1);
    }
  });
});

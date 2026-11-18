import { describe, expect, it } from 'vitest';
import { catalog } from '../../../shared/catalog';
import { attributionLine, publisherOf, visibleSources } from './attribution';

const source = (id: string) => {
  const dataset = catalog.find((d) => d.id === id);
  if (!dataset) throw new Error(`no dataset ${id}`);
  return dataset.source;
};

describe('visibleSources', () => {
  it('lists the source of each dataset a visible layer reads', () => {
    expect(visibleSources([{ visible: true, datasetIds: ['stations'] }])).toEqual([source('stations')]);
  });

  it('leaves out the datasets only hidden layers read', () => {
    expect(
      visibleSources([
        { visible: false, datasetIds: ['stations'] },
        { visible: true, datasetIds: ['railways'] }
      ])
    ).toEqual([source('railways')]);
  });

  it('lists a dataset once however many layers read it, and keeps a dataset a hidden layer shares with a visible one', () => {
    expect(
      visibleSources([
        { visible: true, datasetIds: ['stations'] },
        { visible: false, datasetIds: ['stations'] },
        { visible: true, datasetIds: ['stations', 'railways'] }
      ])
    ).toEqual([source('stations'), source('railways')]);
  });

  it('lists datasets of one source once', () => {
    expect(source('municipalities')).toEqual(source('prefectures'));
    expect(visibleSources([{ visible: true, datasetIds: ['municipalities', 'prefectures'] }])).toHaveLength(1);
  });

  it('is empty without a visible layer, and ignores an unknown dataset', () => {
    expect(visibleSources([])).toEqual([]);
    expect(visibleSources([{ visible: false, datasetIds: ['stations'] }])).toEqual([]);
    expect(visibleSources([{ visible: true, datasetIds: ['nope'] }])).toEqual([]);
  });
});

describe('publisherOf', () => {
  it('drops the dataset name and keeps the publishing body', () => {
    expect(publisherOf('国土数値情報（行政区域データ）（国土交通省）')).toBe('国土数値情報（国土交通省）');
  });

  it('leaves a name with fewer than two parentheses alone', () => {
    expect(publisherOf('国土数値情報（国土交通省）')).toBe('国土数値情報（国土交通省）');
    expect(publisherOf('某統計')).toBe('某統計');
  });

  it('gives every catalog source one publisher', () => {
    expect(new Set(catalog.map((dataset) => publisherOf(dataset.source.name))).size).toBe(1);
  });
});

describe('attributionLine', () => {
  const named = (name: string) => ({ ...source('stations'), name });

  it('is one line with the licence for sources of one publisher', () => {
    const all = catalog.map((dataset) => dataset.source);
    expect(attributionLine(all)).toBe('出典：国土数値情報（国土交通省）を加工して作成（CC BY 4.0）');
  });

  it('names the first publisher and counts the others', () => {
    const line = attributionLine([named('A（a）（甲）'), named('B（b）（乙）'), named('C（c）（丙）'), named('A（z）（甲）')]);
    expect(line).toBe('出典：A（甲）ほか 2 件を加工して作成（CC BY 4.0）');
  });

  it('is null without a source', () => {
    expect(attributionLine([])).toBeNull();
  });
});

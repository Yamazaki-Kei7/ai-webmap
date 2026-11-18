import { z } from 'zod';
import { dataConfig } from '../../shared/config.js';

/**
 * The settings of `npm run data:convert`, as data. Every path, source attribute name, threshold and size the
 * conversion uses is here and nowhere else. This module is also the source of the dataset ids and their order for the
 * generation of the catalog (the file of a dataset is `datasetFileName(id)` of `shared/dataset-files.ts`); nothing
 * under `scripts/data/` that the conversion or the catalog generator loads may import `shared/catalog.json`, so both run when it is absent or stale.
 * `prefectures` has no source of its own: it is derived from `municipalities` (`adminAreaConfig`). The four other datasets
 * (task 1.4) are point and line files whose rules are in `placeConfig`, `landPriceRules`, `stationRules` and `railwayRules`.
 */

/** The ids of the six datasets (also the DuckDB view names), in the order of the catalog. */
const ids = {
  municipalities: 'municipalities',
  prefectures: 'prefectures',
  landPrices: 'land_prices',
  stations: 'stations',
  railways: 'railways',
  schools: 'schools'
} as const;

export const datasetIds: readonly string[] = [ids.municipalities, ids.prefectures, ids.landPrices, ids.stations, ids.railways, ids.schools];

export const columnTypes = ['INTEGER', 'DOUBLE', 'VARCHAR'] as const;

export const datasetConfigSchema = z.strictObject({
  /** One of `datasetIds`. */
  id: z.string().refine((id) => datasetIds.includes(id), { message: 'not one of datasetIds in datasets.config.ts' }),
  /** The raw file, relative to `conversionConfig.dirs.raw`. */
  input: z.string().min(1),
  /** Output column name -> source attribute name, in the output order (the geometry column follows). `type` casts the value. */
  columns: z.array(z.strictObject({ name: z.string().min(1), source: z.string().min(1), type: z.enum(columnTypes).optional() })).min(1),
  /** Output column name -> (source code value -> label). For datasets whose codes are turned into labels. */
  codeLabels: z.record(z.string(), z.record(z.string(), z.string())).optional(),
  /** Point datasets: the source attribute that holds a municipality code (a dataset without one gets its codes from the spatial rule). */
  codeSource: z.string().min(1).optional(),
  /** Point datasets: the output column that names a point in the messages of a run. */
  labelColumn: z.string().min(1).optional(),
  /** Source attributes the output order follows (after `muni_code` for a point dataset); they must make the order total. */
  orderBy: z.array(z.string().min(1)).optional(),
  /** A run that reads another number of raw rows fails. */
  expectedSourceRows: z.number().int().positive().optional(),
  /** A run that writes another number of rows fails. */
  expectedRows: z.number().int().positive().optional()
});

export type DatasetConfig = z.infer<typeof datasetConfigSchema>;

/** 国土数値情報 N03 (行政区域), Shapefile (the 258 MB input; the GeoJSON is 580 MB). */
const adminAreaInput = 'N03/N03-20260101.shp';

const n03Fields = {
  prefecture: 'N03_001',
  city: 'N03_004',
  ward: 'N03_005',
  code: 'N03_007'
} as const;

/** The municipality code column: the key of `municipalities` and the first sort key of the point files (shared/config.ts). */
const codeColumn = dataConfig.geoParquet.pointSortKey;

/** The prefecture name column: a column of `municipalities`, the name column of `prefectures`, a column of the point files. */
const prefNameColumn = 'pref_name';

/** The city name column of `municipalities` and of the point files. */
const cityNameColumn = 'city_name';

/** 国土数値情報 L01 (地価公示). */
const l01Fields = {
  code: 'L01_001',
  landUse: 'L01_002',
  serial: 'L01_003',
  price: 'L01_008',
  changeRate: 'L01_009',
  status: 'L01_010',
  address: 'L01_025'
} as const;

/**
 * 国土数値情報 S12 (駅別乗降客数). The last four attributes are the columns of the adopted fiscal year (2024). They
 * move when the source is updated: a new version of the file has the next four column numbers, and only these change.
 */
const s12Fields = {
  stationName: 'S12_001',
  operator: 'S12_002',
  lineName: 'S12_003',
  duplicate: 'S12_058',
  existence: 'S12_059',
  value: 'S12_061'
} as const;

/** 国土数値情報 N02 (鉄道, section file). */
const n02Fields = {
  railwayType: 'N02_001',
  operatorType: 'N02_002',
  lineName: 'N02_003',
  operator: 'N02_004'
} as const;

/** 国土数値情報 P29 (学校). */
const p29Fields = {
  code: 'P29_001',
  schoolCode: 'P29_002',
  schoolType: 'P29_003',
  name: 'P29_004',
  address: 'P29_005',
  adminType: 'P29_006',
  campusCode: 'P29_008'
} as const;

/** The output column names of the four datasets of task 1.4, each written once; the columns, the label tables and the rules refer to them. */
const outputColumns = {
  price: 'price_yen_per_m2',
  changeRate: 'yoy_change_pct',
  landUse: 'land_use',
  address: 'address',
  stationName: 'station_name',
  operator: 'operator',
  lineName: 'line_name',
  passengers: 'passengers_per_day',
  operatorType: 'operator_type',
  railwayType: 'railway_type',
  schoolName: 'school_name',
  schoolType: 'school_type',
  adminType: 'admin_type'
} as const;

export const datasetConfigs: DatasetConfig[] = z.array(datasetConfigSchema).parse([
  {
    id: ids.municipalities,
    input: adminAreaInput,
    columns: [
      { name: codeColumn, source: n03Fields.code },
      { name: prefNameColumn, source: n03Fields.prefecture },
      { name: cityNameColumn, source: n03Fields.city }
      // `muni_name` is derived (city name + ward name): see `adminAreaConfig.wardSource`.
    ]
  },
  {
    id: ids.landPrices,
    input: 'L01/L01-26_GML/L01-26.geojson',
    columns: [
      { name: outputColumns.price, source: l01Fields.price, type: 'INTEGER' },
      { name: outputColumns.changeRate, source: l01Fields.changeRate, type: 'DOUBLE' },
      { name: outputColumns.landUse, source: l01Fields.landUse },
      { name: outputColumns.address, source: l01Fields.address }
    ],
    codeLabels: {
      [outputColumns.landUse]: { '000': '住宅地', '003': '宅地見込地', '005': '商業地', '009': '工業地', '013': '林地' }
    },
    codeSource: l01Fields.code,
    labelColumn: outputColumns.address,
    // municipality code, land-use code, serial number: unique per standard site.
    orderBy: [l01Fields.code, l01Fields.landUse, l01Fields.serial],
    expectedSourceRows: 25_565,
    expectedRows: 25_565
  },
  {
    id: ids.stations,
    input: 'S12/S12-25_GML/UTF-8/S12-25_NumberOfPassengers.geojson',
    columns: [
      { name: outputColumns.stationName, source: s12Fields.stationName },
      { name: outputColumns.operator, source: s12Fields.operator },
      { name: outputColumns.lineName, source: s12Fields.lineName },
      { name: outputColumns.passengers, source: s12Fields.value, type: 'INTEGER' }
    ],
    labelColumn: outputColumns.stationName,
    // Name, operator, line; the point's coordinates break the remaining ties (see `pointTieBreakers`).
    orderBy: [s12Fields.stationName, s12Fields.operator, s12Fields.lineName],
    expectedSourceRows: 10_534,
    expectedRows: 10_263
  },
  {
    id: ids.railways,
    input: 'N02/N02-25_GML/UTF-8/N02-25_RailroadSection.geojson',
    columns: [
      { name: outputColumns.lineName, source: n02Fields.lineName },
      { name: outputColumns.operator, source: n02Fields.operator },
      { name: outputColumns.operatorType, source: n02Fields.operatorType },
      { name: outputColumns.railwayType, source: n02Fields.railwayType }
    ],
    codeLabels: {
      [outputColumns.operatorType]: { '1': 'JRの新幹線', '2': 'JR在来線', '3': '公営鉄道', '4': '民営鉄道', '5': '第三セクター' },
      [outputColumns.railwayType]: {
        '11': '普通鉄道JR',
        '12': '普通鉄道',
        '13': '鋼索鉄道',
        '14': '懸垂式鉄道',
        '15': '跨座式鉄道',
        '16': '案内軌条式鉄道',
        '17': '無軌条鉄道',
        '21': '軌道',
        '22': '懸垂式モノレール',
        '23': '跨座式モノレール',
        '24': '案内軌条式',
        '25': '浮上式'
      }
    },
    // The four columns together are the dissolve key; operator and line name first, then the two codes.
    orderBy: [n02Fields.operator, n02Fields.lineName, n02Fields.railwayType, n02Fields.operatorType],
    expectedSourceRows: 21_933,
    expectedRows: 607
  },
  {
    id: ids.schools,
    input: 'P29/P29-23_GML/P29-23.geojson',
    columns: [
      { name: outputColumns.schoolName, source: p29Fields.name },
      { name: outputColumns.schoolType, source: p29Fields.schoolType },
      { name: outputColumns.adminType, source: p29Fields.adminType },
      { name: outputColumns.address, source: p29Fields.address }
    ],
    codeLabels: {
      [outputColumns.schoolType]: {
        '16001': '小学校',
        '16002': '中学校',
        '16003': '中等教育学校',
        '16004': '高等学校',
        '16005': '高等専門学校',
        '16006': '短期大学',
        '16007': '大学',
        '16011': '幼稚園',
        '16012': '特別支援学校',
        '16013': '幼保連携型認定こども園',
        '16014': '義務教育学校',
        '16015': '各種学校',
        '16016': '専修学校'
      },
      [outputColumns.adminType]: { '0': 'その他', '1': '国', '2': '都道府県', '3': '市区町村', '4': '民間' }
    },
    codeSource: p29Fields.code,
    labelColumn: outputColumns.schoolName,
    // School code and campus code: unique per row.
    orderBy: [p29Fields.schoolCode, p29Fields.campusCode],
    expectedSourceRows: 56_807,
    expectedRows: 56_807
  }
]);

/** A dataset of task 1.4: the settings a conversion cannot do without are present. */
export const sourceDatasetSchema = datasetConfigSchema.required({ orderBy: true, expectedSourceRows: true, expectedRows: true });
export type SourceDataset = z.infer<typeof sourceDatasetSchema>;

/** A point dataset: it also has a label column for its messages. */
export const pointDatasetSchema = sourceDatasetSchema.required({ labelColumn: true });
export type PointDataset = z.infer<typeof pointDatasetSchema>;

/** The configuration of one dataset; throws when it is not filled in. */
export function datasetConfig(id: string): DatasetConfig {
  const found = datasetConfigs.find((config) => config.id === id);
  if (found === undefined) throw new Error(`No conversion settings for dataset "${id}" in datasets.config.ts.`);
  return found;
}

/** The settings of a line or point dataset of task 1.4; throws when one of them is missing. */
export function sourceDataset(id: string): SourceDataset {
  return sourceDatasetSchema.parse(datasetConfig(id));
}

export function pointDataset(id: string): PointDataset {
  return pointDatasetSchema.parse(datasetConfig(id));
}

export const adminAreaConfig = {
  /** The key of `municipalities` (a `columns` entry whose source is `codeSource`). */
  codeColumn,
  /** `prefectures` is derived from the municipalities (no source of its own); its name column. */
  prefNameColumn,
  /** Output columns that are derived, not a plain copy of a source attribute. */
  muniNameColumn: 'muni_name',
  prefCodeColumn: 'pref_code',
  /** The source attribute that holds the municipality code (also the dissolve key of the simplification). */
  codeSource: n03Fields.code,
  citySource: n03Fields.city,
  /** The ward of a designated city: appended to the city name in `muni_name`. NULL for other rows. */
  wardSource: n03Fields.ward,
  /** Digits of a municipality code that form the prefecture code. */
  prefCodeLength: 2,
  /** Areas that belong to no municipality: the code ends in `000` and the city name is the label. */
  unassigned: { codeSuffix: '000', name: '所属未定地' },
  /** A run that yields another number of rows fails. */
  expectedRows: { municipalities: 1_898, prefectures: 47 }
} as const;

/** The columns the three point files end with, and how a point gets its municipality (decision 3 of task 1.4). */
export const placeConfig = {
  /** The point datasets, in the order the run converts them. */
  pointDatasets: [ids.landPrices, ids.stations, ids.schools],
  codeColumn,
  cityNameColumn,
  prefNameColumn,
  nearest: {
    /** A point that no polygon contains takes the code of the nearest polygon within this distance (metres); beyond it the code stays NULL. */
    limitMeters: 1_000,
    /** Candidate polygons are the ones whose bounding box is within this multiple of the limit, so that the box test never loses the nearest one. */
    candidateMarginFactor: 2
  },
  /** How a municipality code was found (the `muni_code_method` column of the work table). */
  methods: { source: 'source', containing: 'containing', nearest: 'nearest' }
} as const;

/** `land_prices`: the selection status that decides whether the change rate means anything. */
export const landPriceRules = {
  datasetId: ids.landPrices,
  rateColumn: outputColumns.changeRate,
  statusSource: l01Fields.status,
  /** 4: added this year (no previous price); 5: suspended. The source stores 0.0 as the change rate for both. */
  noRateStatuses: [4, 5],
  suspendedStatus: 5
} as const;

/** `stations`: the existence and duplicate codes of the adopted year (the codes of the source's code tables). */
export const stationRules = {
  datasetId: ids.stations,
  passengersColumn: outputColumns.passengers,
  duplicateSource: s12Fields.duplicate,
  existenceSource: s12Fields.existence,
  /** `duplicate`: 1 = the value is on this line's row. `existence`: 1 = data present. Only then the number is a number. */
  recordedHereCode: 1,
  dataExistsCode: 1,
  /** `existence`: 4 = no station; such rows are not kept. */
  noStationCode: 4
} as const;

/** `railways`: sections are dissolved by the four columns together, then simplified. */
export const railwayRules = {
  datasetId: ids.railways,
  /** Douglas-Peucker tolerance in metres (`conversionConfig.metersPerDegree` turns it into degrees). Chosen from the measurements in docs/data-sources.md. */
  simplifyToleranceMeters: 10,
  /** The run fails when the written file has more vertices. */
  vertexBudget: 150_000
} as const;

export const simplifyMethods = ['weighted', 'visvalingam', 'dp'] as const;

export const conversionConfigSchema = z.strictObject({
  dirs: z.strictObject({ raw: z.string(), work: z.string(), dist: z.string() }),
  /** File names inside `dirs.work`. */
  workFiles: z.strictObject({
    /** Raw polygons, not dissolved, not simplified, with the output attribute columns (for the point-in-polygon join of task 1.4). */
    municipalitiesRaw: z.string(),
    /** mapshaper's result: simplified, dissolved by municipality code, every part kept. */
    municipalitiesSimplified: z.string()
  }),
  simplify: z.strictObject({
    method: z.enum(simplifyMethods),
    /** Simplification interval in metres (mapshaper `interval=`). Shared edges are simplified once. */
    intervalMeters: z.number().positive()
  }),
  island: z.strictObject({
    /** A part smaller than this (square metres, on the ellipsoid) is dropped, unless it is the largest part of its municipality. */
    minAreaSquareMeters: z.number().positive()
  }),
  mapshaper: z.strictObject({
    /** The package's large-heap launcher, as a module path (resolved from node_modules; started with Node, never through a shell). */
    launcherModule: z.string().min(1),
    /** Snap nearly identical input points: the raw borders of neighbours differ in the last bits and would not be shared. */
    // The contact test of the island step (vertex equality) relies on it: with `false`, land enclaves would be dropped again.
    snap: z.boolean(),
    /** Heap size passed to the launcher. */
    heapGb: z.number().int().min(1)
  }),
  parquet: z.strictObject({
    rowGroupSize: z.number().int().positive(),
    compression: z.string().min(1)
  }),
  /**
   * Metres in one degree, for the two places that turn metres into degrees (the nearest-polygon search and the railway
   * simplification). The equatorial value of the WGS84 ellipsoid: coarse, but both uses only need an order of magnitude
   * (the railway tolerance is applied in degrees; see `railwayRules`).
   */
  metersPerDegree: z.number().positive(),
  /** A file is written as `<name><suffix>` in `dirs.work` and moved to `dirs.dist` only after its checks passed. */
  partialSuffix: z.string().min(1),
  /** Name of the geometry column of every output and of the work file. */
  geometryColumn: z.string().min(1),
  /** The command that fetches the raw data, named in the message when a raw file is missing. */
  downloadCommand: z.string().min(1)
});

export const conversionConfig = conversionConfigSchema.parse({
  dirs: { raw: 'data/raw', work: 'data/work', dist: 'data/dist' },
  workFiles: {
    municipalitiesRaw: 'municipalities_raw.parquet',
    municipalitiesSimplified: 'municipalities_simplified.geojson'
  },
  simplify: { method: 'weighted', intervalMeters: 250 },
  island: { minAreaSquareMeters: 100_000 },
  mapshaper: { launcherModule: 'mapshaper/bin/mapshaper-xl', snap: true, heapGb: 2 },
  parquet: { rowGroupSize: dataConfig.geoParquet.rowGroupSize, compression: dataConfig.geoParquet.compression },
  metersPerDegree: 111_320,
  partialSuffix: '.partial',
  geometryColumn: dataConfig.geoParquet.geometryColumn,
  downloadCommand: 'bash scripts/data/download.sh'
});

export type ConversionConfig = z.infer<typeof conversionConfigSchema>;

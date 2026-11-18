import { z } from 'zod';
import { datasetIds } from './datasets.config.js';

/**
 * The descriptive text of the catalog, as data (Japanese: the model reads it and the users' questions are Japanese).
 * Everything that can be measured (column names and types, row counts, extents, value ranges, top values) is measured
 * by `npm run data:catalog`; only what a file cannot tell is written here. The facts come from `docs/data-sources.md`
 * (sections 1, 2, 5 and 6.7). Per dataset: the title, what one row is, the source, the cautions for a query or a
 * style, and per column its meaning (with the unit and the shape of the value where a query must match it).
 * The generator fails when a file has a column without a text here, or a text here names a column the file does not have.
 */

/** Where the generated catalog is written (`shared/catalog.json`), relative to the repository root. */
export const catalogFile = 'shared/catalog.json';

/** The command that writes the dataset files, named in the message when one is missing. */
export const convertCommand = 'npm run data:convert';

export const valuesKindSchema = z.enum(['all', 'top']);

export type ValuesKind = z.infer<typeof valuesKindSchema>;

export const columnTextSchema = z.strictObject({
  name: z.string().min(1),
  description: z.string().min(1),
  unit: z.string().min(1).optional(),
  /** List the values of this column in the catalog, with the number of distinct values: `all` of them (a categorical column), or the most frequent ones (`top`, a name column). */
  values: valuesKindSchema.optional()
});

export const datasetTextSchema = z.strictObject({
  id: z.string().min(1),
  title: z.string().min(1),
  /** What one row is. */
  description: z.string().min(1),
  source: z.strictObject({ name: z.string().min(1), url: z.string().min(1), year: z.string().min(1), license: z.string().min(1) }),
  columns: z.array(columnTextSchema).min(1),
  notes: z.array(z.string().min(1)).optional()
});

export type ColumnText = z.infer<typeof columnTextSchema>;
export type DatasetText = z.infer<typeof datasetTextSchema>;

const ksjPage = (code: string, edition: string): string => `https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-${code}-${edition}.html`;

/** The licence is named by its own name, `CC BY 4.0`; the pages write `CC_BY_4.0`. */
const ksjOpenData = 'オープンデータ（CC BY 4.0）';

/** N03 is used for a technical verification only (docs/data-sources.md 1.0): the licence text says so. */
const n03Source = {
  name: '国土数値情報（行政区域データ）（国土交通省）',
  url: ksjPage('N03', '2026'),
  year: '2026年（令和8年）版（1月1日時点）',
  license: `${ksjOpenData}。同梱メタデータに測量法の承認の記載があり、技術検証の範囲でのみ利用する（一般公開・配布・商用の前に、国土交通省へ測量法上の扱いを問い合わせる）`
} as const;

/** The caution about municipality names that holds for `city_name` and `muni_name` alike. */
const nameCommon =
  '都道府県をまたいで同じ名前がある（25 名。例: 府中市は東京都と広島県）。市区町村を一意に決めるのは muni_code だけで、集計と結合は muni_code で行い、名前は表示に使う。名前で絞るときは必ず pref_name を含める';

/** What `pref_name` + `city_name` selects, and the one village that stays ambiguous (the two 泊村 of 北海道). */
const tomariVillages = '北海道の泊村は 2 つあり、muni_code は 01403 と 01696';

const prefNameText = {
  name: 'pref_name',
  description: '都道府県名。都・道・府・県をつけた名称（例: 北海道、東京都、大阪府、青森県）で、すべてのテーブルで同じ表記。クエリでは、この表記のまま一致させる'
} as const;

/** `city_name` of the point datasets (the same meaning as in `municipalities`). */
const pointCityNameText = {
  name: 'city_name',
  description: `市区町村名（municipalities.city_name と同じ。政令指定都市の区は市名）。${nameCommon}。pref_name と city_name で、政令指定都市はその全区の点が選ばれる（1 つの区に絞るには、muni_code で municipalities を結合し、その muni_name で絞る）。${tomariVillages}`
} as const;

const muniCodeText = {
  name: 'muni_code',
  description: '全国地方公共団体コード（5 桁の文字列。例: 01101）。先頭 2 桁が都道府県コード。municipalities.muni_code と同じ形で、結合キーになる'
} as const;

const operatorText = {
  name: 'operator',
  description: '運営会社名（例: 東日本旅客鉄道、東京地下鉄）。完全に一致させる',
  values: 'top'
} as const;

const operatorTypeLabels = 'JRの新幹線、JR在来線、公営鉄道、民営鉄道、第三セクター';

export const datasetTexts: DatasetText[] = z.array(datasetTextSchema).parse([
  {
    id: 'municipalities',
    title: '市区町村の境界',
    description: '全国の市区町村の境界（面）。1 行は 1 つの市区町村（muni_code 1 つにつき 1 行）。',
    source: n03Source,
    columns: [
      muniCodeText,
      { ...prefNameText, values: 'top' },
      {
        name: 'city_name',
        description: `市区町村名。政令指定都市の区の行では区名を含まない市名（例: 札幌市）。特別区（東京 23 区）は区名。${nameCommon}。pref_name と city_name で、政令指定都市は全区の行が選ばれる。${tomariVillages}`
      },
      {
        name: 'muni_name',
        description: `市区町村名。政令指定都市の区は市名に区名を続ける（例: 札幌市中央区）。区のない市町村と特別区は city_name と同じ。${nameCommon}。pref_name と muni_name で 1 つの市区町村に決まる（例外は ${tomariVillages}）`
      }
    ],
    notes: [
      '政令指定都市は区ごとに 1 行で、市全体の行はない。',
      '市区町村名は都道府県をまたいで重複する（25 名。例: 府中市は東京都と広島県、伊達市は北海道と福島県）。市区町村を一意に決めるのは muni_code だけ。集計と結合は muni_code で行い、名前は表示用。1 つの市区町村に名前で絞るときは pref_name と muni_name を使う（北海道の泊村だけは 2 つあるので muni_code を使う）。pref_name と city_name では、政令指定都市の全区の行が選ばれる。',
      '所属未定地（コードが「000」で終わる行）は含まない。',
      '境界は簡素化してあり、面積が 0.1 km² 未満で他の市区町村に接しない小さな島は除いてある。面積の計算や、精密な境界を使う解析には使わない。',
      '点のデータ（land_prices、stations、schools）の市区町村別の集計は、空間結合ではなく muni_code の結合で行う（全行に muni_code が入っていて、NULL はない）。簡素化した境界では、境界の近くで点が別の市区町村に入ることがある。'
    ]
  },
  {
    id: 'prefectures',
    title: '都道府県の境界',
    description: '全国の都道府県の境界（面）。1 行は 1 つの都道府県。municipalities と同じ行政区域のデータから、市区町村を都道府県で統合して作る。',
    source: n03Source,
    columns: [
      {
        name: 'pref_code',
        description: '都道府県コード（2 桁の文字列。例: 01）。municipalities.muni_code の先頭 2 桁と同じ'
      },
      prefNameText
    ],
    notes: [
      '境界は簡素化した市区町村を統合したもので、小さな島は除いてある。面積の計算や、精密な境界を使う解析には使わない。',
      '点のデータ（land_prices、stations、schools）の都道府県別の集計は、空間結合ではなく pref_name で行う（全行に pref_name が入っていて、NULL はない）。簡素化した境界では、境界の近くで点が別の都道府県に入ることがある。'
    ]
  },
  {
    id: 'land_prices',
    title: '地価公示（標準地）',
    description: '地価公示の標準地の点。1 行は標準地 1 か所で、2026 年（令和 8 年）1 月 1 日時点の価格が入る。',
    source: {
      name: '国土数値情報（地価公示データ）（国土交通省）',
      url: ksjPage('L01', '2026'),
      year: '2026年（令和8年）版（1月1日時点）',
      license: ksjOpenData
    },
    columns: [
      { name: 'price_yen_per_m2', description: '地価公示価格（整数）', unit: '円/㎡' },
      {
        name: 'yoy_change_pct',
        description: '対前年変動率（小数第 1 位）。NULL は、新設・選定替えで当該年に追加された標準地と、隔年調査の休止地点',
        unit: '%'
      },
      {
        name: 'land_use',
        description: '用途区分のラベル（日本語の文字列）。利用の現況ではない',
        values: 'all'
      },
      {
        name: 'address',
        description: '所在地番。都道府県名から始まり、そのあとに全角空白が入る。数字は全角（例: 北海道　札幌市中央区大通西２８丁目２０３番１０）'
      },
      { ...muniCodeText, description: `標準地の属性にある${muniCodeText.description}` },
      pointCityNameText,
      prefNameText
    ],
    notes: [
      'yoy_change_pct が NULL の行は、変動がないのではなく、前年と比べられない標準地。NULL を 0 として扱わない。NULL でない 0.0 は本当の 0.0。',
      '価格の偏りは大きい（最小 470、中央値 83,000、最大 67,100,000）。階級に分けるときは、等間隔ではなく分位数を使う。',
      'land_use は用途区分で、利用の現況ではない。',
      'address は都道府県名のあとに全角空白が入り、数字は全角（例: 北海道　札幌市中央区大通西２８丁目２０３番１０）。schools.address は都道府県名のあとに空白がなく、数字は半角（17 件は、番地などのあとに全角空白がある）。LIKE で合わせるときは、それぞれの形で書く。',
      '市区町村別・都道府県別の集計は、空間結合ではなく muni_code と pref_name で行う（全行に入っていて、NULL はない）。簡素化した境界では、境界の近くの点が別の側に入ることがある。'
    ]
  },
  {
    id: 'stations',
    title: '駅別乗降客数',
    description: '駅別乗降客数（2024 年度）の点。1 行は駅 × 路線の線 1 本で、点はその線の重心。',
    source: {
      name: '国土数値情報（駅別乗降客数データ）（国土交通省）',
      url: ksjPage('S12', '2024'),
      year: '2024年度（令和6年度）版',
      license: ksjOpenData
    },
    columns: [
      { name: 'station_name', description: '駅名（例: 渋谷）。同名の別の駅がある' },
      operatorText,
      { name: 'line_name', description: '路線名（例: 東横線、山手線）。同じ路線名が複数の運営会社にある' },
      {
        name: 'passengers_per_day',
        description: '2024 年度の 1 日あたりの乗降客数（整数）。NULL は、データなし・非公開・他の路線の行にまとめて記載、のどれか',
        unit: '人/日'
      },
      muniCodeText,
      pointCityNameText,
      prefNameText
    ],
    notes: [
      '1 行は駅 × 路線なので、乗り換え駅は路線ごとに行がある。行数は駅の数ではない。駅名だけで重複を除くと、同名の別の駅を 1 つにまとめてしまう。',
      '点は駅の位置ではなく、元の線の重心。曲がった線では、重心が線から外れることがある。',
      'passengers_per_day が NULL の行は 0 人ではない。NULL を 0 として扱わない。0 の行は本当の 0。',
      '乗り換え駅では、1 つの路線の行に他の路線の分を含む値が入り、他の路線の行は NULL。路線別の値としては読めない。駅ごとの合計は、NULL でない行をそのまま足せばよい（二重には数えない）。',
      '乗降客数は各事業者が独自に算出した値で、基準が統一されていない。東日本旅客鉄道と北海道旅客鉄道の無人駅はデータなし、九州旅客鉄道は上位 300 駅以外が非公開で、NULL になる。',
      '2024 年度に駅がない行（廃線など）は含めない。',
      '駅を一意に識別する列はない。同じ駅・運営会社・路線が複数の行になることがあり（10,263 行に対し station_name・operator・line_name の組は 10,153 種）、路線ごとや運営会社ごとの行数は駅の数より多くなる。同名の別の駅があるので、station_name だけでは駅を区別できない。station_name と muni_code の組も近似にすぎない（station_name と operator が同じで muni_code が複数ある組が 21 ある）。',
      '運営会社名は stations と railways で一致するとは限らない（stations の 新京成電鉄 と 泉北高速鉄道 は railways にない）。operator と line_name の組での結合は行を落とす（stations の 596 組のうち 2 組が railways にない）。',
      '市区町村別・都道府県別の集計は、空間結合ではなく muni_code と pref_name で行う（全行に入っていて、NULL はない）。簡素化した境界では、境界の近くの点が別の側に入ることがある。'
    ]
  },
  {
    id: 'railways',
    title: '鉄道路線',
    description: '鉄道路線の線。1 行は 1 つの路線（路線名・運営会社・鉄道区分・事業者種別が同じ区間をまとめたもの）。',
    source: {
      name: '国土数値情報（鉄道データ）（国土交通省）',
      url: ksjPage('N02', '2025'),
      year: '2025年度（令和7年度）版（12月31日時点）',
      license: ksjOpenData
    },
    columns: [
      {
        name: 'line_name',
        description: '路線名（例: いわて銀河鉄道線、東北線）。JR の部分名のことがあり、「東北本線」のような運行系統の名前とは合わないことがある'
      },
      operatorText,
      {
        name: 'operator_type',
        description: `事業者種別のラベル（日本語の文字列）: ${operatorTypeLabels}`,
        values: 'all'
      },
      {
        name: 'railway_type',
        description: '鉄道区分のラベル（日本語の文字列。例: 普通鉄道JR、普通鉄道、軌道、鋼索鉄道）',
        values: 'all'
      }
    ],
    notes: [
      'ジオメトリの型（LINESTRING と MULTILINESTRING）では、途切れた路線かどうかは分からない。MULTILINESTRING の約 9 割は、分岐・合流があるだけで、すべてつながっている。',
      '同じ運営会社・同じ路線名でも、鉄道区分が区間で違えば 2 行になる（10 組）。路線の数や路線ごとの延長は、operator と line_name で集約する。',
      '同じ line_name が複数の運営会社に現れる（例:「本線」）。line_name だけで絞らず、operator も使う。',
      '線は 10 m の許容差で簡素化してある。線どうしの接続を使う解析（ST_Intersects や ST_Touches で「X 線と接続する路線」を求めるなど）には使わない（接していた路線の組の約 1 割が接しなくなっている）。総延長は簡素化前から −0.085% で、延長の集計には使える。',
      '駅の位置は stations の座標とは別のデータで、stations の点が線の上にあるとは限らない。',
      '運営会社名は stations と railways で一致するとは限らない（stations の 新京成電鉄 と 泉北高速鉄道 は railways にない。railways の泉北の線は 南海電気鉄道の「泉北線」で、えちぜん鉄道の 1 行は operator と line_name が入れ替わっている）。operator と line_name の組での結合は行を落とす（railways の 597 組のうち 3 組が stations にない）。'
    ]
  },
  {
    id: 'schools',
    title: '学校',
    description: '学校の点。1 行は学校 1 キャンパスで、キャンパスが複数ある学校は複数行になる。',
    source: {
      name: '国土数値情報（学校データ）（国土交通省）',
      url: ksjPage('P29', '2023'),
      year: '2023年度（令和5年度）版',
      license: ksjOpenData
    },
    columns: [
      { name: 'school_name', description: '学校名（例: 北海道教育大学附属函館幼稚園）' },
      {
        name: 'school_type',
        description: '学校分類のラベル（日本語の文字列。例: 小学校、中学校、高等学校、大学、幼稚園）',
        values: 'all'
      },
      {
        name: 'admin_type',
        description: '設置者のラベル（日本語の文字列）: 国、都道府県、市区町村、民間、その他。民間は私立などを指す',
        values: 'all'
      },
      {
        name: 'address',
        description: '所在地。都道府県名から始まり、空白なしで市区町村名（郡名を含むことがある）が続く。数字は半角（例: 北海道函館市美原3-48-6）。pref_name と違う都道府県で始まる行が 6 行ある（例: 東京都町田市…で pref_name は神奈川県）。land_prices.address とは、都道府県名のあとに全角空白がなく、全角数字を使わない点で形が違う'
      },
      muniCodeText,
      pointCityNameText,
      prefNameText
    ],
    notes: [
      '1 行は学校 1 キャンパスなので、行数は学校の数ではない（学校名と所在地が同じ行も 2 組ある）。',
      '開校中か休校中かを区別する列はない（元のデータの休校区分は、約半数が「調査なし」で、保持していない）。',
      '中央区立の学校 3 件（中央区立泰明小学校、中央区立泰明幼稚園、中央区立城東小学校）は、元のデータの muni_code が千代田区（13101）で、city_name も千代田区になる。元のコードの誤りの可能性が高い。',
      '浜松市の旧区のコード（22131〜22137）の学校は、座標から新区のコード（22138〜22140）に付け替えてある。',
      '市区町村別・都道府県別の集計は、空間結合ではなく muni_code と pref_name で行う（全行に入っていて、NULL はない）。簡素化した境界では、境界の近くの点が別の側に入ることがある。'
    ]
  }
]);

const ids = datasetTexts.map((text) => text.id);
if (ids.length !== datasetIds.length || ids.some((id, index) => id !== datasetIds[index])) {
  throw new Error(`catalog.config.ts: the dataset texts (${ids.join(', ')}) are not the datasets of datasets.config.ts (${datasetIds.join(', ')}), in that order.`);
}

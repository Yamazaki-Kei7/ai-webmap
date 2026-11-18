import type { ClientToolRequest } from './toolProtocol.js';

/**
 * The worked examples of the system prompt (`prompt.ts`): a request and the tool calls the model should make for it.
 * They are typed `ClientToolRequest`, so a call that the tool schemas reject does not compile, and the tests run every
 * example SQL through the SQL guard. The prompt prints them from this array, so what the tests check is what the model reads.
 */
export type PromptExample = {
  title: string;
  /** What the user says. */
  request: string;
  /** The tool calls, in order. Empty when the right answer is to decline. */
  calls: readonly ClientToolRequest[];
  /** The answer to the user in words, when the example has no tool call. */
  reply?: string;
};

export const promptExamples: readonly PromptExample[] = [
  {
    title: '条件で絞った点のレイヤー',
    request: '東京都の大学を地図に出して',
    calls: [
      {
        tool: 'addLayer',
        input: {
          name: '東京都の大学',
          sql: "SELECT school_name, school_type, admin_type, city_name, geom FROM schools WHERE pref_name = '東京都' AND school_type = '大学'",
          style: { type: 'single', color: '#377eb8' }
        }
      }
    ]
  },
  {
    title: '集計して塗り分ける（コロプレス）',
    request: '市区町村ごとの学校の数を色の濃さで見せて',
    calls: [
      {
        tool: 'addLayer',
        input: {
          name: '市区町村別の学校数',
          sql: 'WITH c AS (SELECT muni_code, count(*) AS school_count FROM schools GROUP BY muni_code) SELECT m.muni_code, m.pref_name, m.muni_name, coalesce(c.school_count, 0) AS school_count, m.geom FROM municipalities m LEFT JOIN c ON c.muni_code = m.muni_code',
          style: { type: 'graduated', column: 'school_count', method: 'quantile', classes: 5, palette: 'ylorrd' }
        }
      }
    ]
  },
  {
    title: '値の大きさを円の大きさで見せる（駅ごとに 1 点、ラベル付き）',
    request: '東京都の駅の乗降客数を円の大きさで見せて。駅名も出して',
    calls: [
      {
        tool: 'addLayer',
        input: {
          name: '東京都の駅の乗降客数',
          sql: "SELECT station_name, sum(passengers_per_day) AS passengers_per_day, any_value(geom) AS geom FROM stations WHERE pref_name = '東京都' GROUP BY pref_name, station_name",
          style: { type: 'proportional', column: 'passengers_per_day', color: '#e41a1c', minRadius: 3, maxRadius: 30, opacity: 0.6 },
          label: { column: 'station_name', size: 11 }
        }
      }
    ]
  },
  {
    title: '種類で色分けした線のレイヤー',
    request: '鉄道路線を事業者の種類で色分けして',
    calls: [
      {
        tool: 'addLayer',
        input: {
          name: '鉄道路線（事業者種別）',
          sql: 'SELECT line_name, operator, operator_type, railway_type, geom FROM railways',
          style: { type: 'categorized', column: 'operator_type', palette: 'set2', size: 2 }
        }
      }
    ]
  },
  {
    title: '距離で選ぶ（先に度で粗く絞り、あとでメートルで測る。どちらも点どうし）',
    request: '東京都新宿区の学校から 500 m 以内にある駅を見せて',
    calls: [
      {
        tool: 'addLayer',
        input: {
          name: '新宿区の学校から500m以内の駅',
          sql: "SELECT st.station_name, st.operator, st.line_name, st.geom FROM stations st WHERE EXISTS (SELECT 1 FROM schools sc WHERE sc.pref_name = '東京都' AND sc.city_name = '新宿区' AND ST_DWithin(st.geom, sc.geom, 0.01) AND ST_DWithin_Spheroid(ST_FlipCoordinates(st.geom), ST_FlipCoordinates(sc.geom), 500))",
          style: { type: 'single', color: '#984ea3', size: 6 }
        }
      }
    ]
  },
  {
    title: '既存のレイヤーのスタイルを変える',
    request: '（地図に L2「市区町村別の学校数」があり、その columns に school_count がある）L2 の色を青の 4 段階の等間隔にして',
    calls: [
      {
        tool: 'setLayerStyle',
        input: { layerId: 'L2', style: { type: 'graduated', column: 'school_count', method: 'equal', classes: 4, palette: 'blues' } }
      }
    ]
  },
  {
    title: '色を変えると名前が合わなくなるときは、name も付ける',
    request: '（地図に L3「赤い駅」がある）L3 を青にして',
    calls: [
      {
        tool: 'setLayerStyle',
        input: { layerId: 'L3', style: { type: 'single', color: '#377eb8' }, name: '駅' }
      }
    ]
  },
  {
    title: '既存のレイヤーのデータを入れ替える（style を付けると、それが新しいスタイルになる）',
    request: '（地図に L1 がある）L1 を大阪府の大学に変えて',
    calls: [
      {
        tool: 'addLayer',
        input: {
          name: '大阪府の大学',
          sql: "SELECT school_name, school_type, admin_type, city_name, geom FROM schools WHERE pref_name = '大阪府' AND school_type = '大学'",
          style: { type: 'single', color: '#377eb8' },
          replaceLayerId: 'L1'
        }
      }
    ]
  },
  {
    title: '値を調べるだけ',
    request: '東京都で乗降客数がいちばん多い駅はどこ？',
    calls: [
      {
        tool: 'runQuery',
        input: {
          sql: "SELECT station_name, sum(passengers_per_day) AS passengers FROM stations WHERE pref_name = '東京都' GROUP BY pref_name, station_name ORDER BY passengers DESC NULLS LAST LIMIT 5"
        }
      }
    ],
    reply: '東京都で乗降客数がいちばん多いのは渋谷駅で、1 日あたり約 290 万人です。2 位は新宿駅、3 位は池袋駅です。（結果の行を日本語で伝える。地図には描かない）'
  },
  {
    title: '場所へ移動する',
    request: '札幌市中央区を見せて',
    calls: [
      {
        tool: 'setView',
        input: {
          target: { type: 'query', sql: "SELECT geom FROM municipalities WHERE pref_name = '北海道' AND muni_name = '札幌市中央区'" }
        }
      }
    ]
  },
  {
    title: 'データにないことは断る',
    request: '市区町村ごとの人口を地図にして',
    calls: [],
    reply:
      'このデータには人口がありません。代わりに、市区町村ごとの学校の数、駅の乗降客数の合計、地価公示の価格なら地図にできます。どれを見たいですか？'
  }
];

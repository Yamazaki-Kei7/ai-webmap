/** Application settings shared by the frontend and the backend (design 9.2). */

import { conversationErrors } from './conversation';
import { mapsErrors } from './maps';

export const modelConfig = {
  modelId: 'jp.anthropic.claude-haiku-5-5'
} as const;

export const agentConfig = {
  maxLlmCalls: 24,
  maxToolIterations: 24,
  /** Longest user message, in characters (Unicode code points: an emoji counts as one). */
  maxUtteranceChars: 2_000,
  /** Most interrupt answers one `agentResume` call carries (parallel tool calls arrive together). */
  maxInterruptResponses: 16,
  /** Longest interrupt id (characters) an answer may name. */
  maxInterruptIdChars: 256
} as const;

export const queryConfig = {
  maxFeaturesPerLayer: 100_000,
  timeoutMs: 30_000,
  /** After `cancelSent()`, wait this long before `worker.terminate()`. */
  cancelGraceMs: 5_000,
  /** Maximum rows returned by `runQuery`. */
  maxRows: 50,
  /** Longest SQL text (characters) the SQL guard accepts. */
  maxSqlChars: 10_000,
  /** Longest DuckDB error text (characters) a query answers to the agent. */
  maxErrorChars: 300
} as const;

export const resultConfig = {
  /** UTF-8 bytes of the JSON string of one tool result. */
  maxToolResultBytes: 16 * 1024,
  /** Total of the results returned together in one response. */
  maxTotalResultBytes: 64 * 1024
} as const;

/**
 * The six tools the model calls (`shared/toolProtocol.ts`): the limits of their inputs and of the results they answer with.
 * The caps of columns, warnings and texts in an `addLayer` / `setLayerStyle` answer are the ones of the map summary (`mapConfig.summary*`).
 */
export const toolConfig = {
  /** Longest layer name (characters) the model may give. */
  maxLayerNameChars: 40,
  /** Most columns a `runQuery` result lists (the others are left out of the columns and the rows). */
  maxQueryColumns: 30,
  /** Most layer ids `removeLayer` lists as remaining. */
  maxResultLayers: 100,
  /** Most field paths a rejected request names in its `INVALID_INPUT` message. */
  maxIssuePaths: 5,
  /** Decimals of the centre and the zoom `setView` reports (about 10 m of longitude). */
  viewDecimals: 4
} as const;

/** The texts of the save / open / new UI (`src/lib/components/MapBar.svelte` and its dialogs); `{n}` and `{id}` are filled in by the caller. */
const mapsTexts = {
  untitled: '無題の地図',
  /** The title shown while a map is being opened (the one on the screen is no longer the one that counts). */
  loadingTitle: '読み込み中',
  save: '保存',
  open: '開く',
  newMap: '新規作成',
  cancel: 'キャンセル',
  unsavedMark: '●',
  unsavedLabel: '（保存されていない変更があります）',
  saved: '保存しました',
  restoreFailedLayers: '{n} 枚のレイヤーを復元できませんでした',
  restoreProgress: '地図を復元しています（{done}/{total}）',
  /** Why 開く is disabled: the layers are rebuilt by the data engine. */
  openNeedsEngine: 'データエンジンの準備ができるまで開けません',
  saveDialog: {
    title: '地図を保存',
    titleLabel: '地図の名前',
    titleHint: '{max} 文字まで',
    saveAsNew: '新しい地図として保存',
    saving: '保存しています…',
    /** The refusals before the call: the state cannot be saved at all. */
    tooManyLayers: 'レイヤーが多すぎるため保存できません（上限 {n} 枚）',
    invalid: 'この地図の状態は保存できません',
    /** The title field is empty (or only spaces). */
    titleRequired: '名前を入力してください'
  },
  openDialog: {
    title: '地図を開く',
    loading: '読み込み中…',
    empty: '保存された地図はありません。',
    open: '開く',
    remove: '削除',
    close: '閉じる',
    /** Names the map in the accessible name of its buttons. */
    openLabel: '「{title}」を開く',
    removeLabel: '「{title}」を削除',
    confirmRemove: '「{title}」を削除しますか。元に戻せません。',
    confirmRemoveAction: '削除する',
    removing: '削除しています…',
    removed: '削除しました',
    /** Opening a map throws away what is not saved: asked first. */
    confirmDiscard: '保存されていない変更があります。破棄して開きますか',
    discardAndOpen: '破棄して開く',
    opening: '開いています…',
    updatedAt: '更新'
  },
  newDialog: {
    confirmDiscard: '保存されていない変更があります。破棄して新しい地図を作りますか',
    discardAndNew: '破棄して新規作成'
  },
  /** An error name (`shared/maps.ts`) → the message of each action. Any other failure (a lost connection included) shows `generic`; never its own text. */
  errors: {
    save: {
      [mapsErrors.Conflict]: '別の画面でこの地図が変更されました。開き直してから保存してください',
      [mapsErrors.LimitReached]: '保存できる地図の数（上限 {n} 件）に達しました。不要な地図を削除してください',
      [mapsErrors.InvalidRequest]: '保存できない内容が含まれています',
      [mapsErrors.NotFound]: 'この地図は削除されています。新しい地図として保存しますか',
      [conversationErrors.NotFound]: '会話が見つかりません。少し待ってからもう一度保存してください',
      generic: '保存できませんでした。接続を確かめて、もう一度お試しください'
    } as Readonly<Record<string, string>>,
    /** The layer a 400 names, added to the message. */
    invalidLayer: '（レイヤー {id}）',
    list: {
      generic: '地図の一覧を読み込めませんでした。接続を確かめて、もう一度お試しください'
    } as Readonly<Record<string, string>>,
    open: {
      [mapsErrors.NotFound]: 'この地図は見つかりません。削除された可能性があります',
      [mapsErrors.Corrupt]: 'この地図は壊れていて開けません',
      generic: '地図を開けませんでした。接続を確かめて、もう一度お試しください',
      /** The map's own state could not be used (the browser refused it). */
      invalidState: 'この地図は開けない内容です'
    } as Readonly<Record<string, string>>,
    remove: {
      [mapsErrors.NotFound]: 'この地図はすでに削除されています',
      generic: '削除できませんでした。接続を確かめて、もう一度お試しください'
    } as Readonly<Record<string, string>>
  }
} as const;

/** Saved maps (`shared/persistedMap.ts`, `aws-blocks/maps*.ts`): the limits of one map and of one user's collection. */
export const mapsConfig = {
  /** Title length, in characters (Unicode code points). */
  title: { minChars: 1, maxChars: 80 },
  /** Most layers one saved map holds. */
  maxLayers: 20,
  /** The whole persisted state as JSON (UTF-8 bytes): well below the 400 KB of a table item, and a layer's SQL (`queryConfig.maxSqlChars`) alone may not fill it. */
  maxStateBytes: 64 * 1024,
  /** Most maps one user keeps; saving a new one beyond it is refused (409). Listing reads all of them, so the cap also bounds that read. */
  maxMapsPerUser: 100,
  /**
   * Which view changes count as unsaved changes: panning and zooming a little does not. The view is changed when the zoom
   * differs by `zoomLevels` or more, or the centre has moved by `centerTiles` or more map tiles (of 360 / 2^zoom degrees) at the saved zoom.
   */
  unsavedViewChange: { zoomLevels: 0.5, centerTiles: 0.25 },
  /** How long the line 「保存しました」 stays (milliseconds). */
  noticeMs: 4_000,
  /** The language of the list's dates. */
  dateLocale: 'ja-JP',
  text: mapsTexts
} as const;

/** The system prompt (`shared/prompt.ts`). */
export const promptConfig = {
  /** Longest system prompt, in characters: it is sent with every model call. */
  maxChars: 40_000,
  /** After this many failures of one kind in a row the model stops and tells the user. */
  maxRepeatedFailures: 3,
  /** A coarse `ST_DWithin` before a `_spheroid` test: metres divided by this are enough (a degree of longitude is at least about 78 km in Japan). */
  coarseMetresPerDegree: 70_000,
  /** `ST_DWithin` alone, for lines and polygons: metres divided by this give a degree value that is right within about 20 % in Japan. */
  approxMetresPerDegree: 100_000
} as const;

export const urlConfig = {
  signedUrlTtlSeconds: 60 * 60,
  /** The browser fetches the dataset sources again before a lazy data fetch when the held URLs expire within this time. */
  refreshMarginSeconds: 300
} as const;

/** The browser's DuckDB-WASM engine (`src/lib/duckdb/`). */
export const engineConfig = {
  /** `SET threads`: the `eh` build has no worker threads, so one. */
  threads: 1,
  /** `SET memory_limit`: DuckDB's own cap, below the 4 GB a WebAssembly memory can reach. */
  memoryLimit: '2GB',
  /**
   * An initialisation (sources, worker, wasm, spatial, settings) that is not done by then fails with an error and
   * can be retried. Well above the measured ~2 s (worst of the spike 5.4 s): it also covers a 34 MB wasm on a slow line.
   */
  initTimeoutMs: 30_000,
  /**
   * A data file's fetch (the response and its body) that is not done by then is aborted, and the next query fetches
   * it again. It caps the whole fetch, not a stall: a fetch that is still making progress is aborted too. Not
   * `queryConfig.timeoutMs`: a large file on a slow line may rightly take longer than one query, and would then be
   * aborted on every try. The data files are about 2 MB or less, so in practice only a fetch that hangs reaches it.
   */
  dataFetchTimeoutMs: 120_000,
  /** Longest error text (characters) the engine reports to the UI. */
  maxErrorChars: 200
} as const;

export const dataConfig = {
  duckdbWasmVersion: '1.32.0',
  geoParquet: {
    rowGroupSize: 2_048,
    pointSortKey: 'muni_code',
    compression: 'zstd',
    /** Name of the geometry column of every dataset file (the browser and the prompt need it too). */
    geometryColumn: 'geom'
  },
  /** The dataset catalog (`shared/catalog.json`, generated by `npm run data:catalog`). */
  catalog: {
    /** Most values a name column lists in `topValues` (the most frequent ones). */
    topValuesLimit: 10,
    /** Most distinct values a categorical column may have: it lists all of them in `topValues`, and the run fails above this. */
    allValuesLimit: 20,
    /** Decimals of the bounding boxes: rounded outward (minimum down, maximum up). */
    bboxDecimals: 5,
    /** Largest minified JSON of the whole catalog, in characters: it goes into the model's prompt. */
    maxJsonChars: 24_000
  },
  classification: {
    maxCategories: 12,
    defaultClasses: 5,
    minClasses: 2,
    maxClasses: 9
  }
} as const;

/** Limits and defaults of the layer styles and labels the model sets (`shared/mapSpec.ts`, resolved in `src/lib/map/styleCompiler.ts`). */
export const styleConfig = {
  /** Longest column name (characters) a style or label may name. */
  maxColumnChars: 128,
  /** Longest layer id (characters) a view target may name. */
  maxLayerIdChars: 64,
  /** Longest category value (characters) an `overrides` key may name. */
  maxCategoryValueChars: 200,
  opacity: { min: 0, max: 1 },
  /** Upper bounds (pixels) of the positive widths and sizes; the lower bound is above zero. */
  maxStrokeWidth: 20,
  /** Point radius and line width (pixels). */
  maxSize: 50,
  /** Upper bound (pixels) of a proportional symbol's `minRadius` and `maxRadius`. */
  maxRadius: 100,
  maxLabelSize: 48,
  maxHaloWidth: 10,
  /** The zoom levels of the basemap. */
  zoom: { min: 0, max: 22 },
  defaults: {
    /** By geometry: a polygon is lighter, so that the basemap stays readable under it. */
    opacity: { polygon: 0.45, line: 0.7, point: 0.7 },
    strokeColor: '#ffffff',
    strokeWidth: 1,
    /** Point radius and line width (pixels); a polygon has no `size`, its outline is `strokeWidth`. */
    size: { point: 5, line: 2 },
    categorizedPalette: 'set2',
    graduatedPalette: 'ylorrd',
    /** Radii (pixels) of the smallest and the largest proportional symbol. */
    minRadius: 3,
    maxRadius: 30
  },
  /** Colour of the categories folded into "other" (not of the features without a value: `noDataColor`). */
  otherColor: '#9e9e9e',
  /** Colour of the features without a value in the styled column; a light grey, apart from `otherColor`. */
  noDataColor: '#d9d9d9',
  /** Most column names listed in the hint of an unknown-column error. */
  maxHintColumns: 20,
  /** What a label takes when the model leaves the value out. */
  /** Radius (pixels) of the proportional symbols of features without a number: drawn small, in `noDataColor`. */
  noDataRadius: 2,
  labelDefaults: { size: 12, color: '#222222', haloColor: '#ffffff', haloWidth: 1.5, minZoom: 0 }
} as const;

/** The legend and the data attribution shown with the layers (`src/lib/map/legend.ts`, `src/lib/components/`). */
export const legendConfig = {
  /** Locale of every number in the layer panel (digit grouping). */
  numberLocale: 'ja-JP',
  /** A legend number shows at most this many decimals, or this many significant digits when that is more precise (small values keep their digits). */
  maxFractionDigits: 2,
  maxSignificantDigits: 2,
  text: {
    other: 'その他',
    noData: '値なし',
    emptyValue: '（空）',
    /** Class intervals are half-open: "a 以上 b 未満", and the top class "a 以上". */
    atLeast: '以上',
    lessThan: '未満',
    /** A class (from manual breaks) that no data falls in. */
    noMatch: '（該当なし）',
    /** The note when the proportional symbols are drawn smaller than on the map; `{n}` is the factor. */
    scaleNote: '縮尺：地図の 1/{n}'
  },
  /** The legend draws a proportional symbol with a radius of at most this many pixels; larger ones are all scaled down by one factor. */
  maxSymbolRadiusPx: 36,
  /** The factor of the scale note is shown with this many decimals. */
  scaleNoteDecimals: 1,
  /** The data attribution: a line that is always shown while a layer is, and the list of sources behind its toggle. */
  attribution: {
    /** `{publisher}` is the first publisher (`attribution.ts`); `{n}` the number of the other publishers. */
    line: '出典：{publisher}を加工して作成',
    lineMore: '出典：{publisher}ほか {n} 件を加工して作成',
    /** The licence label (the catalog's own `license` field is an internal note and is not shown). */
    licenseLabel: 'CC BY 4.0',
    details: '詳細',
    /** Most height (pixels) of the list of sources; it scrolls beyond. */
    maxListPx: 160
  }
} as const;

const answerRefusedName = 'AnswerRefusedError';

/** Shown for a failure by its error name (the server's names are in `shared/conversation.ts`); any other failure shows `errorGeneric`, never its own text. */
const chatErrorTexts: Readonly<Record<string, string>> = {
  [conversationErrors.InterruptsPending]: '前の操作結果がまだ届いていません。少し待つか、「新しい会話」からやり直してください。',
  [conversationErrors.InterruptNotPending]: '地図の操作結果をサーバーが受け付けませんでした。「新しい会話」からやり直してください。',
  [conversationErrors.NotFound]: '会話が見つかりません。「新しい会話」からやり直してください。',
  [conversationErrors.InvalidRequest]: '送れない内容です（長すぎるなど）。短くして送り直してください。',
  [answerRefusedName]: '地図の操作結果をサーバーが受け付けませんでした。「新しい会話」からやり直してください。',
  TypeError: '通信できませんでした。接続を確かめて、もう一度送ってください。',
  ModelUnavailableException: 'モデルを使えません。しばらくしてからやり直してください。'
};

/** The chat session (`src/lib/chat/chatSession.svelte.ts`) and its panel (`src/lib/components/ChatPanel.svelte`). */
export const chatConfig = {
  /**
   * The store behind the conversation API is eventually consistent: a call that names an interrupt, or a conversation made a
   * moment ago, may be refused (409 / 404) until it has caught up. The call is made again after each of these waits (milliseconds),
   * one more time after the last, and then its error is given up.
   */
  retryDelaysMs: [300, 700, 1_500],
  /** The conversation the tab is in, kept in `sessionStorage` (owner and id) so that a reload can answer what it left pending. */
  storageKey: 'ai-webmap.chat',
  /** Names of the errors the session raises itself (`text.errors` has their messages). */
  errorNames: { answerRefused: answerRefusedName },
  /** The message list follows the newest message while it is within this many pixels of the bottom; scrolled further up, it stays where the user put it. */
  autoScrollThresholdPx: 24,
  /** `KeyboardEvent.keyCode` of a key the IME is handling: some browsers report it, not `isComposing`, for the Enter that ends a composition. */
  imeProcessKeyCode: 229,
  text: {
    title: 'チャット',
    inputLabel: 'メッセージ',
    inputPlaceholder: '地図についてたずねる（例: 学校を種別で色分けして）',
    send: '送信',
    reset: '新しい会話',
    messagesLabel: '会話',
    /** Shown before the first message of a conversation. */
    emptyHint: '地図に出したいデータや見せ方を、ふだんの言葉で伝えてください。例:',
    examples: ['学校を種別で色分けして表示して', '東京都の大学だけを地図に出して', '大阪府の学校を表示して'],
    roleUser: 'あなた',
    roleAssistant: 'アシスタント',
    /** Why the input is disabled, by cause. */
    engineLoading: 'データエンジンを準備しています',
    engineFailed: 'データエンジンを起動できませんでした。',
    engineRetry: '再試行',
    notAllowed: 'このアカウントはデータを利用できません。管理者に連絡してください。',
    working: '処理中…（完了するまで送信できません）',
    /** The tool calls of the current turn, by tool and state. */
    activity: {
      runQuery: { running: 'クエリを実行中', done: 'クエリを実行しました', failed: 'クエリの実行に失敗しました' },
      addLayer: { running: 'レイヤーを追加中', done: 'レイヤーを追加しました', failed: 'レイヤーの追加に失敗しました' },
      setLayerStyle: { running: 'スタイルを変更中', done: 'スタイルを変更しました', failed: 'スタイルの変更に失敗しました' },
      setLayerLabel: { running: 'ラベルを設定中', done: 'ラベルを設定しました', failed: 'ラベルの設定に失敗しました' },
      removeLayer: { running: 'レイヤーを削除中', done: 'レイヤーを削除しました', failed: 'レイヤーの削除に失敗しました' },
      setView: { running: '表示範囲を移動中', done: '表示範囲を移動しました', failed: '表示範囲の移動に失敗しました' }
    },
    activityLabel: '実行中の操作',
    /** The mark before an activity line, by state. */
    activityMarks: { running: '…', done: '✓', failed: '✕' },
    /** Why a tool call failed, in words (the line reads 「…に失敗しました（理由）」). */
    toolErrorCodes: {
      SQL_REJECTED: '許可されない SQL',
      SQL_ERROR: 'SQL のエラー',
      TIMEOUT: '時間切れ',
      TOO_MANY_FEATURES: '地物が多すぎる',
      NO_GEOMETRY: '位置の列がない',
      MIXED_GEOMETRY: '点・線・面が混在',
      UNKNOWN_COLUMN: '列が見つからない',
      UNKNOWN_LAYER: 'レイヤーが見つからない',
      INVALID_STYLE: 'スタイルが不正',
      INVALID_INPUT: '入力が不正',
      ENGINE_UNAVAILABLE: 'データエンジンが使えない',
      SESSION_RESET: '会話をやり直したため中止'
    },
    /** The part of the line for a failure: `（` reason `）`. */
    toolErrorWrap: ['（', '）'],
    /** The answer to a resumed turn could not be handed to the chat. */
    answerNotSent: '地図の操作結果を送れませんでした。「新しい会話」からやり直してください。',
    /** Opening a saved conversation found none (it is gone, or is not the user's): the chat stays on a new one. */
    /** An opened conversation could not be continued (its pending calls could not be settled): a new one was started. */
    restoreNotContinued: '前の会話を続けられなかったため、新しい会話を始めました',
    restoreNotFound: '保存された会話が見つかりません。新しい会話で続けてください。',
    errors: chatErrorTexts,
    errorGeneric: 'エラーが起きました。「新しい会話」からやり直してください。'
  }
} as const;

/** The section of the left panel that holds the development boxes (dev builds only). */
export const devPanelConfig = { title: '開発用' } as const;

/** Layout values of the app shell. */
export const layoutConfig = {
  /** At or below this viewport width (pixels): header, map and chat dock are stacked, and the layer panel starts collapsed. */
  narrowViewportMaxPx: 640,
  /** On a narrow screen the map must keep room: the message list and the input of the chat dock are kept this small (CSS lengths). */
  narrowChat: { listMaxHeight: '18dvh', inputHeight: '3.5rem' }
} as const;

const initialCenter: [number, number] = [137.0, 38.0];

export const mapConfig = {
  basemapStyleUrl: 'https://tiles.openfreemap.org/styles/positron',
  /** Whole of Japan. */
  initialView: { center: initialCenter, zoom: 4 },
  /** The single colours of the layers added without a style; cycled by the layer's sequence number. */
  defaultLayerColors: ['#e41a1c', '#377eb8', '#4daf4a', '#984ea3', '#ff7f00', '#a65628'],
  /** Padding (pixels) around a layer's bounding box when the map is fitted to it. */
  fitPaddingPx: 48,
  fitDurationMs: 600,
  /** A move the tools wait for (`moveend`) is not waited for longer than this: a map that never reports the end must not hold a tool call. Well above `fitDurationMs`. */
  moveWaitMs: 2_000,
  /** A layer of one point (or a tiny extent) is not zoomed in beyond this. */
  fitMaxZoom: 14,
  /**
   * The hidden map layer every geometry is placed below and every label above: the order of labels over geometry then
   * does not depend on when the layers were added.
   */
  labelAnchorLayerId: 'label-anchor',
  /** A layer that failed to load has no geometry; its card sits at the bottom of the list, as a polygon's would. */
  errorLayerGeometry: 'polygon',
  label: {
    /** A font stack the basemap's glyph server has (the fonts of `basemapStyleUrl`'s own labels, read from its style JSON). */
    fontStack: ['Noto Sans Regular'],
    /** Offset (ems) of a point's label below the symbol, which it is anchored to by its top. */
    pointOffsetEm: 0.8
  },
  /**
   * MapLibre draws the ideographs (Japanese, Chinese, Korean) with this CSS font list instead of loading glyphs for
   * them: the first font of the list that the system has is used, so it names the ones of macOS, Windows and Linux.
   */
  localIdeographFontFamily: '"Hiragino Sans", "Hiragino Kaku Gothic ProN", "Yu Gothic", "Meiryo", "Noto Sans CJK JP", "Noto Sans JP", sans-serif',
  /*
   * The layer summary for the model (`src/lib/map/summary.ts`) goes into every turn, so each part is capped and the whole
   * is kept within `summaryMaxBytes` by shrinking it in steps.
   */
  /** Layers beyond this many are listed by id and name only. */
  summaryMaxLayers: 12,
  /** What the summary keeps of a layer's SQL: the text is cut to this many characters. */
  summarySqlChars: 120,
  /** At most this many columns of a layer are listed (`columnCount` tells how many it has). */
  summaryMaxColumns: 12,
  /** A column whose name is longer is left out of the list (a cut name could not be used): it is only counted. */
  summaryMaxColumnNameChars: 40,
  /** Layer names and category values (and override values) are cut to this many characters, ending in "…". */
  summaryMaxStringChars: 24,
  /** At most this many warnings of a layer's style are listed, each cut to `summaryMaxWarningChars`. */
  summaryMaxWarnings: 2,
  summaryMaxWarningChars: 160,
  /** The note on a layer that failed to load (restore of a saved map) is cut to this many characters. */
  summaryErrorChars: 160,
  /** The step that shrinks an oversized summary lists only this many categories of a layer (`categoryCount` tells how many). */
  summaryShrunkCategories: 6,
  /** The summary (JSON, UTF-8 bytes) is kept below this: when it is over, it is shrunk step by step. */
  summaryMaxBytes: 16 * 1024
} as const;

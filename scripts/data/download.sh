#!/usr/bin/env bash
# 国土数値情報（KSJ）の原データを data/raw/<データID>/ に取得して展開する。
# 出典: 国土交通省 国土数値情報ダウンロードサイト https://nlftp.mlit.go.jp/ksj/
# 詳細（年度・利用条件・属性）は docs/data-sources.md を参照。
# 再実行可: 検証に通った取得済みのアーカイブと展開済みのディレクトリはスキップする。
# 取得後と、スキップするときの両方で、サイズと sha256 を検証する。
set -euo pipefail

# ---------------------------------------------------------------------------
# データセット定義: "データID|ファイルURL|バイト数|sha256"（1 行 1 ファイル）
# バイト数と sha256 は 2026-11-17 に取得したファイルの実測値。
# 版を更新するときは URL と一緒にこの 2 値も更新する。
# ---------------------------------------------------------------------------
KSJ_BASE="https://nlftp.mlit.go.jp/ksj/gml/data"
DATASETS=(
  # 行政区域 2026年（令和8年）版・全国（利用条件は要ユーザー判断。docs/data-sources.md 2.3）
  "N03|${KSJ_BASE}/N03/N03-2026/N03-20260101_GML.zip|803201348|1f714fca019e22e6f84012dba420384fc7b49c6ad8bd0a867ab1cfb593a78477"
  # 地価公示 2026年（令和8年）版・全国
  "L01|${KSJ_BASE}/L01/L01-26/L01-26_GML.zip|20898568|fad8bbe76d25b682ccf761a492ddc2de001e0345569e044481d62ea84233faf8"
  # 駅別乗降客数 2024年度（令和6年度）版・全国
  "S12|${KSJ_BASE}/S12/S12-25/S12-25_GML.zip|6913743|0785e932a32b3ec15e1a1345537ae145eafe1c07bf38d5c16c11ee2b391e7a28"
  # 鉄道 2025年度（令和7年度）版・全国
  "N02|${KSJ_BASE}/N02/N02-25/N02-25_GML.zip|14903774|aaf76af133b2e771e538fabc4646d2e443dc1d5a67b221382a28d744e706cc9f"
  # 学校 2023年度（令和5年度）版・全国
  "P29|${KSJ_BASE}/P29/P29-23/P29-23_GML.zip|5443235|74387e04bdf0b3cc6b0b5a978ce3f1295e5ee3b66114f87f61b4a9d999502ac4"
)
PAUSE_SECONDS=5 # リクエスト間隔（サーバーへの負荷を避ける）
# ---------------------------------------------------------------------------

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RAW_DIR="${ROOT_DIR}/data/raw"

# verify_archive <file> <バイト数> <sha256>
# 一致すれば 0、不一致なら理由を標準エラーに出して 1 を返す。
verify_archive() {
  local file="$1" want_size="$2" want_sha="$3" got_size got_sha
  got_size="$(wc -c <"${file}" | tr -d ' ')"
  if [[ "${got_size}" != "${want_size}" ]]; then
    echo "  サイズ不一致: ${got_size} バイト（期待 ${want_size}）" >&2
    return 1
  fi
  got_sha="$(shasum -a 256 "${file}" | cut -d' ' -f1)"
  if [[ "${got_sha}" != "${want_sha}" ]]; then
    echo "  sha256 不一致: ${got_sha}（期待 ${want_sha}）" >&2
    return 1
  fi
}

# check_zip_entries <zip>
# 戻り値: 0 = 安全（展開してよい）、非 0 = 拒否（展開しない）。
# 絶対パス、".." を含むパス、シンボリックリンクを含むアーカイブを拒否する。
# 展開前に unzip -Z1（名前一覧）と unzip -Z（モード列。先頭が l ならリンク）で調べる。
# 一覧は先に変数へ取り込み、一覧の取得に失敗したときも拒否する（fail closed）。
# unzip を grep -q へパイプしない: grep が最初の一致で終了すると unzip が SIGPIPE で
# 非 0 になり、pipefail 下で「一致なし」と誤判定するため。
check_zip_entries() {
  local zip="$1" names modes
  names="$(unzip -Z1 "${zip}")" || {
    echo "  アーカイブのエントリ一覧を読めません（zip ではない可能性）: ${zip}" >&2
    return 1
  }
  modes="$(unzip -Z "${zip}")" || {
    echo "  アーカイブのモード一覧を読めません: ${zip}" >&2
    return 1
  }
  if grep -Eq '^/|(^|/)\.\.(/|$)' <<<"${names}"; then
    echo "  アーカイブに絶対パスまたは .. を含むエントリがあります: ${zip}" >&2
    return 1
  fi
  if grep -q '^l' <<<"${modes}"; then
    echo "  アーカイブにシンボリックリンクがあります: ${zip}" >&2
    return 1
  fi
  return 0
}

# このファイルを source したときは、関数だけ読み込んで本体は実行しない（テスト用）。
if [[ "${BASH_SOURCE[0]}" != "${0}" ]]; then
  return 0
fi

requested=0

for entry in "${DATASETS[@]}"; do
  IFS='|' read -r id url want_size want_sha <<<"${entry}"
  file="$(basename "${url}")"
  dir="${RAW_DIR}/${id}"
  archive="${dir}/${file}"
  marker="${dir}/.unpacked-${file}"

  mkdir -p "${dir}"

  if [[ -f "${archive}" ]]; then
    if ! verify_archive "${archive}" "${want_size}" "${want_sha}"; then
      echo "[error] ${id}: 既存の ${archive} が期待と一致しません。" >&2
      echo "        自動では削除しません。中身を確認し（HTML のエラーページなど）、不要なら手で削除して再実行してください。" >&2
      exit 1
    fi
    echo "[skip] ${id}: ${file} は取得済み（検証 OK）"
  else
    if ((requested > 0)); then sleep "${PAUSE_SECONDS}"; fi
    requested=$((requested + 1))
    echo "[get ] ${id}: ${url}"
    # 失敗時のリトライは 1 回だけ。部分ファイルは .part に書き、検証に通ってからリネームする。
    curl --fail --silent --show-error --location --retry 1 --retry-delay 10 \
      --output "${archive}.part" "${url}"
    if ! verify_archive "${archive}.part" "${want_size}" "${want_sha}"; then
      rm -f "${archive}.part"
      echo "[error] ${id}: 取得したファイルが期待と一致しないため破棄しました（エラーページや更新の可能性）。" >&2
      echo "        URL を確認し、版を更新した場合は DATASETS のバイト数と sha256 も更新してください。" >&2
      exit 1
    fi
    mv "${archive}.part" "${archive}"
  fi

  if [[ -f "${marker}" ]]; then
    echo "[skip] ${id}: 展開済み"
  else
    echo "[unzip] ${id}: ${file}"
    check_zip_entries "${archive}" || {
      echo "[error] ${id}: 安全でないエントリを含むため展開しません。" >&2
      exit 1
    }
    unzip -q -o "${archive}" -d "${dir}"
    touch "${marker}"
  fi
done

echo "完了: ${RAW_DIR}"
du -sh "${RAW_DIR}"/*

#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════
#  未認証アクセスが遮断されているか確認する
#
#  使い方: bash tools/verify-rules.sh
#
#  ルール適用前は全て FAIL（誰でも読める）、
#  適用後は全て PASS（PERMISSION_DENIED）になるのが期待値。
# ══════════════════════════════════════════════════════════════
set -u

KEY="AIzaSyBOugWhkAkv5xvbV9bhXvAd-NdVpOIzv7k"
BASE="https://firestore.googleapis.com/v1/projects/kintai-dubstock/databases/(default)/documents"

pass=0; fail=0

check() {
  local label="$1" url="$2"
  local body status
  body=$(curl -s --max-time 20 "$url")
  status=$(printf '%s' "$body" | python3 -c \
    "import json,sys
try: d=json.loads(sys.stdin.read() or '{}')
except Exception: d={}
print(d.get('error',{}).get('status','(エラーなし=読み取れた)'))")

  if [ "$status" = "PERMISSION_DENIED" ]; then
    printf '  \033[32mPASS\033[0m  %-28s 遮断されています\n' "$label"
    pass=$((pass+1))
  else
    printf '  \033[31mFAIL\033[0m  %-28s %s\n' "$label" "$status"
    fail=$((fail+1))
  fi
}

echo
echo "未認証（ログインなし）での Firestore アクセスを検査します"
echo "────────────────────────────────────────────────────────"

for col in users kintai leaves expenses travels; do
  check "list $col" "$BASE/$col?pageSize=1&key=$KEY"
done
check "get kintai/(存在しないID)" "$BASE/kintai/zzprobe-nonexistent-999?key=$KEY"

echo "────────────────────────────────────────────────────────"
if [ "$fail" -eq 0 ]; then
  printf '  \033[32m成功: %d 件すべて遮断されています。\033[0m\n\n' "$pass"
  exit 0
else
  printf '  \033[31m失敗: %d 件が未認証で読み取れています。\033[0m\n' "$fail"
  echo "  → Firebase コンソールでルールが公開されているか確認してください。"
  echo
  exit 1
fi

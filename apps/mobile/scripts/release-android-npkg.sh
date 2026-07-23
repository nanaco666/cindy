#!/usr/bin/env bash
#
# release-android-npkg.sh — XDMaker 手机版 Android 内部分发脚本(NPKG)
# ---------------------------------------------------------------------------
# 流程:  构建 .apk(gradlew,我们自己) → 上传 NPKG → 取下载/安装链接
#
# 与 release-ios.sh 的关键差异:
#   - Android APK 由自有 keystore(Cindy.jks / alias Cindy)**自签即终版**,NPKG **不重签**。
#     因此 **没有** iOS 的"轮询 type=enterprise 企业子包 + 校验签名 Team UE5H8B62F9.*"环节。
#   - 上传后直接用父包 id 输出安装页 /install/<id> 与直下 /api/v1/packages/<id>/download/。
#   - 无 itms(那是 iOS OTA manifest 专有);Android 客户端 Linking.openURL(下载链接)触发安装。
#
# 机密:NPKG token 只放在 ~/.config/xdt-maker/npkg/credentials.env(chmod 600),或启动时经
#       环境变量 NPKG_TOKEN 传入,**绝不进任何 git 仓库**。本脚本只读取,不内嵌密钥。
#       覆盖位置:export NPKG_CONFIG_DIR=/some/dir(其下需有 credentials.env)。
# ---------------------------------------------------------------------------
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MOBILE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
# NPKG 凭证来源(优先级):环境变量(推荐,不落盘、不进库)> 本地 credentials.env(不进库)。
NPKG_CONF="${NPKG_CONFIG_DIR:-$HOME/.config/xdt-maker/npkg}/credentials.env"
_ENV_NPKG_TOKEN="${NPKG_TOKEN:-}"
_ENV_NPKG_BASE_URL="${NPKG_BASE_URL:-}"
if [ -f "$NPKG_CONF" ]; then
  # shellcheck disable=SC1090
  . "$NPKG_CONF"          # 回退默认:提供 NPKG_TOKEN / NPKG_BASE_URL
fi
# 环境变量优先:启动时传入则覆盖文件值。
[ -n "$_ENV_NPKG_TOKEN" ] && NPKG_TOKEN="$_ENV_NPKG_TOKEN"
[ -n "$_ENV_NPKG_BASE_URL" ] && NPKG_BASE_URL="$_ENV_NPKG_BASE_URL"
: "${NPKG_TOKEN:?需要 NPKG_TOKEN:启动时传环境变量(NPKG_TOKEN=...)或放 $NPKG_CONF}"
: "${NPKG_BASE_URL:=https://npkg.xindong.com}"

# 期望的 Android package(默认自建线 com.xd.cindycn;可用 NPKG_EXPECT_PACKAGE 覆盖)。
EXPECT_PACKAGE="${NPKG_EXPECT_PACKAGE:-com.xd.cindycn}"

die(){ echo "ERROR: $*" >&2; exit 1; }
have(){ command -v "$1" >/dev/null 2>&1; }
have curl    || die "需要 curl"
have python3 || die "需要 python3"
# EAS CLI:优先全局 eas,否则回退 pinned 版本(与 .mjs release 工具链对齐);登录态走 ~/.expo。
if command -v eas >/dev/null 2>&1; then EAS=(eas); else EAS=(npx --yes eas-cli@20.4.0); fi

usage(){
  cat >&2 <<EOF
用法:
  $0 upload <path-to.apk> [--memo "备注"] [--tag test]
        上传一个已构建的 .apk → 打印安装/下载链接(Android 自签,NPKG 不重签)

  $0 resolve <parent_package_id>
        对已上传的父包补取安装/下载链接(用于补取 / 自测)

  $0 from-eas [--profile <profile>] [--memo "备注"] [--tag test]
        按 profile 精确取最近一次 EAS"已完成"的 android 构建产物(.apk)→ 下载 → 走 upload
        默认 --profile production;开发者 beta 用 --profile beta-<dev>。
        重要:必须按 profile 过滤,否则 beta 与正式包会串包。

说明:Android APK 自有 keystore 自签即终版,NPKG 只上传取链接、**不做企业重签**。
EOF
  exit 1
}

# --- 校验父包 package 并打印安装/下载信息 --------------------------------
emit_install(){
  local parent="$1" detail pkg
  detail="$(curl -sf -m 20 -H "Authorization: Token $NPKG_TOKEN" \
            "$NPKG_BASE_URL/api/v1/packages/$parent/")" || die "读包 $parent 失败"
  # JSON null / 缺字段一律归一为空串(.get 的默认值挡不住显式 null → None → 打印 "None")。
  pkg="$(printf '%s' "$detail" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("package") or "")')"
  # NPKG 异步解析 package:即时可能为空/unknown。非空且不匹配才拒绝(空则放行,只是提示)。
  case "$pkg" in
    ""|unknown|null) echo "  (NPKG 尚未回填 package id,跳过校验)" >&2 ;;
    "$EXPECT_PACKAGE") ;;
    *) die "包 package 是 $pkg(预期 $EXPECT_PACKAGE),拒绝打印安装链接" ;;
  esac
  local install="$NPKG_BASE_URL/install/$parent"
  local download="$NPKG_BASE_URL/api/v1/packages/$parent/download/"
  echo
  echo "==================== 发版完成 ===================="
  echo "  父包 id       : $parent"
  echo "  package       : ${pkg:-<pending>}"
  echo "  安装链接(发这个,Android 浏览器打开下载安装):"
  echo "    $install"
  echo "  直下 APK      : $download"
  echo "=================================================="
}

# --- upload 子命令 -------------------------------------------------------
cmd_upload(){
  local apk="${1:-}"; shift || true
  [ -n "$apk" ] && [ -f "$apk" ] || die "请给一个存在的 .apk 路径"
  local memo="XDMaker Android 内部分发 $(basename "$apk")" tag="release"
  while [ $# -gt 0 ]; do case "$1" in
    --memo) memo="$2"; shift 2;;
    --tag)  tag="$2";  shift 2;;
    *) die "未知参数 $1";;
  esac; done

  echo "→ 上传 $apk 到 NPKG …"
  local resp parent pkg
  resp="$(curl -sf -m 300 -H "Authorization: Token $NPKG_TOKEN" \
           -F "file=@$apk" -F "memo=$memo" -F "tags=$tag" \
           "$NPKG_BASE_URL/api/v1/packages/")" \
    || die "上传失败(NPKG 可能因 md5 重复拒绝;bump android-version.json 的 versionCode 重新构建)"
  parent="$(printf '%s' "$resp" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("id",""))')"
  pkg="$(printf '%s' "$resp"   | python3 -c 'import sys,json;print(json.load(sys.stdin).get("package") or "")')"
  [ -n "$parent" ] || die "上传响应里没有包 id:$resp"
  # 上传响应若已回填 package 且不匹配,立即拒绝——不能等到 emit_install,
  # 那里的异步 detail 可能仍为空而被放行,导致错包也打印安装链接。
  case "$pkg" in
    ""|unknown|null) ;;                # 尚未回填,交给 emit_install 再校验
    "$EXPECT_PACKAGE") ;;
    *) die "上传的 APK package 是 $pkg(预期 $EXPECT_PACKAGE),拒绝继续" ;;
  esac
  echo "  ✓ 已上传,父包 id=$parent  package=${pkg:-<pending>}"
  emit_install "$parent"
}

# --- resolve 子命令 ------------------------------------------------------
cmd_resolve(){
  local parent="${1:-}"; [ -n "$parent" ] || usage
  echo "→ 取父包 $parent 的安装/下载链接 …"
  emit_install "$parent"
}

# --- from-eas 子命令(按 profile 精确取最近一次已完成的 android 构建产物) ----
cmd_from_eas(){
  local profile="production"; local pass=()
  while [ $# -gt 0 ]; do case "$1" in
    --profile) profile="$2"; shift 2;;
    --memo|--tag) pass+=("$1" "$2"); shift 2;;
    *) die "未知参数 $1";;
  esac; done
  echo "→ 查最近一次 profile=$profile 的已完成 android 构建(按 profile 精确过滤,防 beta/正式串包)…"
  local url
  url="$( (cd "$MOBILE_DIR" && "${EAS[@]}" build:list --platform android --status finished --build-profile "$profile" --limit 30 --json --non-interactive 2>/dev/null) \
        | EAS_PROFILE="$profile" python3 -c 'import sys,json,os
prof=os.environ["EAS_PROFILE"]
builds=json.load(sys.stdin) or []
for b in builds:
    if (b.get("buildProfile") or b.get("profile")) != prof:
        continue
    print((b.get("artifacts",{}) or {}).get("applicationArchiveUrl","") or "")
    break')"
  [ -n "$url" ] || die "没找到 profile=$profile 的已完成 android 构建产物(先 \`eas build --platform android --profile $profile\`;beta 用 --profile beta-<dev>)"
  local tmp; tmp="$(mktemp -d)/Cindy.apk"
  echo "  下载产物 → $tmp"
  curl -sfL -m 600 -o "$tmp" "$url" || die "下载 EAS 产物失败"
  cmd_upload "$tmp" "${pass[@]}"
}

# --- dispatch ------------------------------------------------------------
case "${1:-}" in
  upload)   shift; cmd_upload "$@";;
  resolve)  shift; cmd_resolve "$@";;
  from-eas) shift; cmd_from_eas "$@";;
  *) usage;;
esac

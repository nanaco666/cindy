#!/usr/bin/env bash
#
# release-ios.sh — XDMaker 手机版 iOS 内部分发脚本(NPKG)
# ---------------------------------------------------------------------------
# 流程:  构建 .ipa(EAS,我们自己) → 上传 NPKG → NPKG 自动企业重签 → 取安装链接
#
# 关键事实(2026-06-26 实测):
#   - NPKG 不编译源码,只对我们已构建好的 .ipa **重签名**(企业 In-House wildcard 证书
#     UE5H8B62F9.* / Shanghai Xindong Enterprise Development Co., Ltd. → 无设备上限)。
#   - bundle id `com.xd.cindycn` 的企业 provisioning profile 一旦配好(“白名单”),
#     **每次上传 NPKG 会自动产出 type=enterprise 的兄弟包**(秒级),父包 `enterprise`
#     字段指向子包 id。无需手动点“打包”、无触发 API。
#   - 安装走前端路由 `/install/<子包id>`(免 token / 免登记 UDID,iPhone Safari 打开即装)。
#
# 机密:NPKG token 只放在 ~/.config/xdt-maker/npkg/credentials.env(chmod 600),
#       **绝不进任何 git 仓库**。本脚本只读取它,不内嵌任何密钥,因此可以版本管理。
#       覆盖位置:export NPKG_CONFIG_DIR=/some/dir(其下需有 credentials.env)。
# ---------------------------------------------------------------------------
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MOBILE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
# NPKG 凭证来源(优先级):环境变量(每次启动传入,推荐,不落盘、不进库)> 本地 credentials.env(不进库)。
# 用法:NPKG_TOKEN=xxx bash scripts/release-ios.sh upload ...(或经 release-ios-local.mjs 透传)。
# NPKG_BASE_URL 缺省 https://npkg.xindong.com,可用环境变量覆盖。
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

# 期望的 bundle id。默认 com.xd.cindycn(自建线);可通过 NPKG_EXPECT_BUNDLE 覆盖(校验历史包等)。
# 例外:from-eas 子命令在未显式设 NPKG_EXPECT_BUNDLE 时自动改用 EAS 线身份 com.xd.lizcn——
# EAS 构建产物本就是 lizcn 包,按自建线默认值校验会被误拒(见 cmd_from_eas)。
# 企业签 Team 校验(UE5H8B62F9.*)不随之变。
EXPECT_BUNDLE="${NPKG_EXPECT_BUNDLE:-com.xd.cindycn}"
EAS_LINE_BUNDLE="com.xd.lizcn"
POLL_TRIES=60          # 轮询次数
POLL_INTERVAL=5        # 每次间隔秒

die(){ echo "ERROR: $*" >&2; exit 1; }
have(){ command -v "$1" >/dev/null 2>&1; }
have curl    || die "需要 curl"
have python3 || die "需要 python3"
# EAS CLI:优先全局 eas,否则回退 pinned 版本(与 .mjs release 工具链对齐);登录态走 ~/.expo。
if command -v eas >/dev/null 2>&1; then EAS=(eas); else EAS=(npx --yes eas-cli@20.4.0); fi

usage(){
  cat >&2 <<EOF
用法:
  $0 upload <path-to.ipa> [--memo "备注"] [--tag test]
        上传一个已构建的 .ipa → 等 NPKG 自动企业签 → 打印安装链接

  $0 resolve <parent_package_id>
        对已上传的父包,等/取其企业子包 → 打印安装链接(用于补取 / 自测)

  $0 from-eas [--profile <profile>] [--memo "备注"] [--tag test]
        按 profile 精确取最近一次 EAS“已完成”的 iOS 构建产物(.ipa)→ 下载 → 走 upload
        默认 --profile production(正式企业包);开发者 beta 用 --profile beta-<dev>。
        重要:必须按 profile 过滤,否则 beta 与正式包会在重签环节串包。

  $0 download <package_id> <dest_path>
        下载指定包的字节到本地(带 token)。常用于取企业重签子包的 .ipa,
        供 release-ios-local.mjs 转传自有 OSS 分发。

说明:NPKG 只重签不编译;企业签证书 = UE5H8B62F9.*(无设备上限)。
EOF
  exit 1
}

# --- 取父包的企业子包 id(轮询直到出现) ---------------------------------
# $1 = parent id ; echo 子包 id(成功) ; 失败 return 1
poll_enterprise_child(){
  local parent="$1" i ent
  for ((i=1; i<=POLL_TRIES; i++)); do
    ent="$(curl -sf -m 20 -H "Authorization: Token $NPKG_TOKEN" \
            "$NPKG_BASE_URL/api/v1/packages/$parent/" \
          | python3 -c 'import sys,json; print(json.load(sys.stdin).get("enterprise") or "")' )" || true
    # 只认数字子包 id;NPKG 生成中会瞬时返回 "pending"(或空),要继续轮询而不是当成 id。
    if [[ "$ent" =~ ^[0-9]+$ ]]; then echo "$ent"; return 0; fi
    printf '  …等待 NPKG 企业签(%d/%d)\n' "$i" "$POLL_TRIES" >&2
    sleep "$POLL_INTERVAL"
  done
  return 1
}

# --- 打印某企业子包的安装信息 + 校验签名 ---------------------------------
emit_install(){
  local child="$1" detail team pkg
  detail="$(curl -sf -m 20 -H "Authorization: Token $NPKG_TOKEN" \
            "$NPKG_BASE_URL/api/v1/packages/$child/")" || die "读子包 $child 失败"
  team="$(printf '%s' "$detail" | python3 -c 'import sys,json
d=json.load(sys.stdin)
t=[c["result"] for c in d.get("check_data",[]) if c.get("name")=="Team"]
print((t[0] if t else "?").replace(chr(10)," / "))')"
  pkg="$(printf '%s' "$detail" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("package",""))')"
  [ "$pkg" = "$EXPECT_BUNDLE" ] || die "企业子包 bundle id 是 $pkg(预期 $EXPECT_BUNDLE),拒绝打印安装链接"
  case "$team" in
    UE5H8B62F9.*) ;; # 期望的企业 wildcard 证书
    *) die "签名 Team 不是预期的企业 wildcard(UE5H8B62F9.*): $team" ;;
  esac
  local install="$NPKG_BASE_URL/install/$child"
  local plist="$NPKG_BASE_URL/plist/$child"
  echo
  echo "==================== 发版完成 ===================="
  echo "  企业签子包 id : $child"
  echo "  bundle id     : $pkg"
  echo "  签名 Team     : $team"
  echo "  安装链接(发这个,iPhone Safari 打开即装,无设备上限):"
  echo "    $install"
  echo "  itms-services : itms-services://?action=download-manifest&url=$(python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1],safe=''))" "$plist")"
  echo "=================================================="
}

# --- upload 子命令 -------------------------------------------------------
cmd_upload(){
  local ipa="${1:-}"; shift || true
  [ -n "$ipa" ] && [ -f "$ipa" ] || die "请给一个存在的 .ipa 路径"
  local memo="XDMaker iOS 内部分发 $(basename "$ipa")" tag="release"
  while [ $# -gt 0 ]; do case "$1" in
    --memo) memo="$2"; shift 2;;
    --tag)  tag="$2";  shift 2;;
    *) die "未知参数 $1";;
  esac; done

  echo "→ 上传 $ipa 到 NPKG …"
  local resp parent pkg
  resp="$(curl -sf -m 300 -H "Authorization: Token $NPKG_TOKEN" \
           -F "file=@$ipa" -F "memo=$memo" -F "tags=$tag" \
           "$NPKG_BASE_URL/api/v1/packages/")" \
    || die "上传失败(NPKG 可能因 md5 重复拒绝;换一个新 buildNumber 重新构建)"
  parent="$(printf '%s' "$resp" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("id",""))')"
  pkg="$(printf '%s' "$resp"   | python3 -c 'import sys,json;print(json.load(sys.stdin).get("package",""))')"
  [ -n "$parent" ] || die "上传响应里没有包 id:$resp"
  echo "  ✓ 已上传,父包 id=$parent  bundle=${pkg:-<pending>}"
  # NPKG 异步解析 bundle id:即时响应里 package 可能为空或 "unknown"。此时推迟校验,
  # 交给 emit_install(读企业子包 detail 的 package)兜底——那才是打印安装链接前的权威闸门,
  # 安全不丢。只有明确拿到且不匹配时,才在这里早退(避免为错误 bundle 继续等待)。
  case "$pkg" in
    ""|unknown|null) echo "  (NPKG 尚未回填 bundle id,推迟到企业子包校验)" ;;
    "$EXPECT_BUNDLE") ;;
    *) die "bundle id 是 $pkg(预期 $EXPECT_BUNDLE),拒绝继续企业签发" ;;
  esac

  echo "→ 等待 NPKG 自动企业签 …"
  local child
  child="$(poll_enterprise_child "$parent")" \
    || die "超时未出现企业子包。可能 provisioning 没配好(白名单),或该 bundle 未启用企业签。父包 id=$parent,可稍后 \`$0 resolve $parent\` 重试。"
  emit_install "$child"
}

# --- resolve 子命令 ------------------------------------------------------
cmd_resolve(){
  local parent="${1:-}"; [ -n "$parent" ] || usage
  echo "→ 取父包 $parent 的企业子包 …"
  local child
  child="$(poll_enterprise_child "$parent")" || die "父包 $parent 暂无企业子包。"
  emit_install "$child"
}

# --- from-eas 子命令(按 profile 精确取最近一次已完成的 iOS 构建产物) -------
# 必须按 profile 过滤:beta 与正式包都在同一个 EAS 项目里,盲取“最新 finished”会
# 把 beta 包当成正式企业包重签下发(或反之)。query 先用 --build-profile 过滤,
# Python 再按 buildProfile 双保险。
cmd_from_eas(){
  # EAS 产物是 EAS 线身份(com.xd.lizcn),不是自建线的 com.xd.cindycn;未显式指定
  # NPKG_EXPECT_BUNDLE 时把校验目标切到 EAS 线,否则 from-eas 上传必被默认值误拒。
  if [ -z "${NPKG_EXPECT_BUNDLE:-}" ]; then
    EXPECT_BUNDLE="$EAS_LINE_BUNDLE"
    echo "→ from-eas:未设 NPKG_EXPECT_BUNDLE,按 EAS 线身份校验 bundle id = $EXPECT_BUNDLE"
  fi
  local profile="production"; local pass=()
  while [ $# -gt 0 ]; do case "$1" in
    --profile) profile="$2"; shift 2;;
    --memo|--tag) pass+=("$1" "$2"); shift 2;;
    *) die "未知参数 $1";;
  esac; done
  echo "→ 查最近一次 profile=$profile 的已完成 iOS 构建(按 profile 精确过滤,防 beta/正式串包)…"
  local url
  url="$( (cd "$MOBILE_DIR" && "${EAS[@]}" build:list --platform ios --status finished --build-profile "$profile" --limit 30 --json --non-interactive 2>/dev/null) \
        | EAS_PROFILE="$profile" python3 -c 'import sys,json,os
prof=os.environ["EAS_PROFILE"]
builds=json.load(sys.stdin) or []
for b in builds:
    if (b.get("buildProfile") or b.get("profile")) != prof:
        continue
    print((b.get("artifacts",{}) or {}).get("applicationArchiveUrl","") or "")
    break')"
  [ -n "$url" ] || die "没找到 profile=$profile 的已完成 iOS 构建产物(先 \`eas build --platform ios --profile $profile\`;beta 用 --profile beta-<dev>)"
  local tmp; tmp="$(mktemp -d)/xdmaker.ipa"
  echo "  下载产物 → $tmp"
  curl -sfL -m 600 -o "$tmp" "$url" || die "下载 EAS 产物失败"
  cmd_upload "$tmp" "${pass[@]}"
}

# --- download 子命令(下载包字节;企业子包的字节即重签后的 .ipa) -----------
cmd_download(){
  local pkg="${1:-}" dest="${2:-}"
  [ -n "$pkg" ] && [ -n "$dest" ] || usage
  echo "→ 下载 NPKG 包 $pkg → $dest"
  curl -sfL -m 600 -H "Authorization: Token $NPKG_TOKEN" \
    -o "$dest" "$NPKG_BASE_URL/api/v1/packages/$pkg/download/" || die "下载包 $pkg 失败"
  [ -s "$dest" ] || die "下载文件为空:$dest"
  echo "  ✓ 已下载 $(du -h "$dest" | cut -f1 | tr -d ' ')"
}

# --- dispatch ------------------------------------------------------------
case "${1:-}" in
  upload)   shift; cmd_upload "$@";;
  resolve)  shift; cmd_resolve "$@";;
  from-eas) shift; cmd_from_eas "$@";;
  download) shift; cmd_download "$@";;
  *) usage;;
esac

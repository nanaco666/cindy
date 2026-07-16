#!/usr/bin/env bash

# depends: curl / date / grep / wc / awk / unzip / jq / readlink

####
# 此脚本旨在解决将 zip 压缩后的 Windows PE 文件上传到 npkg、完成签名、并下载回来的功能
#
# 设上传的原始文件名为 {file}.zip ，处理完成后的文件名将是 {file}-signed.zip
# 在下载已签名的 zip 包时，如本地已有同名文件存在，此脚本将试图将同名文件重命名为带有时间戳后缀的文件名，格式如 {file}.zip-1656880000
#
# 此脚本的调用方有义务将 {file}-signed.zip 在使用后删除，以避免过度占用硬盘空间
# 此脚本在执行上传前将检查 zip 包内的文件扩展名：当前将只允许包含 .exe / .dll 文件，如有其他文件，上传将会被打断
#
# 必须传入的参数有 2 个，分别是：
# -t : npkg 的个人 token
# -f : 需要上传并执行签名的 zip 文件路径
# 下面的是可选参数：
# -F : 当上传 zip 包到 npkg 时，如发生冲突（文件已存在）时，将自动从 npkg 上删除冲突的包，并重新上传，以使得上传可以持续成功。适合使用在 CI/CD 脚本中，特别是当出现错误需要重试时。
#
# 运行期间依赖的工具见上方注释
####

show_help() {
  echo "Usage:"
  echo -e "\033[1;93m Required:\033[0m"
  echo "  -t, the Token of npkg, retrieve from https://npkg.xindong.com/account/center"
  echo "  -f, the ZipFile which will be uploaded, doc ref: https://npkg.xindong.com/docs"
  echo -e "\033[1;93m Optional:\033[0m"
  echo "  -F, will delete the existing entity and re-upload the package when the first upload failed with conflict error"
  before_exit
  exit 0
}

before_exit() {
  rm -fr "${TMP_DIR}"
}

token=''  # t: the token
file=''   # f: the zip file
force=0   # F: re-upload when there's a conflict

TMP_DIR=$(mktemp -d)

while getopts 't:f:Fh' OPT; do
  case $OPT in
    t)
      [ -n "${OPTARG}" ] && token="$OPTARG";;
    f)
      [ -n "${OPTARG}" ] && file="$OPTARG";;
    F)
      force=1;;
    h)
      show_help;;
    esac
done

now() {
  date +"%FT%T%z"
}

before_upload:check_file() {
  not_supported=$(unzip -l -b "${file}" | grep -E '^ +[0-9]+ +[0-9-]{10} [0-9:]{5}' | grep -E -v '\.(dll|exe)$' | wc -l | awk '{print $1}')
  if [[ -f "${file}" && $not_supported -eq 0 ]];
  then
    return 0
  else
    return 1
  fi
}

before_upload:check_token() {
  if [[ -n $token ]];
  then
    return 0
  else
    return 1
  fi
}

do_upload() { # when -F (force) is set and there's a conflict error, it will try to DELETE the existing entity
  status_code=$(curl -s -L -X POST 'https://npkg.xindong.com/api/v1/packages/' -H "Authorization: Token ${token}" \
  --form file="@${file}" \
  --form memo="Upload-Package-For-Windows-Signature,$(now)" \
  -o "${TMP_DIR}/resp_upload.json" \
  -w '%{http_code}')

  error=$(cat "${TMP_DIR}/resp_upload.json" | jq -rM '.error')

  if [[ $status_code -eq 200 || $status_code -eq 201 ]];
  then
    return 0
  elif [[ $status_code -eq 409 && $error == 'conflict' && $force -eq 1 ]];
  then
    delId=$(cat "${TMP_DIR}/resp_upload.json" | jq -rM '.conflict_id')
    status_code=$(curl -s -L -X DELETE "https://npkg.xindong.com/api/v1/packages/${delId}/" -H "Authorization: Token ${token}" -w '%{http_code}')
    if [[ $status_code -eq 204 ]];
    then
      # DELETE succeeded
      return $(do_upload)
    else
      # failed to DELETE
      return 1
    fi
  else
    cat "${TMP_DIR}/resp_upload.json" | jq -rM '.message'
    return 1
  fi
}

wait_sign() {
  pkgId="${1}"

  while true;
  do
    status_code=$(curl -s -L -X GET "https://npkg.xindong.com/api/v1/packages/${pkgId}/" -H "Authorization: Token ${token}" \
      -o "${TMP_DIR}/resp_wait.json" \
      -w '%{http_code}')

    if [[ $status_code -eq 200 ]];
    then
      sign_status=$(cat "${TMP_DIR}/resp_wait.json" | jq -rM '.sign_status')

      case $sign_status in
        pending)
          echo -e "Sign Status is pending, will retry later ..." >&2
          sleep 3
          continue;;
        completed)
          uri=$(cat "${TMP_DIR}/resp_wait.json" | jq -rM '.sign_file')
          printf 'https://npkg.xindong.com/%s' "${uri}"
          return 0;;
        failed)
          return 1;;
      esac
    else
      return 1
    fi

  done
}

# start

before_upload:check_file
if [[ $? -ne 0 ]];
then
  echo -e "Error: the file ${file} contains files other than .exe / .dll files, which is not allowed to be uploaded."
  before_exit
  exit 1
fi

before_upload:check_token
if [[ $? -ne 0 ]];
then
  echo -e "Error: the token is empty."
  before_exit
  exit 1
fi

do_upload > "${TMP_DIR}/upload.error"
if [[ $? -ne 0 ]];
then
  echo -e "Error: Upload ZipFile failed. $(cat "${TMP_DIR}/upload.error")"
  before_exit
  exit 1
fi

pkgId=$(cat "${TMP_DIR}/resp_upload.json" | jq -rM '.id')

wait_sign $pkgId > "${TMP_DIR}/signed.url"
if [[ $? -ne 0 ]];
then
  echo -e "Error: failed to retrieve signed URL."
  before_exit
  exit 1
fi

target_file=$(readlink -f "${file}" | sed -E 's;\.zip$;-signed.zip;')

if [[ -f "${target_file}" ]];
then
  ts=$(date +%s)
  mv "${target_file}" "$(echo "${target_file}" | sed -E 's;$;-'${ts}';')"
fi

curl -sSL "$(cat "${TMP_DIR}/signed.url")" -o "${target_file}"

echo -e "Finished: the signed file is ${target_file}"

before_exit

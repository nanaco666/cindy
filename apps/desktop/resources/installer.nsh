!macro customInit
  ; Check if xdt-maker is already running
  check_running:
    nsProcess::_FindProcess "xdt-maker.exe"
    Pop $R0
    ${If} $R0 == 0
      MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION \
        "Cindy 正在运行，请先关闭后再继续安装。$\n$\n点击「确定」将在关闭后继续。" \
        IDOK kill_app
      Abort
      kill_app:
        nsProcess::_KillProcess "xdt-maker.exe"
        Sleep 1000
        Goto check_running
    ${EndIf}

  ; 删旧快捷方式：老 .lnk 里 IconLocation 仍指向上一版 exe 的资源索引，
  ; 新版 .ico 内多尺寸顺序/数量变化后那个索引会落到另一张图。
  ; 让 NSIS 在后续步骤中重建 .lnk，新的 IconLocation 自然指向当前 exe 的索引 0。
  ; 历代快捷方式名：xdt-maker(最早) → XDMaker → Cindy(现行 shortcutName)，
  ; 三代全清，NSIS 只会按现行名重建。
  Delete "$DESKTOP\xdt-maker.lnk"
  Delete "$SMPROGRAMS\xdt-maker.lnk"
  Delete "$SMPROGRAMS\xdt-maker\xdt-maker.lnk"
  Delete "$DESKTOP\XDMaker.lnk"
  Delete "$SMPROGRAMS\XDMaker.lnk"
  Delete "$SMPROGRAMS\XDMaker\XDMaker.lnk"

  ; 同步清掉 PinnedTaskbar 里的副本（任务栏固定项也会缓存图标）
  Delete "$APPDATA\Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar\xdt-maker.lnk"
  Delete "$APPDATA\Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar\XDMaker.lnk"
!macroend

!macro customInstall
  ; 注册文件夹右键菜单 "通过 Cindy 打开" (与 main/folderContextMenu.ts 写的是同一组键)。
  ; 双重保险:installer 写一次让首装即可用, app 启动时的 registerFolderContextMenu()
  ; 也会校验+修复, 覆盖 "升级后路径漂移" / "组策略清掉注册表" 等场景。
  ;
  ; 用 HKCU 不用 HKLM:不需要管理员权限, 多用户机器上每个用户启动 app 时自注册。
  ; %V 在 Directory\shell / Directory\Background\shell 两种上下文里都解析为
  ; "用户右键所在的目录" 路径, argv 直传不做 URL 编解码 (deep link 走 xdt-maker:// 另一套)。
  WriteRegStr HKCU "Software\Classes\Directory\shell\xdt-maker" "" "通过 Cindy 打开"
  WriteRegStr HKCU "Software\Classes\Directory\shell\xdt-maker" "Icon" "$INSTDIR\xdt-maker.exe,0"
  WriteRegStr HKCU "Software\Classes\Directory\shell\xdt-maker\command" "" '"$INSTDIR\xdt-maker.exe" --open-folder "%V"'
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\xdt-maker" "" "通过 Cindy 打开"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\xdt-maker" "Icon" "$INSTDIR\xdt-maker.exe,0"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\xdt-maker\command" "" '"$INSTDIR\xdt-maker.exe" --open-folder "%V"'
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\.cshare\shell\xdt-maker" "" "通过 Cindy 打开"
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\.cshare\shell\xdt-maker" "Icon" "$INSTDIR\xdt-maker.exe,0"
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\.cshare\shell\xdt-maker\command" "" '"$INSTDIR\xdt-maker.exe" --open-share-file "%1"'
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\.xdtshare\shell\xdt-maker" "" "通过 Cindy 打开"
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\.xdtshare\shell\xdt-maker" "Icon" "$INSTDIR\xdt-maker.exe,0"
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\.xdtshare\shell\xdt-maker\command" "" '"$INSTDIR\xdt-maker.exe" --open-share-file "%1"'

  ; 广播 SHCNE_ASSOCCHANGED 让 Explorer 失效图标缓存，新图标无需注销/重启就能生效
  ; 0x08000000 = SHCNE_ASSOCCHANGED, 0 = SHCNF_IDLIST
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
!macroend

!macro customUnInstall
  ; 卸载时也清一下，避免残留 .lnk 指向已不存在的 exe(三代快捷方式名全覆盖)
  Delete "$DESKTOP\xdt-maker.lnk"
  Delete "$SMPROGRAMS\xdt-maker.lnk"
  Delete "$SMPROGRAMS\xdt-maker\xdt-maker.lnk"
  Delete "$DESKTOP\XDMaker.lnk"
  Delete "$SMPROGRAMS\XDMaker.lnk"
  Delete "$SMPROGRAMS\XDMaker\XDMaker.lnk"
  Delete "$DESKTOP\Cindy.lnk"
  Delete "$SMPROGRAMS\Cindy.lnk"
  Delete "$SMPROGRAMS\Cindy\Cindy.lnk"
  Delete "$APPDATA\Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar\xdt-maker.lnk"
  Delete "$APPDATA\Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar\XDMaker.lnk"
  Delete "$APPDATA\Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar\Cindy.lnk"
  ; 清理右键菜单注册表项 (子键 \command 必须先删 / 用 DeleteRegKey 整树删)。
  ; 老版本 (未引入此功能) 这两条键不存在, DeleteRegKey 静默 no-op 不抛错。
  DeleteRegKey HKCU "Software\Classes\Directory\shell\xdt-maker"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\xdt-maker"
  DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.cshare\shell\xdt-maker"
  DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.xdtshare\shell\xdt-maker"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
!macroend

# Cindy 登录设计稿复核（二读）：组件库与 Color System

> 读取口径：仅逐节点读取 Figma fileKey `xNK3qh7zVfrO3zrKj5tEf8` 的 `get_metadata`、`get_design_context`、`get_screenshot` 返回值；未读取 `docs/login-redesign/` 下既有内容。所有坐标均为 Figma 节点返回的原值，未取整、未按实现惯例补全。`not-exposed` 表示本次 MCP 返回未给出，不作推测。
>
> 范围计数：11 个登录相关组件（含两个立绘组件）；状态变体共 32 个。Color System 作为独立色彩规范帧记录，不计入组件数。

## 1. Color System

| nodeId | 元素/层级路径 | 属性 | 值 | 备注 |
|---|---|---|---|---|
| 247:1253 | Color System | x/y/w/h | `43547 / -24543 / 3081 / 1182` | 主读取帧 |
| 247:1253 | Color System | fill | `#FFFFFF, 100%` | `get_design_context` |
| 247:1253 | Color System | 圆角/描边/效果 | `not-exposed` | 返回未给出 |
| 228:875 | Color System（抽查副本） | x/y/w/h | `40857 / 1401 / 3081 / 1182` | 与 247:1253 尺寸一致；子项命名、相对坐标和色值文字一致 |
| 247:1294 | Color System/状态四色总簇 | x/y/w/h | `480 / 50 / 240 / 56` | 相对 247:1253 |
| 247:1294 | Color System/状态四色总簇 | 文字 | `状态四色总簇；PingFang SC Semibold；40px；line-height normal；#000000` | 字间距 not-exposed |
| 247:1293 | Color System/Toast | x/y/w/h | `1678 / 50 / 107 / 56` | 相对 247:1253 |
| 247:1293 | Color System/Toast | 文字 | `Toast；PingFang SC Semibold；40px；line-height normal；#000000` | 字间距 not-exposed |
| 247:1256/247:1269/247:1292 | Color System/品牌色 | 标签/色值/色块 | `品牌色 / DF0C27 / #DF0C27` | 标签 x/y/w/h `215/144/108/50`；色值 `212/375/107/39`；色块 `198/222/142/142` |
| 247:1256/247:1269 | Color System/品牌色 | 文字 | `PingFang SC Semibold；标签 36px；色值 28px；line-height normal；#DF0C27` | 字间距 not-exposed |
| 247:1254/247:1267/247:1280 | Color System/Running | 标签/色值/色块 | `Running / EA6B17 / #EA6B17` | `483/144/141/50`；`499/375/101/39`；`482/222/142/142` |
| 247:1254/247:1267 | Color System/Running | 文字 | `PingFang SC Semibold；标签 36px；色值 28px；line-height normal；#EA6B17` | 字间距 not-exposed |
| 247:1261/247:1274/247:1286 | Color System/Awaiting | 标签/色值/sw​​atch | `Awaiting / 19D2C1 / #19D2C1` | `691/144/149/50`；`712/375/98/39`；`694/222/142/142` |
| 247:1261/247:1274 | Color System/Awaiting | 文字 | `PingFang SC Semibold；标签 36px；色值 28px；line-height normal；#19D2C1` | 字间距 not-exposed |
| 247:1263/247:1276/247:1288 | Color System/Error | 标签/色值/sw​​atch | `Error / D91F37 / #D91F37` | `938/144/86/50`；`929/375/97/39`；`910/222/142/142` |
| 247:1263/247:1276 | Color System/Error | 文字 | `PingFang SC Semibold；标签 36px；色值 28px；line-height normal；#D91F37` | 字间距 not-exposed |
| 247:1265/247:1278/247:1290 | Color System/Done | 标签/色值/sw​​atch | `Done / 2AAE5B / #2AAE5B` | `1145/144/89/50`；`1132/375/109/39`；`1119/222/142/142` |
| 247:1265/247:1278 | Color System/Done | 文字 | `PingFang SC Semibold；标签 36px；色值 28px；line-height normal；#2AAE5B` | 字间距 not-exposed |
| 247:1255/247:1268/247:1281 | Color System/Toast info | 标签/色值/sw​​atch | `info / 417CDD / #417CDD` | `1716/144/67/50`；`1693/375/105/39`；`1678/222/142/142` |
| 247:1255/247:1268 | Color System/Toast info | 文字 | `PingFang SC Semibold；标签 36px；色值 28px；line-height normal；#417CDD` | 字间距 not-exposed |
| 247:1262/247:1275/247:1287 | Color System/Toast success | 标签/色值/sw​​atch | `success / 2AAE5B / #2AAE5B` | `1892/144/139/50`；`1903/375/109/39`；`1890/222/142/142` |
| 247:1262/247:1275 | Color System/Toast success | 文字 | `PingFang SC Semibold；标签 36px；色值 28px；line-height normal；#2AAE5B` | 字间距 not-exposed |
| 247:1264/247:1277/247:1289 | Color System/Toast warning | 标签/色值/sw​​atch | `warning / F3A115 / #F3A115` | `2109/144/136/50`；`2127/375/92/39`；`2106/222/142/142` |
| 247:1264/247:1277 | Color System/Toast warning | 文字 | `PingFang SC Semibold；标签 36px；色值 28px；line-height normal；#F3A115` | 字间距 not-exposed |
| 247:1266/247:1279/247:1291 | Color System/Toast error | 标签/色值/sw​​atch | `error / D91F37 / #D91F37` | `2344/144/83/50`；`2334/375/97/39`；`2315/222/142/142` |
| 247:1266/247:1279 | Color System/Toast error | 文字 | `PingFang SC Semibold；标签 36px；色值 28px；line-height normal；#D91F37` | 字间距 not-exposed |
| 247:1257/247:1270/247:1282 | Color System/Accent | 标签/色值/sw​​atch | `Accent / EA6B17 / #EA6B17` | `493/540/120/50`；`499/771/101/39`；`482/618/142/142` |
| 247:1258/247:1271/247:1283 | Color System/Warning fg | 标签/色值/sw​​atch | `Warning fg / F3A115 / #F3A115` | `666/540/190/50`；`711/771/92/39`；`690/618/142/142` |
| 247:1259/247:1272/247:1284 | Color System/Auto Approval | 标签/色值/sw​​atch | `Auto Approval / 234DC5 / #234DC5` | `887/506/189/80`；`923/771/108/39`；`910/618/142/142` |
| 247:1260/247:1273/247:1285 | Color System/Focus ring | 标签/色值/sw​​atch | `Focus ring / 417CDD / #417CDD` | `1099/540/181/50`；`1133/771/105/39`；`1118/618/142/142` |
| 247:1257–247:1260/247:1270–247:1273 | Color System/下方四项文字 | 文字 | `PingFang SC Semibold；标签 36px；色值 28px；line-height normal；对应色值同名` | 字间距 not-exposed |

### 登录语义色板（228 系列）

| nodeId | 元素/层级路径 | 属性 | 值 | 备注 |
|---|---|---|---|---|
| 228:1042 | 登录语义色板/swatch 1 | x/y/w/h | `42958 / -24694 / 142 / 142` | 填充值 not-exposed；紧邻图例 `品牌色 / DF0C27` |
| 228:1043 | 登录语义色板/swatch 2 | x/y/w/h | `42958 / -24494 / 142 / 142` | 填充值 not-exposed；紧邻图例 `highlight / A61629` |
| 228:1044 | 登录语义色板/swatch 3 | x/y/w/h | `42958 / -24294 / 142 / 142` | 填充值 not-exposed；紧邻图例 `背景 / 2A2828` |
| 228:1045 | 登录语义色板/swatch 4 | x/y/w/h | `42958 / -24094 / 142 / 142` | 填充值 not-exposed；紧邻图例 `卡片、输入框 / 312F2F` |
| 228:1046 | 登录语义色板/swatch 5 | x/y/w/h | `42958 / -23894 / 142 / 142` | 填充值 not-exposed；紧邻图例 `边框 / 434343` |
| 228:1047 | 登录语义色板/swatch 6 | x/y/w/h | `42958 / -23694 / 142 / 142` | 填充值 not-exposed；紧邻图例 `二级信息 / 6F6F6F` |
| 228:1048 | 登录语义色板/swatch 7 | x/y/w/h | `42958 / -23494 / 142 / 142` | 填充值 not-exposed；紧邻图例 `正文 / D4D4D4` |
| 228:1049 | 登录语义色板/swatch 8 | x/y/w/h | `42958 / -23294 / 142 / 142` | 填充值 not-exposed；紧邻图例 `纯白 / FFFFFF` |
| 228:1058/228:1051 | 登录语义色板/图例 | 内容/x/y/w/h | `品牌色 / DF0C27`；`42832/-24648/84/39`；`43134/-24648/107/39` | 文字样式 not-exposed |
| 228:1050/228:1052 | 登录语义色板/图例 | 内容/x/y/w/h | `highlight / A61629`；`42800/-24437/115/39`；`43134/-24437/98/39` | 文字样式 not-exposed |
| 228:1065/228:1064 | 登录语义色板/图例 | 内容/x/y/w/h | `背景 / 2A2828`；`42858/-24237/56/39`；`43134/-24237/103/39` | 文字样式 not-exposed |
| 228:1059/228:1055 | 登录语义色板/图例 | 内容/x/y/w/h | `卡片、输入框 / 312F2F`；`42746/-24045/168/39`；`43134/-24039/95/39` | 文字样式 not-exposed |
| 228:1060/228:1053 | 登录语义色板/图例 | 内容/x/y/w/h | `边框 / 434343`；`42858/-23851/56/30`；`43134/-23863/101/39` | 文字样式 not-exposed |
| 228:1061/228:1056 | 登录语义色板/图例 | 内容/x/y/w/h | `二级信息 / 6F6F6F`；`42802/-23661/112/39`；`43134/-23647/100/39` | 文字样式 not-exposed |
| 228:1063/228:1054 | 登录语义色板/图例 | 内容/x/y/w/h | `正文 / D4D4D4`；`42858/-23455/56/39`；`43134/-23455/111/39` | 文字样式 not-exposed |
| 228:1062/228:1057 | 登录语义色板/图例 | 内容/x/y/w/h | `纯白 / FFFFFF`；`42858/-23250/56/39`；`43134/-23250/98/39` | 文字样式 not-exposed |

## 2. 输入组件

### input_2（247:1569）

| nodeId | 元素/层级路径 | 属性 | 值 | 备注 |
|---|---|---|---|---|
| 247:1569 | input_2 | x/y/w/h | `47261 / -24468 / 580 / 420` | 组件库容器 |
| 247:1570 | input_2/normal 未输入 | x/y/w/h | `20 / 20 / 540 / 80` | 状态变体 1/4 |
| 247:1570 | input_2/normal 未输入 | fill；描边；圆角 | `#EEEEEE, 100%；1px #D4D4D4；40px` | 效果 not-exposed |
| 247:1571 | input_2/normal 未输入/TEXT | x/y/w/h | `31 / 50%（translateY -50%）/409 / not-exposed` | 左内边距 31px；纵向居中 |
| 247:1571 | input_2/normal 未输入/TEXT | 文字 | `TEXT；HarmonyOS Sans SC Regular；24px；line-height normal；#D4D4D4` | 字重为字体样式 Regular；字间距 not-exposed |
| 247:1575 | input_2/Activate | x/y/w/h | `20 / 120 / 540 / 80` | 状态变体 2/4 |
| 247:1575 | input_2/Activate | fill；描边；圆角 | `#EEEEEE, 100%；1px #2A2828；40px` | 效果 not-exposed |
| 247:1576 | input_2/Activate/TEXT | x/y/w/h | `31 / 50%（translateY -50%）/409 / not-exposed` | 左内边距 31px；纵向居中 |
| 247:1576 | input_2/Activate/TEXT | 文字 | `TEXT；HarmonyOS Sans SC Bold；24px；line-height normal；#252222` | 字间距 not-exposed |
| 247:1580 | input_2/error | x/y/w/h | `20 / 220 / 540 / 80` | 状态变体 3/4 |
| 247:1580 | input_2/error | fill；描边；圆角 | `#EEEEEE, 100%；1px #D91F37；40px` | 效果 not-exposed |
| 247:1581 | input_2/error/TEXT | x/y/w/h | `31 / 50%（translateY -50%）/409 / not-exposed` | 左内边距 31px；纵向居中 |
| 247:1581 | input_2/error/TEXT | 文字 | `TEXT；HarmonyOS Sans SC Bold；24px；line-height normal；#252222` | 字间距 not-exposed |
| 347:1222 | input_2/normal 已输入 | x/y/w/h | `20 / 320 / 540 / 80` | 状态变体 4/4 |
| 347:1222 | input_2/normal 已输入 | fill；描边；圆角 | `#EEEEEE, 100%；1px #D4D4D4；40px` | 效果 not-exposed |
| 347:1223 | input_2/normal 已输入/TEXT | x/y/w/h | `31 / 50%（translateY -50%）/409 / not-exposed` | 左内边距 31px；纵向居中 |
| 347:1223 | input_2/normal 已输入/TEXT | 文字 | `TEXT；HarmonyOS Sans SC Bold；24px；line-height normal；#252222` | 字间距 not-exposed |

### input_验证码（329:1229）

| nodeId | 元素/层级路径 | 属性 | 值 | 备注 |
|---|---|---|---|---|
| 329:1229 | input_验证码 | x/y/w/h | `47261 / -24018 / 580 / 420` | 组件库容器 |
| 329:1230 | input_验证码/normal未输入 | x/y/w/h；fill；描边；圆角 | `20/20/540/80；#EEEEEE, 100%；1px #D4D4D4；40px` | 状态变体 1/4；效果 not-exposed |
| 329:1231 | input_验证码/normal未输入/TEXT | x/y/w/h；文字 | `calc(50% + 0.5px)/50%（translate -50%, -50%）/409/not-exposed；TEXT；HarmonyOS Sans SC Regular；24px；line-height normal；居中；#D4D4D4` | 字间距 not-exposed |
| 329:1232 | input_验证码/Activate | x/y/w/h；fill；描边；圆角 | `20/120/540/80；#EEEEEE, 100%；1px #2A2828；40px` | 状态变体 2/4；效果 not-exposed |
| 329:1233 | input_验证码/Activate/TEXT | x/y/w/h；文字 | `calc(50% + 0.5px)/50%（translate -50%, -50%）/409/not-exposed；TEXT␠；HarmonyOS Sans SC Bold；24px；line-height normal；居中；#252222` | `TEXT` 后原文有 1 个空格；字间距 not-exposed |
| 329:1234 | input_验证码/error | x/y/w/h；fill；描边；圆角 | `20/220/540/80；#EEEEEE, 100%；1px #D91F37；40px` | 状态变体 3/4；效果 not-exposed |
| 329:1235 | input_验证码/error/TEXT | x/y/w/h；文字 | `calc(50% + 0.5px)/50%（translate -50%, -50%）/409/not-exposed；TEXT；HarmonyOS Sans SC Bold；24px；line-height normal；居中；#252222` | 字间距 not-exposed |
| 347:1232 | input_验证码/normal 已输入 | x/y/w/h；fill；描边；圆角 | `20/320/540/80；#EEEEEE, 100%；1px #D4D4D4；40px` | 状态变体 4/4；效果 not-exposed |
| 347:1233 | input_验证码/normal 已输入/TEXT | x/y/w/h；文字 | `calc(50% + 0.5px)/50%（translate -50%, -50%）/409/not-exposed；TEXT；HarmonyOS Sans SC Bold；24px；line-height normal；居中；#252222` | 字间距 not-exposed |

## 3. 按钮组件

### log_in_button（247:1539）

| nodeId | 元素/层级路径 | 属性 | 值 | 备注 |
|---|---|---|---|---|
| 247:1539 | log_in_button | x/y/w/h | `47261 / -23542 / 580 / 520` | 组件库容器 |
| 247:1538 | log_in_button/normal | x/y/w/h；fill；描边；圆角 | `20/20/540/80；#2A2828, 100%；1px #434343；40px` | 状态变体 1/5；效果 not-exposed |
| 247:1496 | log_in_button/normal/TEXT | x/y/w/h；文字 | `269/50%（translate -50%, -50%）/516/not-exposed；TEXT；HarmonyOS Sans SC Bold；24px；line-height normal；居中；#D4D4D4` | 字间距 not-exposed |
| 247:1540 | log_in_button/hover | x/y/w/h；fill；描边；圆角 | `20/120/540/80；linear-gradient(90deg, rgba(255,255,255,0.08) 0%→100%) + #2A2828；1px #434343；40px` | 状态变体 2/5；仅桌面 hover；效果 not-exposed |
| 247:1541 | log_in_button/hover/TEXT | x/y/w/h；文字 | `269/50%（translate -50%, -50%）/516/not-exposed；TEXT；HarmonyOS Sans SC Bold；24px；line-height normal；居中；#D4D4D4` | 字间距 not-exposed |
| 247:1542 | log_in_button/Pressd | x/y/w/h；fill；描边；圆角 | `20/220/540/80；linear-gradient(90deg, rgba(0,0,0,0.5) 0%→100%) + #2A2828；1px #434343；40px` | 状态变体 3/5；图层名原文为 `Pressd`；效果 not-exposed |
| 247:1543 | log_in_button/Pressd/TEXT | x/y/w/h；文字 | `269/50%（translate -50%, -50%）/516/not-exposed；TEXT；HarmonyOS Sans SC Bold；24px；line-height normal；居中；#D4D4D4` | 字间距 not-exposed |
| 247:1544 | log_in_button/load | x/y/w/h；fill；描边；圆角 | `20/320/540/80；#2A2828, 100%；1px #434343；40px` | 状态变体 4/5；效果 not-exposed |
| 247:1545 | log_in_button/load/TEXT | x/y/w/h；文字 | `269/50%（translate -50%, -50%）/516/not-exposed；TEXT；HarmonyOS Sans SC Bold；24px；line-height normal；居中；#D4D4D4` | 字间距 not-exposed |
| 247:1546 | log_in_button/load/加载图标 | x/y/w/h | `487 / 27 / 24 / 24` | 图片 asset；动画/旋转参数 not-exposed |
| 329:1226 | log_in_button/Disable | x/y/w/h；fill；描边；圆角 | `20/420/540/80；linear-gradient(90deg, rgba(255,255,255,0.7) 0%→100%) + #2A2828；1px #B4B4B4；40px` | 状态变体 5/5；效果 not-exposed |
| 329:1227 | log_in_button/Disable/TEXT | x/y/w/h；文字；opacity | `269/50%（translate -50%, -50%）/516/not-exposed；TEXT；HarmonyOS Sans SC Bold；24px；line-height normal；居中；#D4D4D4；80%` | 字间距 not-exposed |

### white_button（347:2526）

| nodeId | 元素/层级路径 | 属性 | 值 | 备注 |
|---|---|---|---|---|
| 347:2526 | white_button | x/y/w/h | `47918 / -23542 / 580 / 520` | 组件库容器；metadata 中仅列出 4 个变体 |
| 347:2527 | white_button/normal | x/y/w/h；fill；描边；圆角 | `20/20/540/80；#EEEEEE, 100%；1px #FFFFFF；40px` | 状态变体 1/4；效果 not-exposed |
| 347:2528 | white_button/normal/TEXT | x/y/w/h；文字 | `269/50%（translate -50%, -50%）/516/not-exposed；TEXT；HarmonyOS Sans SC Bold；24px；line-height normal；居中；#2A2828` | 字间距 not-exposed |
| 347:2529 | white_button/hover | x/y/w/h；fill；描边；圆角 | `20/120/540/80；linear-gradient(90deg, rgba(0,0,0,0.05) 0%→100%) + #EEEEEE；1px #FFFFFF；40px` | 状态变体 2/4；仅桌面 hover；效果 not-exposed |
| 347:2530 | white_button/hover/TEXT | x/y/w/h；文字 | `269/50%（translate -50%, -50%）/516/not-exposed；TEXT；HarmonyOS Sans SC Bold；24px；line-height normal；居中；#2A2828` | 字间距 not-exposed |
| 347:2531 | white_button/Pressd | x/y/w/h；fill；描边；圆角 | `20/220/540/80；linear-gradient(90deg, rgba(0,0,0,0.1) 0%→100%) + #EEEEEE；1px #E5E5E5；40px` | 状态变体 3/4；图层名原文为 `Pressd`；效果 not-exposed |
| 347:2532 | white_button/Pressd/TEXT | x/y/w/h；文字 | `269/50%（translate -50%, -50%）/516/not-exposed；TEXT；HarmonyOS Sans SC Bold；24px；line-height normal；居中；#2A2828` | 字间距 not-exposed |
| 347:2537 | white_button/Disable | x/y/w/h；fill；描边；圆角 | `20/320/540/80；linear-gradient(90deg, rgba(255,255,255,0.7) 0%→100%) + #2A2828；1px #B4B4B4；40px` | 状态变体 4/4；效果 not-exposed |
| 347:2538 | white_button/Disable/TEXT | x/y/w/h；文字；opacity | `269/50%（translate -50%, -50%）/516/not-exposed；TEXT；HarmonyOS Sans SC Bold；24px；line-height normal；居中；#D4D4D4；80%` | 字间距 not-exposed |

## 4. 文本链接、返回与其他登录入口

### Text_link（247:1613）

| nodeId | 元素/层级路径 | 属性 | 值 | 备注 |
|---|---|---|---|---|
| 247:1613 | Text_link | x/y/w/h | `47278 / -22837 / 580 / 160` | 组件库容器 |
| 247:1612 | Text_link/重新发送 | x/y/w/h | `20 / 20 / 540 / 50` | 状态变体 1/2 |
| 247:1610 | Text_link/重新发送/文字 | x/y/w/h；文字 | `270.5/calc(50% - 1.5px)（translate -50%, -50%）/189/not-exposed；重新发送；HarmonyOS Sans SC Regular；20px；line-height normal；居中；#2A2828；underline` | 下划线为 `decoration-from-font`；字间距 not-exposed |
| 247:1614 | Text_link/倒计时重发 | x/y/w/h | `20 / 90 / 540 / 50` | 状态变体 2/2 |
| 247:1615 | Text_link/倒计时重发/文字 | x/y/w/h；文字 | `270.5/calc(50% - 1.5px)（translate -50%, -50%）/189/not-exposed；42 秒后可重新发送；HarmonyOS Sans SC Regular；20px；line-height normal；居中；#D4D4D4` | 无下划线；字间距 not-exposed |

### back（247:1636）

| nodeId | 元素/层级路径 | 属性 | 值 | 备注 |
|---|---|---|---|---|
| 247:1636 | back | x/y/w/h | `47278 / -22606 / 100 / 260` | 组件库容器 |
| 247:1635 | back/normal | x/y/w/h；fill；描边；圆角 | `20/20/60/60；#EEEEEE, 100%；1px #FFFFFF；40px` | 状态变体 1/3；效果 not-exposed |
| 247:1632 | back/normal/图标容器 | x/y/w/h；变换 | `18/17/24/24；rotate(-90deg) + scaleY(-1)` | 图标为图片 asset；其路径/描边 not-exposed |
| 247:1637 | back/hover | x/y/w/h；fill；描边；圆角 | `20/100/60/60；linear-gradient(90deg, rgba(255,255,255,0.7) 0%→100%) + #EEEEEE；1px #FFFFFF；40px` | 状态变体 2/3；仅桌面 hover；效果 not-exposed |
| 247:1639 | back/hover/图标容器 | x/y/w/h；变换 | `18/17/24/24；rotate(-90deg) + scaleY(-1)` | 从根组件 context 读取 |
| 247:1645 | back/pressed | x/y/w/h；fill；描边；圆角 | `20/180/60/60；linear-gradient(90deg, rgba(0,0,0,0.08) 0%→100%) + #EEEEEE；1px #ECECEC；40px` | 状态变体 3/3；从根组件 context 读取 |
| 247:1646 | back/pressed/图标容器 | x/y/w/h；变换 | `18/17/24/24；rotate(-90deg) + scaleY(-1)` | 从根组件 context 读取 |

### 其他登录方式入口（247:1710）

| nodeId | 元素/层级路径 | 属性 | 值 | 备注 |
|---|---|---|---|---|
| 247:1710 | 其他登录方式入口 | x/y/w/h | `47423 / -22606 / 120 / 420` | 组件库容器；视觉属性未取得，见缺口 |
| 247:1709 | 其他登录方式入口/Apple | x/y/w/h | `20 / 20 / 80 / 80` | 状态变体 1/4；图标、fill、描边、圆角、效果 not-exposed |
| 247:1711 | 其他登录方式入口/Google | x/y/w/h | `20 / 120 / 80 / 80` | 状态变体 2/4；图标、fill、描边、圆角、效果 not-exposed |
| 247:1721 | 其他登录方式入口/Wechat | x/y/w/h | `20 / 220 / 80 / 80` | 状态变体 3/4；图标、fill、描边、圆角、效果 not-exposed |
| 329:243 | 其他登录方式入口/SSO | x/y/w/h | `20 / 320 / 80 / 80` | 状态变体 4/4；图标、fill、描边、圆角、效果 not-exposed |

### error_text（247:2158）

| nodeId | 元素/层级路径 | 属性 | 值 | 备注 |
|---|---|---|---|---|
| 247:2158 | error_text | x/y/w/h | `47278 / -22150 / 680 / 50` | 单一状态 1/1 |
| 247:2158 | error_text | fill/描边/圆角/文字/效果 | `not-exposed` | 文字内容原文未从可用 MCP 响应取得；不补写 |

## 5. 企业 SSO 与立绘

### SSO 登录_企业（329:957）

| nodeId | 元素/层级路径 | 属性 | 值 | 备注 |
|---|---|---|---|---|
| 329:957 | SSO 登录_企业 | x/y/w/h | `48612 / -24410 / 580 / 380` | 组件库容器 |
| 329:956 | SSO 登录_企业/Normal | x/y/w/h | `20 / 20 / 540 / 100` | 状态变体 1/3；fill、描边、圆角、内边距、子元素 gap、文字、效果 not-exposed |
| 329:991 | SSO 登录_企业/Hover | x/y/w/h | `20 / 140 / 540 / 100` | 状态变体 2/3；仅桌面 hover；视觉参数 not-exposed |
| 329:1009 | SSO 登录_企业/Pressed | x/y/w/h | `20 / 260 / 540 / 100` | 状态变体 3/3；视觉参数 not-exposed |

### 立绘组

| nodeId | 元素/层级路径 | 属性 | 值 | 备注 |
|---|---|---|---|---|
| 347:971 | CINDY_Client | x/y/w/h | `48718 / -23749 / 934 / 934` | 单一组件/状态 1/1；内部子层、asset、fill、效果 not-exposed |
| 347:2707 | CINDY_mobile | x/y/w/h | `49872 / -23803 / 750 / 902` | 单一组件/状态 1/1；内部子层、asset、fill、效果 not-exposed |

## 6. 平台与 hover 覆盖

| nodeId | 元素/层级路径 | 属性 | 值 | 备注 |
|---|---|---|---|---|
| 247:1540 | log_in_button/hover | hover 节点 | `有` | 按规则只在桌面端实现 |
| 347:2529 | white_button/hover | hover 节点 | `有` | 按规则只在桌面端实现 |
| 247:1637 | back/hover | hover 节点 | `有` | 按规则只在桌面端实现 |
| 329:991 | SSO 登录_企业/Hover | hover 节点 | `有` | 按规则只在桌面端实现 |
| 247:1569/329:1229/247:1613/247:1710/247:2158/347:971/347:2707 | 其余指定组件 | hover 节点 | `未见` | 本次逐节点 metadata 未列 Hover 变体；移动端不实现 hover |
| 全部指定组件 | 平台差异 | 属性 | `未见 Desktop/Mobile variant property` | 仅 CINDY_Client 与 CINDY_mobile 为两个独立节点；不能据此推断其它组件存在平台差异 |

## 缺口清单（10 条）

1. `228:1042–228:1049` 的实际 fill/透明度未从可用响应暴露；本文仅记录相邻图例文字，不把图例反推为 swatch 填充。
2. `247:1709/247:1711/247:1721/329:243` 的圆钮图标路径、fill、描边、圆角、效果未取得。
3. `247:2158` 的错误文案原文、字体、颜色、对齐及视觉参数未取得。
4. `329:956/329:991/329:1009` 的企业 SSO 视觉、文字、内边距与子元素 gap 未取得。
5. `347:971` 的 CINDY_Client 内部层级、图片 asset、裁切和效果未取得。
6. `347:2707` 的 CINDY_mobile 内部层级、图片 asset、裁切和效果未取得。
7. 所有已读文本的字间距未在返回中暴露；行高仅以 `normal` 返回，未给出原始数值。
8. 所有已读组件的 Figma effect（阴影/模糊）结构未在返回中暴露；本文按要求标为 `not-exposed`，不以无 CSS class 推断为“无效果”。
9. `247:1546` 加载图标仅作为 24×24 asset 返回，未给出动画方式、时长或 easing。
10. back 图标仅作为图片 asset 返回，未给出 vector path、stroke 宽度或颜色；已记录其容器尺寸与变换。

## 读取失败项

| nodeId | 调用 | 结果 | 影响 |
|---|---|---|---|
| 247:1635 | get_screenshot | Figma MCP Full seat 调用额度耗尽 | 已有 root `247:1636` 截图和 root context；不影响已记录 normal 参数 |
| 247:1637 | get_design_context / get_screenshot | Figma MCP Full seat 调用额度耗尽 | hover 视觉参数取自额度耗尽前读取成功的 root `247:1636` context |
| 247:1645 | get_design_context / get_screenshot | Figma MCP Full seat 调用额度耗尽 | pressed 视觉参数取自额度耗尽前读取成功的 root `247:1636` context |

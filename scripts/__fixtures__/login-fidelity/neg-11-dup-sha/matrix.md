# fixture 负例⑪ · 未声明复用组的重复 SHA

> fixture 矩阵(仅供 checker self-test)。唯一 ```json 机读块如下。

```json
{
  "cells": {
    "desktop.brand-background.style|mac|zh-CN|cn": {
      "value": "PASS",
      "evidence": "dup-a.txt",
      "baseline": {
        "source": "wave4",
        "ref": "368:1375"
      },
      "reviewer": "fixture-reviewer",
      "approvedAt": "2026-07-20T00:00:00.000Z"
    },
    "desktop.brand-background.style|mac|zh-TW|cn": {
      "value": "PASS",
      "evidence": "dup-b.txt",
      "baseline": {
        "source": "wave4",
        "ref": "368:1375"
      },
      "reviewer": "fixture-reviewer",
      "approvedAt": "2026-07-20T00:00:00.000Z"
    }
  }
}
```

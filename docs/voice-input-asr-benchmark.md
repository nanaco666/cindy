# 语音输入 Benchmark

这个脚本用于对比语音输入使用的 ASR provider 在同一段录音上的响应速度和识别结果，也可以对比 refine 模型在同一批文本上的速度和润色质量。

## 准备录音

如果本地已经有语音输入录音，脚本会优先使用最近一条。也可以显式传入 WAV 文件：

```bash
pnpm benchmark:voice-input -- asr --audio /path/to/sample.wav
```

录音文件建议使用 16 kHz / mono / PCM16 WAV。脚本会按 provider 需要转换为 16 kHz 或 24 kHz PCM。

## 对比默认三组 ASR

```bash
pnpm benchmark:voice-input -- asr \
  --audio /path/to/sample.wav \
  --source-language zh-CN \
  --timeout-ms 60000 \
  --out /tmp/xdt-asr-compare.json
```

默认会测试：

- `litellm-qwen3-asr-flash-realtime`
- `litellm-gpt-realtime-whisper`
- `litellm-volcengine-sauc-asr`

## API Key

脚本会按顺序读取：

1. `--api-key`
2. `XDT_VOICE_INPUT_BENCHMARK_API_KEY`
3. `XDT_LITELLM_API_KEY`
4. App safeStorage 中保存的 XD Proxy API Key

脚本不会打印 API Key。

## 结果字段

- `ws`: WebSocket 建连耗时。
- `ready`: 会话可发送音频的耗时。
- `firstPartial`: 第一次返回流式文本的耗时。
- `completed`: 最终文本完成的耗时。
- `afterAudio`: 录音发送完成后，等待最终文本的耗时。
- `transcript`: 最终识别文本。

`completed` 越低代表从开始测试到最终文本返回越快；`afterAudio` 越低代表用户说完后等待越短。

## 常用参数

```bash
pnpm benchmark:voice-input -- asr \
  --providers litellm-qwen3-asr-flash-realtime,litellm-volcengine-sauc-asr \
  --iterations 3 \
  --audio /path/to/sample.wav \
  --source-language zh-CN \
  --chunk-ms 40 \
  --timeout-ms 60000 \
  --out /tmp/xdt-asr-compare.json
```

需要排查 provider 协议事件时可以加：

```bash
--debug-events
```

## 对比 refine 模型

```bash
pnpm benchmark:voice-input -- refine \
  --iterations 1 \
  --timeout-ms 60000 \
  --out /tmp/xdt-refine-compare.json
```

默认会使用生产 `DictationRefiner` 的系统 prompt 和三个内置样例，测试：

- `gpt-5.4-nano`
- `qwen/qwen3.6-plus`
- `qwen/qwen3.7-max`
- `z-ai/glm-5.1`
- `moonshotai/kimi-k2.6`

当前 `/v1/models` 未返回可用于文本润色的豆包模型，只看到 `doubao-seedance-*` 视频模型；如果网关后续暴露豆包文本模型，可以通过 `--models` 显式传入。

脚本的 JSON 解析策略和生产 `LiteLlmTextModelClient` 保持一致：优先解析完整 JSON；如果模型在 JSON 外包了一层额外文本，会抽取第一个 JSON object 再解析。这样 benchmark 能反映真实 refine 链路的兼容性。

也可以传入自己的单条样例：

```bash
pnpm benchmark:voice-input -- refine \
  --models qwen/qwen3.6-plus,z-ai/glm-5.1,moonshotai/kimi-k2.6 \
  --dictation-text "我们现在用来反映的 pump 的文字" \
  --expected-text "我们现在用来 refine 的 prompt 的文字" \
  --out /tmp/xdt-refine-compare.json
```

或传入 JSON case 文件：

```json
[
  {
    "id": "tech-terms",
    "dictationText": "我们现在用来反映的 pump 的文字",
    "expectedText": "我们现在用来 refine 的 prompt 的文字",
    "context": {
      "userDictionary": "refine\nprompt\nLiteLLM"
    }
  }
]
```

结果里 `total` 是单次 refine 完整耗时，`similarity` 是和 `expectedText` 的编辑距离相似度，`cached` 是网关返回的缓存命中 token 数。

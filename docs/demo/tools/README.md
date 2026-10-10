# 演示视频工具链

生成 `docs/demo/` 下那份 RAG 全流程演示视频所需的全部脚本。全程驱动**真实浏览器 + 真实后端**，不做 mock —— 录出来就是系统真实运行的样子。

## 前置条件

1. **后端与前端已启动**，Docker 依赖容器就绪
   - 后端 `http://127.0.0.1:3000`
   - 前端 `http://127.0.0.1:5173`
2. **playwright 必须锁 `1.57.0`**
   它对应 `chromium-1200`。升到 1.64 会要求 `chromium-1248`，直接报
   `Executable doesn't exist at .../chromium_headless_shell-1248`。
3. **ffmpeg 必须是完整构建**（含 `libx264` + concat demuxer + mp4 封装）。
   Playwright 自带的精简版只有 `image2pipe` + `webm/matroska`，**没有 mp4**，不能用。
   路径通过 `DEMO_FFMPEG` 环境变量覆盖，默认值见 `build-video.mjs` / `narrate.mjs`。
4. 配音额外需要 DashScope key：脚本从 `knowledge-hub-backend/.env` 读 `OPENAI_API_KEY`。

## 执行顺序

```bash
npm i                  # 安装 playwright@1.57.0

npm run reset:corpus   # 1. 清空语料只留账号（可选，为了从零演示入库流程）
npm run startup-page   # 2. 真实启动日志 -> docs/demo/assets/startup.html
npm run record         # 3. 六章录制 -> out/webm/ch*.webm
npm run build:video    # 4. 章节卡 + 转码 + 拼接 -> out/rag-demo.mp4
npm run frames         # 5. 按时间点抽帧验收 -> out/verify/

# 配音（可选）
npm run narrate:check  # 先看时长预算表，确认各章台词落在安全区
npm run narrate:tts    # TTS 合成 + 逐章对齐 + 生成 ASS 字幕与音轨
npm run narrate:mux    # 混流 + 烧字幕 -> docs/demo/*配音版*.mp4
```

分章重录：`node record.mjs --only=ch3,ch4`（支持自定义顺序）。

## 脚本职责

| 脚本 | 作用 |
|---|---|
| `record.mjs` | 六章 Playwright 录制。每章独立 BrowserContext，单章失败可单独重录 |
| `chapters.mjs` | 章节元数据（标题 / 字幕条 tag / 视口模式），录制与后期共用，避免两处漂移 |
| `build-video.mjs` | 渲染章节卡 PNG → 转 2.4s 静帧 → 与正文交替拼接成主片 |
| `build-startup-page.mjs` | 剥 ANSI 转义码、白名单去重、把启动日志渲染成终端风 HTML |
| `reset-corpus.mjs` | 走产品自身接口清空文档 / ES / Neo4j / 会话 / mem0 |
| `probe-intents.mjs` | 录制前预检四类意图路由，避免录完才发现意图判错要重录 |
| `extract-frames.mjs` | 成片按时间点抽 PNG，人工验收 |
| `narrate.mjs` | TTS 合成 → 逐章 `atempo` 对齐 → ASS 字幕 → 混流（`--check` / `--tts` / `--mux` 可分段执行） |
| `narration.mjs` | 配音讲稿结构化数据（`card` + `blocks`）。**改台词只动这里** |

## 关键约束

- **成片分段顺序是 `[章节卡][正文]` 交替**，不是先正文后卡 —— `build-video.mjs` 用 `splice` 把卡插到正文之前。
  早期文档里的时长清单把正文列在前，那只是报表的 push 顺序，别被误导。
- **旁白写稿受画面时长约束**：语速基准 5.5 字/秒，各章台词总时长须落在该章画面 **±10%** 内，
  否则 `atempo` 的变速会被听出来。改完稿用 `npm run narrate:check` 校验占比。
- **讲稿里不要写带下划线的标识符**（`web_search` / `retrieve_knowledge` 之类），TTS 会读错，
  一律改写成自然语言；`NestJS` / `MinerU` / `RRF` / `Elasticsearch` 这类词可以保留。
- **TTS 直出的音频不能直接混流**：实测平均只有 −25 dBFS 且有削波，
  `narrate.mjs` 里加了 `loudnorm=I=-16:TP=-1.5:LRA=11` 归一化。
- 配音的**音色基准语速差异很大**（同一段文本 Cherry 6.00s / Kai 5.28s / Ethan 4.72s，差 27%），
  换音色后必须重新跑 `--check`，字数配比会变。
- `out/` 是中间产物目录，已 gitignore。

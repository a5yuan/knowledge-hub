/**
 * 演示视频章节元数据（录制器与后期合成脚本共用，避免两处漂移）
 */
export const CHAPTER_META = [
  { id: 'ch1', no: 1, title: '项目启动过程', tag: '9 容器 → NestJS 后端 → Vue 前端 → 就绪探针', mode: 'doc' },
  { id: 'ch2', no: 2, title: '知识库构建', tag: '上传 PDF → MinerU 解析 → 提审 → 发布 → 切片入库', mode: 'app' },
  { id: 'ch3', no: 3, title: '场景一 · 纯知识库检索', tag: 'intent = knowledge', mode: 'app' },
  { id: 'ch4', no: 4, title: '场景二 · 联网搜索', tag: 'intent = web', mode: 'app' },
  { id: 'ch5', no: 5, title: '场景三 · 知识库不足自动联网', tag: 'intent = knowledge_then_web', mode: 'app' },
  { id: 'ch6', no: 6, title: '场景四 · 其他情形（闲聊）', tag: 'intent = chitchat', mode: 'app' },
];

export const TOTAL = CHAPTER_META.length;

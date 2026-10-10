# 知识图谱探针结果（卡 4 证据补齐）

- 采集时间：2026-10-09T02:20:24.569Z
- 被测 BASE：`http://localhost:3000`
- 延迟口径：客户端端到端 wall time（每端点 20 次，含 JWT 鉴权与 JSON 序列化）
- 图谱检索机制：Cypher 属性子串匹配 `toLower(x) CONTAINS toLower($q)`，**无全文索引**（controller 注释明确「不建索引」）

## 图谱规模

- `/kg/overview` 自报 stats：`{"docNodes":6,"entities":182,"relatedEdges":139,"mentionEdges":188,"tags":0}`
- 返回节点 188（按 kind：document=6、entity=182）
- 返回边 327（按 kind：related=139、mentions=188）
- 实体类型分布：tech 96 / term 63 / org 9 / person 8 / location 3 / other 3

### 关系总量（Neo4j 直查，口径：`MATCH ()-[r]->() RETURN type(r), count(*)`）

| 关系类型 | 数量 |
| :--- | ---: |
| MENTIONS | 242 |
| RELATED_TO | 139 |
| HAS_CHUNK | 33 |

### 按文档的抽取产出（口径见下方 Cypher）

| 文档 | 抽出的实体数 | RELATED_TO 边数 |
| :--- | ---: | ---: |
| 吴金远_前端开发_简历_2026 | 105 | 88 |
| 实习总结 | 64 | 46 |
| 研发中心新员工入职指南 | 11 | 9 |
| 数据安全与权限管理规范 | 2 | 5 |
| 考勤与加班餐补制度 | 2 | 1 |
| 项目立项与审批流程 | 4 | 1 |

```cypher
MATCH (d:Document)-[:HAS_CHUNK]->(:Chunk)-[:MENTIONS]->(e:Entity) WITH d, count(DISTINCT e) AS ents MATCH (d)-[:HAS_CHUNK]->(:Chunk)-[:MENTIONS]->(:Entity)-[r:RELATED_TO]-(:Entity) RETURN d.title AS doc, ents AS entities, count(DISTINCT r) AS related_edges ORDER BY related_edges DESC
```

### RELATED_TO 抽样（前 15 条）

| 头实体 | 关系 | 尾实体 |
| :--- | :-: | :--- |
| vue-ueditor-wrap | 使用 | Vue |
| el-form | 使用 | Element Plus |
| Vue | 使用 | Element Plus |
| el-form | 包含 | Vxe-table |
| v-if | 控制 | vue-ueditor-wrap |
| v-show | 控制 | vue-ueditor-wrap |
| 客户分布分析页面 | 包含 | 饼图 |
| Echarts | 支持 | 饼图 |
| 销售数据分析页面 | 包含 | 柱状图 |
| Echarts | 支持 | 柱状图 |
| Echarts | 支持 | 折线图 |
| 网站流量趋势分析页面 | 包含 | 折线图 |
| Element Plus | 包含 | El-menu |
| Element Plus | 包含 | El-header |
| Element Plus | 包含 | El-row |

## 端点延迟

| 端点 | 样本 | 均值 ms | P50 ms | P95 ms | 最大 ms | 备注 |
| :--- | ---: | ---: | ---: | ---: | ---: | :--- |
| `GET /kg/search?q=王工` | 20 | 36.2 | 36.0 | 39.0 | 42.0 | — |
| `GET /kg/nodes?label=entity&q=王工` | 20 | 37.7 | 30.0 | 60.0 | 68.0 | — |
| `GET /kg/edges?rel=related_to&entity=王工` | 20 | 30.1 | 29.0 | 38.0 | 40.0 | — |
| `GET /kg/overview?limit=2000` | 20 | 55.1 | 54.0 | 61.0 | 69.0 | — |
| `GET /rag/search?q=王工（对照：文档侧）` | 20 | 336.3 | 309.0 | 418.0 | 499.0 | — |

> 对照项说明：最后一行是**文档侧** `/rag/search` 在同 query 下的耗时，用来对比"图谱一次往返"与"混合检索一次往返"的成本差。
> 该对照的耗时里包含查询向量化与精排两次**公网模型调用**，所以差距反映的是链路结构差异，不是 Neo4j 本身慢。

## 关系型问题样例：文档侧 vs 图谱侧

### 「Vue」——图谱应能答：技术类实体：简历文档里 Vue 的关系被抽出来了

- 文档侧 `/rag/search` Top5 命中文档：实习总结 / 吴金远_前端开发_简历_2026
- 图谱侧 `/kg/search` 命中实体：Vue(tech)、Vue Router(tech)、Vue3(tech)、vue-ueditor-wrap(tech)
- 图谱侧 `/kg/search` 命中关系：Vue -使用-> Element Plus；Vue3 -使用-> TypeScript；Vue3 -使用-> Pinia；Vue3 -使用-> Vue Router；vue-ueditor-wrap -使用-> Vue
- 图谱侧 `/kg/edges?entity=Vue` 关联边：6 条

<details><summary>原始返回（截断）</summary>

```json
{
  "ragItems": [
    {
      "doc_title": "实习总结",
      "chunk_index": 0,
      "score": 0.031754032258064516
    },
    {
      "doc_title": "吴金远_前端开发_简历_2026",
      "chunk_index": 1,
      "score": 0.03149801587301587
    },
    {
      "doc_title": "实习总结",
      "chunk_index": 1,
      "score": 0.030834914611005692
    },
    {
      "doc_title": "实习总结",
      "chunk_index": 4,
      "score": 0.030679156908665108
    },
    {
      "doc_title": "吴金远_前端开发_简历_2026",
      "chunk_index": 8,
      "score": 0.03007688828584351
    }
  ],
  "kgEntities": [
    {
      "name": "Vue",
      "type": "tech",
      "description": null
    },
    {
      "name": "Vue Router",
      "type": "tech",
      "description": null
    },
    {
      "name": "Vue3",
      "type": "tech",
      "description": null
    },
    {
      "name": "vue-ueditor-wrap",
      "type": "tech",
      "description": null
    }
  ],
  "kgEdges": [
    {
      "sourceName": "Vue",
      "sourceType": "tech",
      "relation": "使用",
      "targetName": "Element Plus",
      "targetType": "tech"
    },
    {
      "sourceName": "Vue3",
      "sourceType": "tech",
      "relation": "使用",
      "targetName": "TypeScript",
      "targetType": "tech"
    },
    {
      "sourceName": "Vue3",
      "sourceType": "tech",
      "relation": "使用",
      "targetName": "Pinia",
      "targetType": "tech"
    },
    {
      "sourceName": "Vue3",
      "sourceType": "tech",
      "relation": "使用",
      "targetName": "Vue Router",
      "targetType": "tech"
    },
    {
      "sourceName": "vue-ueditor-wrap",
      "sourceType": "tech",
      "relation": "使用",
      "targetName": "Vue",
      "targetType": "tech"
    }
  ],
  "kgNodes": [
    {
      "label": "entity",
      "name": "Vue",
      "type": "tech",
      "description": null,
      "mentionCount": 6,
      "relatedCount": 6
    },
    {
      "label": "entity",
      "name": "Vue3",
      "type": "tech",
      "description": null,
      "mentionCount": 5,
      "relatedCount": 10
    },
    {
      "label": "entity",
      "name": "vue-ueditor-wrap",
      "type": "tech",
      "description": null,
      "mentionCount": 2,
      "relatedCount": 4
    },
    {
      "label": "entity",
      "name": "Vue Router",
      "type": "tech",
      "description": null,
      "mentionCount": 1,
      "relatedCount": 1
    }
  ],
  "kgRelEdges": [
    {
      "rel": "RELATED_TO",
      "sourceName": "Vue",
      "sourceType": "tech",
      "relation": "使用",
      "targetName": "Element Plus",
      "targetType": "tech"
    },
    {
      "rel": "RELATED_TO",
      "sourceName": "vue-ueditor-wrap",
      "sourceType": "tech",
      "relation": "使用",
      "targetName": "Vue",
      "targetType": "tech"
    },
    {
      "rel": "RELATED_TO",
      "sourceName": "Vue",
      "sourceType": "tech",
      "relation": "包含",
      "targetName": "混入",
      "targetType": "term"
    },
    {
      "rel": "RELATED_TO",
      "sourceName": "Vue",
      "sourceType": "tech",
      "relation": "包含",
      "targetName": "响应式原理",
      "targetType": "term"
    },
    {
      "rel": "RELATED_TO",
      "sourceName": "Vue",
      "sourceType": "tech",
      "relation": "包含",
      "targetName": "自定义指令",
      "targetType": "term"
    },
    {
      "rel": "RELATED_TO",
      "sourceName": "Vue",
      "sourceType": "tech",
      "relation": "基于",
      "targetName": "单向数据流原则",
      "targetType": "term"
    }
  ]
}
```

</details>

### 「Element Plus」——图谱应能答：技术类实体：组件库关系

- 文档侧 `/rag/search` Top5 命中文档：实习总结 / 吴金远_前端开发_简历_2026
- 图谱侧 `/kg/search` 命中实体：Element Plus(tech)
- 图谱侧 `/kg/search` 命中关系：Vue -使用-> Element Plus；el-form -使用-> Element Plus；Element Plus -包含-> El-col；Element Plus -包含-> El-form；Element Plus -包含-> El-row
- 图谱侧 `/kg/edges?entity=Element Plus` 关联边：9 条

<details><summary>原始返回（截断）</summary>

```json
{
  "ragItems": [
    {
      "doc_title": "实习总结",
      "chunk_index": 4,
      "score": 0.03278688524590164
    },
    {
      "doc_title": "实习总结",
      "chunk_index": 0,
      "score": 0.03225806451612903
    },
    {
      "doc_title": "吴金远_前端开发_简历_2026",
      "chunk_index": 6,
      "score": 0.03149801587301587
    },
    {
      "doc_title": "吴金远_前端开发_简历_2026",
      "chunk_index": 8,
      "score": 0.031009615384615385
    },
    {
      "doc_title": "吴金远_前端开发_简历_2026",
      "chunk_index": 1,
      "score": 0.030798389007344232
    }
  ],
  "kgEntities": [
    {
      "name": "Element Plus",
      "type": "tech",
      "description": null
    }
  ],
  "kgEdges": [
    {
      "sourceName": "Vue",
      "sourceType": "tech",
      "relation": "使用",
      "targetName": "Element Plus",
      "targetType": "tech"
    },
    {
      "sourceName": "el-form",
      "sourceType": "tech",
      "relation": "使用",
      "targetName": "Element Plus",
      "targetType": "tech"
    },
    {
      "sourceName": "Element Plus",
      "sourceType": "tech",
      "relation": "包含",
      "targetName": "El-col",
      "targetType": "tech"
    },
    {
      "sourceName": "Element Plus",
      "sourceType": "tech",
      "relation": "包含",
      "targetName": "El-form",
      "targetType": "tech"
    },
    {
      "sourceName": "Element Plus",
      "sourceType": "tech",
      "relation": "包含",
      "targetName": "El-row",
      "targetType": "tech"
    }
  ],
  "kgNodes": [
    {
      "label": "entity",
      "name": "Element Plus",
      "type": "tech",
      "description": null,
      "mentionCount": 4,
      "relatedCount": 9
    }
  ],
  "kgRelEdges": [
    {
      "rel": "RELATED_TO",
      "sourceName": "Vue",
      "sourceType": "tech",
      "relation": "使用",
      "targetName": "Element Plus",
      "targetType": "tech"
    },
    {
      "rel": "RELATED_TO",
      "sourceName": "el-form",
      "sourceType": "tech",
      "relation": "使用",
      "targetName": "Element Plus",
      "targetType": "tech"
    },
    {
      "rel": "RELATED_TO",
      "sourceName": "Element Plus",
      "sourceType": "tech",
      "relation": "包含",
      "targetName": "El-header",
      "targetType": "tech"
    },
    {
      "rel": "RELATED_TO",
      "sourceName": "Element Plus",
      "sourceType": "tech",
      "relation": "包含",
      "targetName": "El-col",
      "targetType": "tech"
    },
    {
      "rel": "RELATED_TO",
      "sourceName": "Element Plus",
      "sourceType": "tech",
      "relation": "包含",
      "targetName": "El-row",
      "targetType": "tech"
    },
    {
      "rel": "RELATED_TO",
      "sourceName": "Element Plus",
      "sourceType": "tech",
      "relation": "包含",
      "targetName": "El-form",
      "targetType": "tech"
    },
    {
      "rel": "RELATED_TO",
      "sourceName": "Element Plus",
      "sourceType": "tech",
      "relation": "包含",
      "targetName": "El-menu",
      "targetType": "tech"
    },
    {
      "rel": "RELATED_TO",
      "sourceName": "Element Plus",
      "sourceType": "tech",
      "relation": "包含",
      "targetName": "Input",
      "targetType": "tech"
    },
    {
      "rel": "RELATED_TO",
      "sourceName": "Element Plus",
      "sourceType": "tech",
      "relation": "包含",
      "targetName": "Select",
      "targetType": "tech"
    }
  ]
}
```

</details>

### 「王工」——图谱应能答但实际答不出：制度类实体：「王工—负责→技术评估」这条关系**没有**被抽出

- 文档侧 `/rag/search` Top5 命中文档：项目立项与审批流程 / 吴金远_前端开发_简历_2026 / 考勤与加班餐补制度 / 实习总结
- 图谱侧 `/kg/search` 命中实体：王工(person)
- 图谱侧 `/kg/search` 命中关系：（空）
- 图谱侧 `/kg/edges?entity=王工` 关联边：0 条

<details><summary>原始返回（截断）</summary>

```json
{
  "ragItems": [
    {
      "doc_title": "项目立项与审批流程",
      "chunk_index": 0,
      "score": 0.031544957774465976
    },
    {
      "doc_title": "吴金远_前端开发_简历_2026",
      "chunk_index": 10,
      "score": 0.01639344262295082
    },
    {
      "doc_title": "吴金远_前端开发_简历_2026",
      "chunk_index": 0,
      "score": 0.016129032258064516
    },
    {
      "doc_title": "考勤与加班餐补制度",
      "chunk_index": 0,
      "score": 0.015873015873015872
    },
    {
      "doc_title": "实习总结",
      "chunk_index": 13,
      "score": 0.015625
    }
  ],
  "kgEntities": [
    {
      "name": "王工",
      "type": "person",
      "description": null
    }
  ],
  "kgEdges": [],
  "kgNodes": [
    {
      "label": "entity",
      "name": "王工",
      "type": "person",
      "description": null,
      "mentionCount": 1,
      "relatedCount": 0
    }
  ],
  "kgRelEdges": []
}
```

</details>

### 「技术评估」——图谱应能答但实际答不出：制度类环节：连实体都没抽出来

- 文档侧 `/rag/search` Top5 命中文档：项目立项与审批流程 / 实习总结 / 研发中心新员工入职指南
- 图谱侧 `/kg/search` 命中实体：（空）
- 图谱侧 `/kg/search` 命中关系：（空）
- 图谱侧 `/kg/edges?entity=技术评估` 关联边：0 条

<details><summary>原始返回（截断）</summary>

```json
{
  "ragItems": [
    {
      "doc_title": "项目立项与审批流程",
      "chunk_index": 0,
      "score": 0.03278688524590164
    },
    {
      "doc_title": "实习总结",
      "chunk_index": 14,
      "score": 0.03200204813108039
    },
    {
      "doc_title": "实习总结",
      "chunk_index": 16,
      "score": 0.03200204813108039
    },
    {
      "doc_title": "研发中心新员工入职指南",
      "chunk_index": 0,
      "score": 0.031009615384615385
    },
    {
      "doc_title": "实习总结",
      "chunk_index": 3,
      "score": 0.02964426877470356
    }
  ],
  "kgEntities": [],
  "kgEdges": [],
  "kgNodes": [],
  "kgRelEdges": []
}
```

</details>

### 「PMO」——图谱应能答但实际答不出：制度类组织：只有实体、没有关系

- 文档侧 `/rag/search` Top5 命中文档：项目立项与审批流程 / 吴金远_前端开发_简历_2026 / 实习总结 / 数据安全与权限管理规范
- 图谱侧 `/kg/search` 命中实体：PMO(org)
- 图谱侧 `/kg/search` 命中关系：（空）
- 图谱侧 `/kg/edges?entity=PMO` 关联边：0 条

<details><summary>原始返回（截断）</summary>

```json
{
  "ragItems": [
    {
      "doc_title": "项目立项与审批流程",
      "chunk_index": 0,
      "score": 0.03278688524590164
    },
    {
      "doc_title": "吴金远_前端开发_简历_2026",
      "chunk_index": 5,
      "score": 0.016129032258064516
    },
    {
      "doc_title": "吴金远_前端开发_简历_2026",
      "chunk_index": 9,
      "score": 0.015873015873015872
    },
    {
      "doc_title": "实习总结",
      "chunk_index": 12,
      "score": 0.015625
    },
    {
      "doc_title": "数据安全与权限管理规范",
      "chunk_index": 0,
      "score": 0.015384615384615385
    }
  ],
  "kgEntities": [
    {
      "name": "PMO",
      "type": "org",
      "description": null
    }
  ],
  "kgEdges": [],
  "kgNodes": [
    {
      "label": "entity",
      "name": "PMO",
      "type": "org",
      "description": null,
      "mentionCount": 1,
      "relatedCount": 0
    }
  ],
  "kgRelEdges": []
}
```

</details>

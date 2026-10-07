# 浏览器走查 · Markdown 结构覆盖

本文件用于验证解析完成后的 markdown 渲染。

## 表格

| 字段 | 值 |
| --- | --- |
| 来源 | 浏览器走查 |
| 解析引擎 | MinerU flash |

## 列表

1. 有序第一项
2. 有序第二项
   - 嵌套无序项

> 引用块：这段应当出现在渲染后的正文里。

```ts
const docId = 'walkthrough-clean'
console.log('解析完成', docId)
```

## 行内标记

**加粗**、*斜体*、`行内代码`、[链接](https://example.com)。

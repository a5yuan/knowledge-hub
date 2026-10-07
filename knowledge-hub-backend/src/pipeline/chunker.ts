import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';

/** 分块结果：index 为块序号（从 0 开始） */
export interface Chunk {
  index: number;
  content: string;
}

/**
 * Markdown 分块（对应架构图"分块(文档切分)"）
 * 直接使用 LangChain RecursiveCharacterTextSplitter 的 markdown 模式：
 * 按标题、段落等 markdown 分隔符递归切分，并拼接至目标块大小，块间保留重叠。
 */
export async function chunkMarkdown(md: string, maxChars: number): Promise<Chunk[]> {
  const splitter = RecursiveCharacterTextSplitter.fromLanguage('markdown', {
    chunkSize: maxChars,
    chunkOverlap: Math.floor(maxChars * 0.1),
  });
  const texts = await splitter.splitText(md);
  return texts.map((content, index) => ({ index, content }));
}

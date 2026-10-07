import { Injectable, Logger } from '@nestjs/common';
import { MineruService } from '../mineru/mineru.service';

/** 允许上传并解析的扩展名 */
export const ALLOWED_EXTENSIONS = ['pdf', 'docx', 'pptx', 'xlsx', 'txt', 'md'] as const;

export interface DispatchResult {
  markdown: string;
  /** 'direct' = txt/md 直读；其余为 MinerU 通道名 */
  provider: string;
}

/**
 * 文件解析分发器（对应流程图 FileService）
 * txt/md 直读；pdf/docx/pptx/xlsx 交给 MinerU 库解析出 Markdown
 */
@Injectable()
export class FileService {
  private readonly logger = new Logger(FileService.name);

  constructor(private readonly mineru: MineruService) {}

  async dispatch(buffer: Buffer, filename: string, docId?: string): Promise<DispatchResult> {
    const ext = filename.split('.').pop()?.toLowerCase() ?? '';

    // txt/md 无需解析，直接按 UTF-8 读取
    if (ext === 'txt' || ext === 'md') {
      this.logger.log(`文本文件直读 docId=${docId ?? '-'} ${filename} (${buffer.length} bytes)`);
      return { markdown: buffer.toString('utf8'), provider: 'direct' };
    }

    // pdf / docx / pptx / xlsx -> MinerU
    const result = await this.mineru.parse(buffer, filename, { docId });
    return { markdown: result.markdown, provider: result.provider };
  }
}

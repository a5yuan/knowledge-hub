import { PartialType } from '@nestjs/mapped-types';
import { IsOptional, IsString } from 'class-validator';
import { CreateDocumentDto } from './create-document.dto';

/**
 * 更新文档请求体：所有字段可选，仅更新传入的字段
 */
export class UpdateDocumentDto extends PartialType(CreateDocumentDto) {
  /** 更新人ID（雪花ID），仅更新时使用 */
  @IsOptional()
  @IsString()
  update_by?: string;
}

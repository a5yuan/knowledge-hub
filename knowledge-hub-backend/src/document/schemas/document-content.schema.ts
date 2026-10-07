import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { normalizeSnowflakeId } from '../../common/utils/snowflake-id.util';

export type DocumentContentDocument = HydratedDocument<DocumentContent>;

export const DocumentContentFormat = ['markdown', 'html'] as const;

/**
 * document_content 集合映射（见 init-scripts/mongodb/init.js）
 * 文档正文集合：_id(ObjectId) 的字符串值存于 kh_document.content_id
 */
@Schema({
  collection: 'document_content',
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
})

export class DocumentContent {
  /** 正文ID（ObjectId，自动生成；字符串值对应 kh_document.content_id） */
  _id: Types.ObjectId;

  /**
   * 关联的文档ID（对应 kh_document.id，雪花ID，唯一索引）
   * 以 String 存储保证精度，写库前经 normalizeSnowflakeId 归一化
   */
  @Prop({ type: String, required: true, unique: true, index: true })
  documentId: string;

  /** 正文内容（Markdown/HTML 原文） */
  @Prop({ type: String, default: '' })
  content: string;

  /** 正文格式：markdown | html */
  @Prop({ type: String, enum: DocumentContentFormat, default: 'markdown' })
  format: string;

  /** 文档版本号（编辑后递增） */
  @Prop({ type: Number, default: 1 })
  version: number;

  /** 正文内图片 URL 列表 */
  @Prop({ type: [String], default: [] })
  images: string[];

  /** 逻辑删除标记，索引与 init.js 一致 */
  @Prop({ type: Boolean, default: false, index: true })
  deleted: boolean;

  /** 解析状态：pending / running / success / failed */
  @Prop({ type: String, default: 'pending' })
  parse_state: string;

  /** 解析失败原因 */
  @Prop({ type: String })
  parse_error: string;

  /** 原始文件名（RustFS 留存的原文件） */
  @Prop({ type: String })
  source_file_name: string;

  /** 原始文件在 RustFS 中的对象 key */
  @Prop({ type: String })
  source_file_key: string;

  /** 创建时间（timestamps 自动维护） */
  created_at: Date;

  /** 更新时间（timestamps 自动维护） */
  updated_at: Date;
}

export const DocumentContentSchema = SchemaFactory.createForClass(DocumentContent);

// 保存前将 documentId 归一化为精度安全的字符串雪花ID
DocumentContentSchema.pre<DocumentContentDocument>('save', async function () {
  this.documentId = normalizeSnowflakeId(this.documentId, 'documentId');
});

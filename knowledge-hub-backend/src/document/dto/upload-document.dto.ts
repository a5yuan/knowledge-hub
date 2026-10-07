import { IsOptional, IsString, Matches } from 'class-validator';

/**
 * 上传文件的可选表单字段（multipart 其余字段）
 * 雪花ID必须为纯数字字符串，避免精度丢失
 */
export class UploadDocumentDto {
    /** 作者ID（雪花ID，写入 kh_document.author_id） */
    @IsOptional()
    @IsString()
    @Matches(/^\d+$/, { message: 'authorId 必须为纯数字雪花ID字符串' })
    authorId?: string;

    /** 创建人ID（雪花ID，写入 kh_document.create_by） */
    @IsOptional()
    @IsString()
    @Matches(/^\d+$/, { message: 'createBy 必须为纯数字雪花ID字符串' })
    createBy?: string;
}

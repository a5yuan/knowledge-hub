import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  CreateBucketCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

/**
 * RustFS 对象存储服务（S3 兼容 API）
 * 原始文件留存：MinerU 结果有保留期，原文件必须自己存对象存储
 */
@Injectable()
export class RustfsService implements OnModuleInit {
  private readonly logger = new Logger(RustfsService.name);

  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly endpoint: string;

  constructor(config: ConfigService) {
    this.endpoint = (config.get<string>('RUSTFS_ENDPOINT') ?? 'http://localhost:9000').replace(/\/+$/, '');
    this.bucket = config.get<string>('RUSTFS_BUCKET') ?? 'knowledge-hub';
    this.client = new S3Client({
      endpoint: this.endpoint,
      region: 'us-east-1',
      credentials: {
        accessKeyId: config.get<string>('RUSTFS_ACCESS_KEY') ?? 'rustfsadmin',
        secretAccessKey: config.get<string>('RUSTFS_SECRET_KEY') ?? 'rustfsadmin',
      },
      // RustFS 使用 path-style 而非 virtual-host style
      forcePathStyle: true,
    });
  }

  /** 启动时确保 bucket 存在（不存在则创建） */
  async onModuleInit(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch {
      await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
      this.logger.log(`已创建 bucket: ${this.bucket}`);
    }
    this.logger.log(`RustFS 就绪: ${this.endpoint}/${this.bucket}`);
  }

  /** 上传对象，返回对象 key */
  async upload(key: string, body: Buffer, contentType: string): Promise<string> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
    return key;
  }

  /** 由对象 key 拼出访问 URL（path-style） */
  publicUrl(key: string): string {
    return `${this.endpoint}/${this.bucket}/${encodeURI(key)}`;
  }
}

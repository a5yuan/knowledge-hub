import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MailerService } from '@nestjs-modules/mailer';

/**
 * 邮件服务：激活邮件 / 密码重置验证码邮件（SMTP 参数见 .env MAIL_*）
 * 开发兜底：MAIL_USER 未配置（空或占位 xx@xx.com）时不走 SMTP，
 * 改为日志输出激活链接/验证码，保证注册/重置链路可本地跑通；配置真实授权码后自动切换为真发。
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  /** SMTP 是否已配置（非空且非占位值） */
  private readonly smtpEnabled: boolean;

  constructor(
    private readonly mailer: MailerService,
    private readonly config: ConfigService,
  ) {
    const user = this.config.get<string>('MAIL_USER', '').trim();
    this.smtpEnabled = user !== '' && user !== 'xx@xx.com';
  }

  /** 激活邮件：含 {APP_PUBLIC_URL}/auth/verify-email?token=xxx 链接，24h 有效 */
  async sendActivationMail(to: string, token: string): Promise<void> {
    const base = this.config.get('APP_PUBLIC_URL', 'http://localhost:3000').replace(/\/+$/, '');
    const link = `${base}/auth/verify-email?token=${token}`;
    if (!this.smtpEnabled) {
      this.logger.warn(`[DEV 兜底] SMTP 未配置，激活链接请从日志获取 to=${to} link=${link}`);
      return;
    }
    await this.mailer.sendMail({
      to,
      subject: 'Knowledge Hub 邮箱激活',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto;">
          <h2 style="color: #1f2937;">激活您的邮箱</h2>
          <p>您好，请点击下方按钮激活您的邮箱：</p>
          <p style="text-align: center; margin: 28px 0;">
            <a href="${link}" style="background: #4f46e5; color: #fff; padding: 12px 32px; border-radius: 6px; text-decoration: none;">激活邮箱</a>
          </p>
          <p style="font-size: 13px; color: #6b7280;">如按钮无法点击，请复制以下链接到浏览器打开：</p>
          <p style="font-size: 13px; word-break: break-all;"><a href="${link}">${link}</a></p>
          <p style="font-size: 13px; color: #6b7280;">此链接 24 小时内有效。若非本人操作，请忽略本邮件。</p>
        </div>`,
    });
    this.logger.log(`激活邮件已发送 to=${to}`);
  }

  /** 密码重置验证码邮件：6 位数字，10 分钟有效 */
  async sendResetCodeMail(to: string, code: string): Promise<void> {
    if (!this.smtpEnabled) {
      this.logger.warn(`[DEV 兜底] SMTP 未配置，密码重置验证码请从日志获取 to=${to} code=${code}`);
      return;
    }
    await this.mailer.sendMail({
      to,
      subject: 'Knowledge Hub 密码重置验证码',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto;">
          <h2 style="color: #1f2937;">密码重置验证码</h2>
          <p>您好，您正在重置账户密码，验证码为：</p>
          <p style="font-size: 32px; font-weight: bold; letter-spacing: 8px; text-align: center; margin: 24px 0;">${code}</p>
          <p style="font-size: 13px; color: #6b7280;">验证码 10 分钟内有效，且仅可使用一次。若非本人操作，请忽略本邮件。</p>
        </div>`,
    });
    this.logger.log(`密码重置验证码邮件已发送 to=${to}`);
  }
}

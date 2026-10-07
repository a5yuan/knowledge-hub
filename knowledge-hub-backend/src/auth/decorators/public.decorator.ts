import { SetMetadata } from '@nestjs/common';

/** @Public 装饰器元数据 key */
export const IS_PUBLIC_KEY = 'isPublic';

/**
 * 标记接口为公开接口，跳过全局 JwtAuthGuard 鉴权
 * 仅用于：注册 / 登录 / 刷新 token / 健康检查
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

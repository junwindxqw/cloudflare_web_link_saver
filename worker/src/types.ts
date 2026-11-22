export type Env = {
  DB: D1Database;
  KV: KVNamespace;
  // 转存图片的对象存储；读取/写入均兼容 R2 缺失的场景（回退 KV）
  MEDIA?: R2Bucket;
  JWT_SECRET: string;
  RESEND_API_KEY: string;
  WEB_ORIGIN: string;
  MAIL_FROM: string;
  // 允许跨域访问 API 的扩展来源（wrangler.jsonc vars 配置）
  EXTENSION_ORIGIN: string;
  // 仅本地开发放开 localhost 来源（.dev.vars 里设 ALLOW_LOCAL_ORIGIN=true），生产不设
  ALLOW_LOCAL_ORIGIN?: string;
};

export type UserPayload = {
  sub: string;
  email: string;
  iat: number;
  exp: number;
};

export const ARTICLE_CATEGORY = 'articles';
export const TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30;

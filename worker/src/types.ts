export type Env = {
  DB: D1Database;
  KV: KVNamespace;
  JWT_SECRET: string;
  RESEND_API_KEY: string;
  WEB_ORIGIN: string;
  MAIL_FROM: string;
};

export type UserPayload = {
  sub: string;
  email: string;
  iat: number;
  exp: number;
};

export const ARTICLE_CATEGORY = 'articles';
export const TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30;

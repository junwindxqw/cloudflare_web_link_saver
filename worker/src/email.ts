import type { Env } from './types';

export type CodePurpose = 'login' | 'register' | 'reset';

const PURPOSE_TEXT: Record<CodePurpose, string> = {
  login: '登录',
  register: '注册',
  reset: '密码重置',
};

function emailTemplate(purpose: CodePurpose, code: string): string {
  const title = `Link Saver ${PURPOSE_TEXT[purpose]}验证码`;
  return `<div style="background:#f5f7fa;padding:32px 16px;font-family:-apple-system,'Segoe UI',Roboto,'PingFang SC','Microsoft YaHei',sans-serif;">
  <div style="max-width:480px;margin:0 auto;background:#fff;border-radius:12px;padding:32px;">
    <h1 style="font-size:20px;color:#111827;margin:0 0 8px;">${title}</h1>
    <p style="color:#6b7280;font-size:14px;margin:0 0 24px;">你正在进行${PURPOSE_TEXT[purpose]}操作，请使用以下验证码：</p>
    <div style="font-size:32px;font-weight:700;letter-spacing:8px;color:#2563eb;background:#eff6ff;border-radius:8px;padding:16px;text-align:center;">${code}</div>
    <p style="color:#9ca3af;font-size:12px;margin:24px 0 0;">验证码 10 分钟内有效。如果这不是你的操作，请忽略本邮件。</p>
  </div>
</div>`;
}

export async function sendCodeEmail(env: Env, to: string, code: string, purpose: CodePurpose): Promise<void> {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: env.MAIL_FROM,
      to: [to],
      subject: `Link Saver ${PURPOSE_TEXT[purpose]}验证码：${code}`,
      html: emailTemplate(purpose, code),
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`邮件发送失败(${res.status}) ${detail.slice(0, 200)}`);
  }
}

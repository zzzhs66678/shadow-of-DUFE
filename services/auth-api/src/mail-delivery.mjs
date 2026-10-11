import nodemailer from "nodemailer";
import { validEmail } from "./credentials.mjs";

function assertDeliveryInput({ to, token, expiresAt }) {
  if (
    typeof to !== "string" ||
    !validEmail(to) ||
    /[\r\n]/u.test(to) ||
    typeof token !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/u.test(token) ||
    !(expiresAt instanceof Date) ||
    !Number.isFinite(expiresAt.getTime())
  ) {
    throw new Error("mail delivery input is invalid");
  }
}

function expiryText(expiresAt) {
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Shanghai",
  }).format(expiresAt);
}

export function createMailDelivery(
  config,
  createTransport = nodemailer.createTransport,
) {
  if (!config.smtp) return null;
  const transport = createTransport({
    pool: true,
    maxConnections: 2,
    maxMessages: 1,
    maxRequeues: 0,
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    requireTLS: !config.smtp.secure,
    auth: { user: config.smtp.user, pass: config.smtp.password },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
    disableFileAccess: true,
    disableUrlAccess: true,
    logger: false,
    debug: false,
    tls: { minVersion: "TLSv1.2", rejectUnauthorized: true },
  });
  const from = { name: "东财之影", address: config.smtp.from };
  let active = 0;
  async function deliver(message, expiresAt) {
    if (active >= 2 || expiresAt.getTime() <= Date.now()) throw new Error("mail delivery unavailable");
    active += 1;
    let timer;
    try {
      await Promise.race([transport.sendMail(message), new Promise((_, reject) => {
        timer = setTimeout(() => {
          transport.close?.();
          reject(new Error("mail delivery timeout"));
        }, 30_000);
      })]);
    } finally { clearTimeout(timer); active -= 1; }
  }

  async function send({ to, token, expiresAt, subject, purpose }) {
    assertDeliveryInput({ to, token, expiresAt });
    await deliver({
      from,
      to,
      subject,
      text: [
        `你正在为东财之影${purpose}。`,
        "",
        `一次性令牌：${token}`,
        `有效期至：${expiryText(expiresAt)}`,
        "",
        "如果这不是你的操作，请忽略本邮件。不要把令牌转发给任何人。",
      ].join("\n"),
    }, expiresAt);
  }

  return {
    async sendRegistrationCode({ to, code, expiresAt }) {
      if (!validEmail(to) || !/^\d{6}$/u.test(code) || !(expiresAt instanceof Date)) {
        throw new Error("mail delivery input is invalid");
      }
      await deliver({ from, to, subject: "东财之影注册验证码",
        text: `你正在注册东财之影。\n\n验证码：${code}\n有效期至：${expiryText(expiresAt)}\n\n请在申请验证码的浏览器完成注册。如果不是你的操作，请忽略本邮件。不要转发验证码。`,
      }, expiresAt);
    },
    async sendPasswordReset(input) {
      await send({
        ...input,
        subject: "东财之影密码重置",
        purpose: "重置密码",
      });
    },
    async sendEmailVerification(input) {
      await send({
        ...input,
        subject: "东财之影邮箱验证",
        purpose: "验证邮箱",
      });
    },
    close() {
      transport.close?.();
    },
  };
}

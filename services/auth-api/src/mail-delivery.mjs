import nodemailer from "nodemailer";

function assertDeliveryInput({ to, token, expiresAt }) {
  if (
    typeof to !== "string" ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(to) ||
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
    tls: { minVersion: "TLSv1.2", rejectUnauthorized: true },
  });
  const from = { name: "东财之影", address: config.smtp.from };

  async function send({ to, token, expiresAt, subject, purpose }) {
    assertDeliveryInput({ to, token, expiresAt });
    await transport.sendMail({
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
    });
  }

  return {
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

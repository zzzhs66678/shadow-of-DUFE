import assert from "node:assert/strict";
import test from "node:test";
import { createMailDelivery } from "../src/mail-delivery.mjs";

const config = {
  smtp: {
    host: "smtp.example.com",
    port: 587,
    secure: false,
    user: "mailer",
    password: "smtp-secret",
    from: "no-reply@dufesh.cn",
  },
};

test("SMTP delivery requires TLS and disables file and URL content access", async () => {
  let transportOptions;
  const messages = [];
  let closed = false;
  const delivery = createMailDelivery(config, (options) => {
    transportOptions = options;
    return {
      async sendMail(message) {
        messages.push(message);
      },
      close() {
        closed = true;
      },
    };
  });

  assert.equal(transportOptions.secure, false);
  assert.equal(transportOptions.requireTLS, true);
  assert.equal(transportOptions.disableFileAccess, true);
  assert.equal(transportOptions.disableUrlAccess, true);
  assert.deepEqual(transportOptions.tls, {
    minVersion: "TLSv1.2",
    rejectUnauthorized: true,
  });

  const token = "A".repeat(43);
  await delivery.sendPasswordReset({
    to: "student@example.com",
    token,
    expiresAt: new Date("2026-08-11T12:00:00Z"),
  });
  await delivery.sendEmailVerification({
    to: "student@example.com",
    token,
    expiresAt: new Date("2026-08-12T12:00:00Z"),
  });

  assert.equal(messages.length, 2);
  assert.deepEqual(messages.map(({ subject }) => subject), [
    "东财之影密码重置",
    "东财之影邮箱验证",
  ]);
  for (const message of messages) {
    assert.deepEqual(message.from, {
      name: "东财之影",
      address: "no-reply@dufesh.cn",
    });
    assert.equal(message.to, "student@example.com");
    assert.match(message.text, new RegExp(token));
    assert.equal(Object.hasOwn(message, "html"), false);
    assert.equal(Object.hasOwn(message, "attachments"), false);
  }

  delivery.close();
  assert.equal(closed, true);
});

test("SMTP delivery rejects header injection and malformed tokens", async () => {
  const delivery = createMailDelivery(config, () => ({
    async sendMail() {
      throw new Error("should not send");
    },
  }));
  const expiresAt = new Date("2026-08-11T12:00:00Z");

  await assert.rejects(
    delivery.sendPasswordReset({
      to: "student@example.com\r\nBcc: attacker@example.com",
      token: "A".repeat(43),
      expiresAt,
    }),
    /mail delivery input is invalid/u,
  );
  await assert.rejects(
    delivery.sendEmailVerification({
      to: "student@example.com",
      token: "not-a-token",
      expiresAt,
    }),
    /mail delivery input is invalid/u,
  );
});

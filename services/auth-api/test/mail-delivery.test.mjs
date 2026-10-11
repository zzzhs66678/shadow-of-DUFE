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
    expiresAt: new Date(Date.now()+300000),
  });
  await delivery.sendEmailVerification({
    to: "student@example.com",
    token,
    expiresAt: new Date(Date.now()+300000),
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
  const expiresAt = new Date(Date.now()+300000);

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

test("registration SMTP uses a fixed template, two concurrent sends and zero requeues", async () => {
  const messages = []; const releases = []; let options;
  const delivery = createMailDelivery(config, (transportOptions) => {
    options = transportOptions;
    return { sendMail(message) {
      messages.push(message); return new Promise((resolve) => releases.push(resolve));
    } };
  });
  const input = { to: "student@example.com", code: "246810", expiresAt: new Date(Date.now() + 300000),
    from: "attacker@example.com", subject: "arbitrary", attachments: [{ path: "secret" }], html: "<script>evil()</script>" };
  const one = delivery.sendRegistrationCode(input); const two = delivery.sendRegistrationCode(input);
  await assert.rejects(delivery.sendRegistrationCode(input), /unavailable/u);
  assert.equal(options.maxConnections, 2); assert.equal(options.maxRequeues, 0);
  assert.equal(options.logger, false); assert.equal(options.debug, false);
  for (const message of messages) {
    assert.equal(message.from.address, config.smtp.from);
    assert.equal(message.subject, "东财之影注册验证码");
    assert.equal(message.html, undefined); assert.equal(message.attachments, undefined);
  }
  releases.forEach((resolve) => resolve()); await Promise.all([one, two]);
  await assert.rejects(delivery.sendRegistrationCode({ ...input, expiresAt: new Date(Date.now() - 1) }), /unavailable/u);
});

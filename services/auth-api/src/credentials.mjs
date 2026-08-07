const COMMON_PASSWORDS = new Set([
  "1234567890",
  "123456789",
  "1111111111",
  "password",
  "password123",
  "qwerty12345",
  "admin123456",
  "iloveyou123",
]);

function stringValue(value) {
  return typeof value === "string" ? value : "";
}

export function normalizeUsername(value) {
  return stringValue(value).normalize("NFKC").trim().toLocaleLowerCase("en-US");
}

export function normalizeEmail(value) {
  return stringValue(value).normalize("NFKC").trim().toLocaleLowerCase("en-US");
}

export function normalizeLoginIdentifier(value) {
  const normalized = stringValue(value).normalize("NFKC").trim();
  return normalized.includes("@")
    ? normalizeEmail(normalized)
    : normalizeUsername(normalized);
}

export function validateRegistration(input) {
  const username = stringValue(input?.username).normalize("NFKC").trim();
  const normalizedUsername = normalizeUsername(username);
  const email = normalizeEmail(input?.email);
  const password = stringValue(input?.password);
  const schoolAccount = stringValue(input?.schoolAccount)
    .normalize("NFKC")
    .trim();
  const fields = {};

  const usernameLength = Array.from(username).length;
  if (
    usernameLength < 3 ||
    usernameLength > 24 ||
    !/^[\p{L}\p{N}_-]+$/u.test(username)
  ) {
    fields.username = "用户名需为 3—24 个汉字、字母、数字、下划线或短横线";
  }

  if (
    email.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)
  ) {
    fields.email = "请输入有效邮箱";
  }

  const normalizedPassword = password.normalize("NFKC");
  if (password.length < 10 || password.length > 128) {
    fields.password = "密码需为 10—128 个字符";
  } else if (
    COMMON_PASSWORDS.has(normalizedPassword.toLocaleLowerCase("en-US")) ||
    normalizedPassword.toLocaleLowerCase("en-US").includes(normalizedUsername) ||
    normalizedPassword.toLocaleLowerCase("en-US").includes(email.split("@", 1)[0])
  ) {
    fields.password = "请使用不包含用户名、邮箱或常见口令的密码";
  } else if (
    !/[\p{L}]/u.test(password) ||
    !/[\p{N}\p{P}\p{S}]/u.test(password)
  ) {
    fields.password = "密码需同时包含文字与数字或符号";
  }

  if (
    schoolAccount &&
    (schoolAccount.length < 4 ||
      schoolAccount.length > 32 ||
      !/^[\p{L}\p{N}_-]+$/u.test(schoolAccount))
  ) {
    fields.schoolAccount = "校园账号需为 4—32 个字母、数字、下划线或短横线";
  }

  if (Object.keys(fields).length > 0) {
    return { ok: false, fields };
  }

  return {
    ok: true,
    value: {
      username,
      normalizedUsername,
      email,
      normalizedEmail: email,
      password,
      schoolAccount: schoolAccount || null,
    },
  };
}

export function validateLogin(input) {
  const identifier = normalizeLoginIdentifier(input?.identifier);
  const password = stringValue(input?.password);
  if (!identifier || identifier.length > 254 || !password || password.length > 128) {
    return null;
  }
  return { identifier, password };
}

export function validateNewPassword(password, identityHints = []) {
  const value = stringValue(password);
  if (value.length < 10 || value.length > 128) return false;
  const lower = value.normalize("NFKC").toLocaleLowerCase("en-US");
  if (COMMON_PASSWORDS.has(lower)) return false;
  if (!/[\p{L}]/u.test(value) || !/[\p{N}\p{P}\p{S}]/u.test(value)) {
    return false;
  }
  return !identityHints
    .map((hint) => normalizeLoginIdentifier(hint))
    .filter((hint) => hint.length >= 3)
    .some((hint) => lower.includes(hint.split("@", 1)[0]));
}

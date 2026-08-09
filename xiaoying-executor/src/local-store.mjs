import {
  createHash,
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { contentHash } from "./security.mjs";
import { decryptSecret, encryptSecret } from "./secret-vault.mjs";

const DAY_MS = 86_400_000;
const READ_LEASE_MS = 2 * 60_000;
const WRITE_LEASE_MS = 3 * 60_000;

function nowIso(clock) {
  return new Date(clock()).toISOString();
}

function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

function hashInviteCode(code, salt = randomBytes(16)) {
  const normalized = typeof code === "string" ? code.trim() : "";
  if (!normalized) throw new Error("邀请码不能为空");
  const digest = scryptSync(normalized, salt, 32);
  return `${salt.toString("base64")}:${digest.toString("base64")}`;
}

function verifyInviteCode(code, encoded) {
  const [saltText, digestText] = String(encoded).split(":");
  if (!saltText || !digestText) return false;
  const actual = scryptSync(String(code).trim(), Buffer.from(saltText, "base64"), 32);
  const expected = Buffer.from(digestText, "base64");
  return expected.length === actual.length && timingSafeEqual(actual, expected);
}

function cleanDisplayName(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return (normalized || "本地体验用户").slice(0, 32);
}

export class XiaoyingLocalStore {
  constructor({
    databasePath,
    masterKey,
    defaultInviteCode = "fjbadguy",
    clock = () => Date.now(),
  }) {
    if (databasePath !== ":memory:") mkdirSync(dirname(databasePath), { recursive: true });
    this.db = new DatabaseSync(databasePath);
    this.masterKey = masterKey;
    this.clock = clock;
    this.db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
    this.#migrate();
    this.#seedDefaultInvite(defaultInviteCode);
  }

  close() {
    this.db.close();
  }

  unlockVip({ inviteCode, displayName }) {
    const candidates = this.db
      .prepare("SELECT id, code_hash, max_uses, use_count FROM invite_codes WHERE enabled = 1")
      .all();
    const invite = candidates.find((candidate) =>
      verifyInviteCode(inviteCode, candidate.code_hash),
    );
    if (!invite || (invite.max_uses !== null && invite.use_count >= invite.max_uses)) {
      throw new Error("邀请码无效或已达到使用上限");
    }

    const userId = randomUUID();
    const sessionToken = randomBytes(32).toString("base64url");
    const sessionId = randomUUID();
    const createdAt = nowIso(this.clock);
    const expiresAt = new Date(this.clock() + 30 * DAY_MS).toISOString();

    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare("INSERT INTO users (id, display_name, created_at) VALUES (?, ?, ?)")
        .run(userId, cleanDisplayName(displayName), createdAt);
      this.db
        .prepare(
          "INSERT INTO vip_entitlements (user_id, source, starts_at) VALUES (?, 'invite', ?)",
        )
        .run(userId, createdAt);
      this.db
        .prepare(
          "INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run(sessionId, userId, hashToken(sessionToken), createdAt, expiresAt);
      this.db
        .prepare("UPDATE invite_codes SET use_count = use_count + 1 WHERE id = ?")
        .run(invite.id);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }

    return {
      sessionToken,
      expiresAt,
      user: this.getUser(userId),
    };
  }

  authenticate(sessionToken) {
    const token = typeof sessionToken === "string" ? sessionToken.trim() : "";
    if (!token) return null;
    const row = this.db
      .prepare(
        `SELECT u.id, u.display_name, s.id AS session_id, s.expires_at
         FROM sessions s
         JOIN users u ON u.id = s.user_id
         JOIN vip_entitlements v ON v.user_id = u.id AND v.revoked_at IS NULL
         WHERE s.token_hash = ? AND s.revoked_at IS NULL`,
      )
      .get(hashToken(token));
    if (!row || Date.parse(row.expires_at) <= this.clock()) return null;
    return {
      id: row.id,
      displayName: row.display_name,
      vip: true,
      sessionId: row.session_id,
    };
  }

  revokeSession(sessionToken) {
    const token = typeof sessionToken === "string" ? sessionToken.trim() : "";
    if (!token) return;
    this.db
      .prepare("UPDATE sessions SET revoked_at = ? WHERE token_hash = ?")
      .run(nowIso(this.clock), hashToken(token));
  }

  deleteUser(userId) {
    const result = this.db.prepare("DELETE FROM users WHERE id = ?").run(userId);
    return result.changes > 0;
  }

  getUser(userId) {
    const row = this.db
      .prepare(
        `SELECT u.id, u.display_name,
           EXISTS(
             SELECT 1 FROM vip_entitlements v
             WHERE v.user_id = u.id AND v.revoked_at IS NULL
           ) AS vip
         FROM users u WHERE u.id = ?`,
      )
      .get(userId);
    return row
      ? { id: row.id, displayName: row.display_name, vip: Boolean(row.vip) }
      : null;
  }

  getModelKeySummary(userId) {
    const row = this.db
      .prepare(
        `SELECT provider, model, base_url, last4, updated_at
         FROM user_secrets
         WHERE user_id = ? AND secret_kind = 'model_api_key'`,
      )
      .get(userId);
    return row
      ? {
          connected: true,
          provider: row.provider,
          model: row.model,
          baseUrl: row.base_url,
          last4: row.last4,
          updatedAt: row.updated_at,
        }
      : { connected: false };
  }

  setModelKey(userId, { provider, apiKey, model, baseUrl }) {
    const providerValue =
      typeof provider === "string" && provider.trim() ? provider.trim().slice(0, 40) : "custom";
    const modelValue =
      typeof model === "string" && model.trim() ? model.trim().slice(0, 100) : null;
    const baseUrlValue =
      typeof baseUrl === "string" && baseUrl.trim() ? baseUrl.trim().slice(0, 400) : null;
    if (baseUrlValue) {
      const url = new URL(baseUrlValue);
      if (url.protocol !== "https:" && url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
        throw new Error("模型接口地址必须使用 HTTPS");
      }
    }

    const secretId = `${userId}:model_api_key`;
    const encrypted = encryptSecret(apiKey, this.masterKey, secretId);
    const updatedAt = nowIso(this.clock);
    this.db
      .prepare(
        `INSERT INTO user_secrets
          (id, user_id, secret_kind, provider, model, base_url, algorithm, ciphertext, iv, tag, last4, updated_at)
         VALUES (?, ?, 'model_api_key', ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, secret_kind) DO UPDATE SET
           provider = excluded.provider,
           model = excluded.model,
           base_url = excluded.base_url,
           algorithm = excluded.algorithm,
           ciphertext = excluded.ciphertext,
           iv = excluded.iv,
           tag = excluded.tag,
           last4 = excluded.last4,
           updated_at = excluded.updated_at`,
      )
      .run(
        secretId,
        userId,
        providerValue,
        modelValue,
        baseUrlValue,
        encrypted.algorithm,
        encrypted.ciphertext,
        encrypted.iv,
        encrypted.tag,
        encrypted.last4,
        updatedAt,
      );
    return this.getModelKeySummary(userId);
  }

  readModelKey(userId) {
    const row = this.db
      .prepare(
        `SELECT id, algorithm, ciphertext, iv, tag
         FROM user_secrets
         WHERE user_id = ? AND secret_kind = 'model_api_key'`,
      )
      .get(userId);
    if (!row) return null;
    return decryptSecret(row, this.masterKey, row.id);
  }

  deleteModelKey(userId) {
    this.db
      .prepare("DELETE FROM user_secrets WHERE user_id = ? AND secret_kind = 'model_api_key'")
      .run(userId);
  }

  setExternalCredential(userId, provider, credential, { expiresAt = null } = {}) {
    const providerValue = requiredProvider(provider);
    const secretKind = `external_session:${providerValue}`;
    const secretId = `${userId}:${secretKind}`;
    const encrypted = encryptSecret(credential, this.masterKey, secretId);
    const updatedAt = nowIso(this.clock);

    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          `INSERT INTO user_secrets
            (id, user_id, secret_kind, provider, model, base_url, algorithm, ciphertext, iv, tag, last4, updated_at)
           VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(user_id, secret_kind) DO UPDATE SET
             algorithm = excluded.algorithm,
             ciphertext = excluded.ciphertext,
             iv = excluded.iv,
             tag = excluded.tag,
             last4 = excluded.last4,
             updated_at = excluded.updated_at`,
        )
        .run(
          secretId,
          userId,
          secretKind,
          providerValue,
          encrypted.algorithm,
          encrypted.ciphertext,
          encrypted.iv,
          encrypted.tag,
          encrypted.last4,
          updatedAt,
        );
      this.db
        .prepare(
          `INSERT INTO external_connections
            (id, user_id, provider, status, credential_secret_id, credential_expires_at, last_success_at, last_error_code, updated_at)
           VALUES (?, ?, ?, 'connected', ?, ?, ?, NULL, ?)
           ON CONFLICT(user_id, provider) DO UPDATE SET
             status = 'connected',
             credential_secret_id = excluded.credential_secret_id,
             credential_expires_at = excluded.credential_expires_at,
             last_success_at = excluded.last_success_at,
             last_error_code = NULL,
             updated_at = excluded.updated_at`,
        )
        .run(
          `${userId}:${providerValue}`,
          userId,
          providerValue,
          secretId,
          expiresAt,
          updatedAt,
          updatedAt,
        );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.getExternalConnection(userId, providerValue);
  }

  readExternalCredential(userId, provider) {
    const providerValue = requiredProvider(provider);
    const row = this.db
      .prepare(
        `SELECT s.id, s.algorithm, s.ciphertext, s.iv, s.tag
         FROM external_connections c
         JOIN user_secrets s ON s.id = c.credential_secret_id
         WHERE c.user_id = ? AND c.provider = ? AND c.status = 'connected'`,
      )
      .get(userId, providerValue);
    if (!row) return null;
    return decryptSecret(row, this.masterKey, row.id);
  }

  getExternalConnection(userId, provider) {
    const providerValue = requiredProvider(provider);
    const row = this.db
      .prepare(
        `SELECT provider, status, credential_expires_at, last_success_at,
           last_error_code, updated_at
         FROM external_connections
         WHERE user_id = ? AND provider = ?`,
      )
      .get(userId, providerValue);
    return row
      ? {
          provider: row.provider,
          status: row.status,
          credentialExpiresAt: row.credential_expires_at,
          lastSuccessAt: row.last_success_at,
          lastErrorCode: row.last_error_code,
          updatedAt: row.updated_at,
        }
      : { provider: providerValue, status: "disconnected" };
  }

  markExternalConnection(userId, provider, { status, errorCode = null }) {
    const providerValue = requiredProvider(provider);
    const safeStatus = ["connected", "needs_reauthorization", "error"].includes(status)
      ? status
      : "error";
    const updatedAt = nowIso(this.clock);
    this.db
      .prepare(
        `UPDATE external_connections SET
           status = ?,
           last_error_code = ?,
           last_success_at = CASE WHEN ? = 'connected' THEN ? ELSE last_success_at END,
           updated_at = ?
         WHERE user_id = ? AND provider = ?`,
      )
      .run(
        safeStatus,
        errorCode,
        safeStatus,
        updatedAt,
        updatedAt,
        userId,
        providerValue,
      );
    return this.getExternalConnection(userId, providerValue);
  }

  disconnectExternal(userId, provider) {
    const providerValue = requiredProvider(provider);
    const secretKind = `external_session:${providerValue}`;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare("DELETE FROM external_connections WHERE user_id = ? AND provider = ?")
        .run(userId, providerValue);
      this.db
        .prepare("DELETE FROM user_secrets WHERE user_id = ? AND secret_kind = ?")
        .run(userId, secretKind);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  listFavoriteSeats(userId) {
    return this.db
      .prepare(
        `SELECT id, library_id AS libraryId, seat_key AS seatKey,
           seat_key AS seatId, label, created_at AS createdAt
         FROM favorite_seats WHERE user_id = ?
         ORDER BY created_at DESC`,
      )
      .all(userId);
  }

  saveFavoriteSeat(userId, { libraryId, seatKey, label }) {
    const library = String(libraryId ?? "").trim();
    const seat = typeof seatKey === "string" ? seatKey.trim() : "";
    const displayLabel = typeof label === "string" ? label.trim().slice(0, 80) : "";
    if (!library || !seat) throw new Error("收藏座位缺少场馆或座位");
    const createdAt = nowIso(this.clock);
    this.db
      .prepare(
        `INSERT INTO favorite_seats
          (id, user_id, library_id, seat_key, label, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, library_id, seat_key) DO UPDATE SET
           label = excluded.label`,
      )
      .run(
        `${userId}:${library}:${seat}`,
        userId,
        library,
        seat,
        displayLabel || seat,
        createdAt,
      );
    return this.listFavoriteSeats(userId);
  }

  deleteFavoriteSeat(userId, favoriteId) {
    this.db
      .prepare("DELETE FROM favorite_seats WHERE user_id = ? AND id = ?")
      .run(userId, String(favoriteId ?? ""));
    return this.listFavoriteSeats(userId);
  }

  getUserPreferences(userId) {
    const rows = this.db
      .prepare(
        `SELECT setting_key, setting_value
         FROM user_settings WHERE user_id = ?`,
      )
      .all(userId);
    const stored = Object.fromEntries(
      rows.map((row) => {
        try {
          return [row.setting_key, JSON.parse(row.setting_value)];
        } catch {
          return [row.setting_key, row.setting_value];
        }
      }),
    );
    return {
      defaultLibraryId: stored.defaultLibraryId ?? "",
      defaultSeatKey: stored.defaultSeatKey ?? "",
      defaultSeatLabel: stored.defaultSeatLabel ?? "",
      monitorIntervalMinutes: stored.monitorIntervalMinutes ?? 5,
      browserNotifications: stored.browserNotifications ?? true,
      sessionExpiryReminder: stored.sessionExpiryReminder ?? true,
      reservationReminder: stored.reservationReminder ?? true,
      quietHours: stored.quietHours ?? { start: "23:00", end: "07:00" },
    };
  }

  saveUserPreferences(userId, input) {
    const current = this.getUserPreferences(userId);
    const allowed = {
      defaultLibraryId: String(input.defaultLibraryId ?? current.defaultLibraryId).slice(0, 40),
      defaultSeatKey: String(input.defaultSeatKey ?? current.defaultSeatKey).slice(0, 80),
      defaultSeatLabel: String(input.defaultSeatLabel ?? current.defaultSeatLabel).slice(0, 80),
      monitorIntervalMinutes: Math.max(
        5,
        Math.min(60, Number(input.monitorIntervalMinutes ?? current.monitorIntervalMinutes) || 5),
      ),
      browserNotifications:
        input.browserNotifications === undefined
          ? current.browserNotifications
          : Boolean(input.browserNotifications),
      sessionExpiryReminder:
        input.sessionExpiryReminder === undefined
          ? current.sessionExpiryReminder
          : Boolean(input.sessionExpiryReminder),
      reservationReminder:
        input.reservationReminder === undefined
          ? current.reservationReminder
          : Boolean(input.reservationReminder),
      quietHours:
        input.quietHours && typeof input.quietHours === "object"
          ? {
              start: String(input.quietHours.start ?? "23:00").slice(0, 5),
              end: String(input.quietHours.end ?? "07:00").slice(0, 5),
            }
          : current.quietHours,
    };
    const updatedAt = nowIso(this.clock);
    const statement = this.db.prepare(
      `INSERT INTO user_settings
        (id, user_id, setting_key, setting_value, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id, setting_key) DO UPDATE SET
         setting_value = excluded.setting_value,
         updated_at = excluded.updated_at`,
    );
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const [key, value] of Object.entries(allowed)) {
        statement.run(`${userId}:${key}`, userId, key, JSON.stringify(value), updatedAt);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.getUserPreferences(userId);
  }

  createNotification(
    userId,
    { kind = "info", title, body = "", actionUrl = null, deduplicationKey = null },
  ) {
    const safeTitle = String(title ?? "").trim().slice(0, 120);
    if (!safeTitle) throw new Error("通知标题不能为空");
    const createdAt = nowIso(this.clock);
    const id = randomUUID();
    if (deduplicationKey) {
      const existing = this.db
        .prepare(
          `SELECT id FROM user_notifications
           WHERE user_id = ? AND deduplication_key = ?`,
        )
        .get(userId, String(deduplicationKey));
      if (existing) return existing.id;
    }
    this.db
      .prepare(
        `INSERT INTO user_notifications
          (id, user_id, kind, title, body, action_url, deduplication_key, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        userId,
        String(kind).slice(0, 30),
        safeTitle,
        String(body ?? "").trim().slice(0, 400),
        actionUrl ? String(actionUrl).slice(0, 500) : null,
        deduplicationKey ? String(deduplicationKey).slice(0, 160) : null,
        createdAt,
      );
    return id;
  }

  listNotifications(userId, limit = 40) {
    const safeLimit = Math.max(1, Math.min(Number(limit) || 40, 100));
    return this.db
      .prepare(
        `SELECT id, kind, title, body, action_url AS actionUrl,
           read_at AS readAt, created_at AS createdAt
         FROM user_notifications
         WHERE user_id = ?
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(userId, safeLimit);
  }

  markNotificationRead(userId, notificationId) {
    this.db
      .prepare(
        `UPDATE user_notifications SET read_at = ?
         WHERE user_id = ? AND id = ?`,
      )
      .run(nowIso(this.clock), userId, String(notificationId ?? ""));
    return this.listNotifications(userId);
  }

  listSeatWatches(userId) {
    return this.db
      .prepare(
        `SELECT id, library_id AS libraryId, library_name AS libraryName,
           seat_key AS seatKey, seat_label AS seatLabel, status,
           last_checked_at AS lastCheckedAt, last_error_code AS lastErrorCode,
           created_at AS createdAt
         FROM seat_watches
         WHERE user_id = ? AND status IN ('watching', 'available')
         ORDER BY created_at DESC`,
      )
      .all(userId);
  }

  saveSeatWatch(userId, { libraryId, libraryName, seatKey, seatLabel }) {
    const library = String(libraryId ?? "").trim();
    const seat = String(seatKey ?? "").trim();
    if (!library || !seat) throw new Error("请选择要提醒的座位");
    const createdAt = nowIso(this.clock);
    this.db
      .prepare(
        `INSERT INTO seat_watches
          (id, user_id, library_id, library_name, seat_key, seat_label,
           status, next_check_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'watching', ?, ?, ?)
         ON CONFLICT(user_id, library_id, seat_key) DO UPDATE SET
           library_name = excluded.library_name,
           seat_label = excluded.seat_label,
           status = 'watching',
           next_check_at = excluded.next_check_at,
           last_error_code = NULL,
           updated_at = excluded.updated_at`,
      )
      .run(
        `${userId}:${library}:${seat}`,
        userId,
        library,
        String(libraryName ?? "").trim().slice(0, 100),
        seat,
        String(seatLabel ?? seat).trim().slice(0, 80),
        createdAt,
        createdAt,
        createdAt,
      );
    return this.listSeatWatches(userId);
  }

  deleteSeatWatch(userId, watchId) {
    this.db
      .prepare("DELETE FROM seat_watches WHERE user_id = ? AND id = ?")
      .run(userId, String(watchId ?? ""));
    return this.listSeatWatches(userId);
  }

  listDueSeatWatches(limit = 20) {
    return this.db
      .prepare(
        `SELECT id, user_id AS userId, library_id AS libraryId,
           library_name AS libraryName, seat_key AS seatKey,
           seat_label AS seatLabel
         FROM seat_watches
         WHERE status = 'watching' AND next_check_at <= ?
           AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
         ORDER BY next_check_at LIMIT ?`,
      )
      .all(
        nowIso(this.clock),
        nowIso(this.clock),
        Math.max(1, Math.min(Number(limit) || 20, 100)),
      );
  }

  claimSeatWatch(watchId, leaseMs = READ_LEASE_MS) {
    const leaseToken = randomUUID();
    const claimedAt = nowIso(this.clock);
    const leaseExpiresAt = new Date(
      this.clock() + Math.max(30_000, Number(leaseMs) || READ_LEASE_MS),
    ).toISOString();
    const result = this.db
      .prepare(
        `UPDATE seat_watches SET
           lease_token = ?, lease_expires_at = ?, updated_at = ?
         WHERE id = ? AND status = 'watching' AND next_check_at <= ?
           AND (lease_expires_at IS NULL OR lease_expires_at <= ?)`,
      )
      .run(leaseToken, leaseExpiresAt, claimedAt, watchId, claimedAt, claimedAt);
    return result.changes === 1 ? leaseToken : null;
  }

  finishSeatWatchCheck(
    watchId,
    { available, errorCode = null, intervalMinutes = 5, leaseToken },
  ) {
    const checkedAt = nowIso(this.clock);
    const nextCheckAt = new Date(
      this.clock() + Math.max(5, Math.min(Number(intervalMinutes) || 5, 60)) * 60_000,
    ).toISOString();
    const result = this.db
      .prepare(
        `UPDATE seat_watches SET
           status = CASE WHEN ? THEN 'available' ELSE 'watching' END,
           last_checked_at = ?,
           next_check_at = ?,
           last_error_code = ?,
           lease_token = NULL,
           lease_expires_at = NULL,
           updated_at = ?
         WHERE id = ? AND lease_token = ?`,
      )
      .run(
        available ? 1 : 0,
        checkedAt,
        nextCheckAt,
        errorCode,
        checkedAt,
        watchId,
        leaseToken,
      );
    return result.changes === 1;
  }

  listScheduledReservations(userId) {
    return this.db
      .prepare(
        `SELECT id, library_id AS libraryId, library_name AS libraryName,
           seat_key AS seatKey, seat_label AS seatLabel,
           reservation_kind AS reservationKind, run_at AS runAt,
           status, attempt_count AS attemptCount, max_attempts AS maxAttempts,
           last_error_code AS lastErrorCode, created_at AS createdAt,
           completed_at AS completedAt
         FROM scheduled_library_actions
         WHERE user_id = ? AND status IN
           ('scheduled', 'running', 'succeeded', 'failed', 'review_required')
         ORDER BY run_at DESC LIMIT 30`,
      )
      .all(userId);
  }

  saveScheduledReservation(
    userId,
    {
      libraryId,
      libraryName,
      seatKey,
      seatLabel,
      reservationKind = "tomorrow",
      runAt,
      maxAttempts = 3,
    },
  ) {
    const library = String(libraryId ?? "").trim();
    const seat = String(seatKey ?? "").trim();
    const runAtMs = Date.parse(String(runAt ?? ""));
    if (!library || !seat) throw new Error("请选择定时预约的场馆和座位");
    if (!Number.isFinite(runAtMs)) throw new Error("定时预约时间无效");
    if (runAtMs < this.clock() - 5_000 || runAtMs > this.clock() + 7 * DAY_MS) {
      throw new Error("定时预约只能安排在未来七天内");
    }
    const createdAt = nowIso(this.clock);
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO scheduled_library_actions
          (id, user_id, library_id, library_name, seat_key, seat_label,
           reservation_kind, run_at, status, attempt_count, max_attempts,
           created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', 0, ?, ?, ?)`,
      )
      .run(
        id,
        userId,
        library,
        String(libraryName ?? "").trim().slice(0, 100),
        seat,
        String(seatLabel ?? seat).trim().slice(0, 80),
        reservationKind === "normal" ? "normal" : "tomorrow",
        new Date(runAtMs).toISOString(),
        Math.max(1, Math.min(Number(maxAttempts) || 3, 5)),
        createdAt,
        createdAt,
      );
    return this.listScheduledReservations(userId);
  }

  cancelScheduledReservation(userId, actionId) {
    this.db
      .prepare(
        `UPDATE scheduled_library_actions SET
           status = 'cancelled', lease_token = NULL, lease_expires_at = NULL,
           updated_at = ?
         WHERE user_id = ? AND id = ? AND status IN ('scheduled', 'running')`,
      )
      .run(nowIso(this.clock), userId, String(actionId ?? ""));
    return this.listScheduledReservations(userId);
  }

  listDueScheduledReservations(limit = 10) {
    return this.db
      .prepare(
        `SELECT id, user_id AS userId, library_id AS libraryId,
           library_name AS libraryName, seat_key AS seatKey,
           seat_label AS seatLabel, reservation_kind AS reservationKind,
           run_at AS runAt, attempt_count AS attemptCount,
           max_attempts AS maxAttempts
         FROM scheduled_library_actions
         WHERE status = 'scheduled' AND run_at <= ?
         ORDER BY run_at LIMIT ?`,
      )
      .all(nowIso(this.clock), Math.max(1, Math.min(Number(limit) || 10, 30)));
  }

  claimScheduledReservation(actionId) {
    const leaseToken = randomUUID();
    const claimedAt = nowIso(this.clock);
    const leaseExpiresAt = new Date(this.clock() + WRITE_LEASE_MS).toISOString();
    const result = this.db
      .prepare(
        `UPDATE scheduled_library_actions SET
           status = 'running', attempt_count = attempt_count + 1,
           lease_token = ?, lease_expires_at = ?, updated_at = ?
         WHERE id = ? AND status = 'scheduled'`,
      )
      .run(leaseToken, leaseExpiresAt, claimedAt, actionId);
    return result.changes === 1 ? leaseToken : null;
  }

  recoverExpiredScheduledReservationLeases() {
    const recoveredAt = nowIso(this.clock);
    return this.db
      .prepare(
        `UPDATE scheduled_library_actions SET
           status = 'review_required',
           last_error_code = 'LEASE_EXPIRED_RECONCILE_REQUIRED',
           completed_at = ?, lease_token = NULL, lease_expires_at = NULL,
           updated_at = ?
         WHERE status = 'running' AND lease_expires_at <= ?
         RETURNING id, user_id AS userId, library_name AS libraryName,
           seat_label AS seatLabel`,
      )
      .all(recoveredAt, recoveredAt, recoveredAt);
  }

  finishScheduledReservation(
    actionId,
    { succeeded, errorCode = null, retryDelayMs = 2_000, leaseToken },
  ) {
    const action = this.db
      .prepare(
        `SELECT attempt_count, max_attempts
         FROM scheduled_library_actions WHERE id = ?`,
      )
      .get(actionId);
    if (!action) return;
    const retry = !succeeded && action.attempt_count < action.max_attempts;
    const updatedAt = nowIso(this.clock);
    const result = this.db
      .prepare(
        `UPDATE scheduled_library_actions SET
           status = ?,
           run_at = CASE WHEN ? THEN ? ELSE run_at END,
           last_error_code = ?,
           completed_at = CASE WHEN ? THEN ? ELSE NULL END,
           lease_token = NULL,
           lease_expires_at = NULL,
           updated_at = ?
         WHERE id = ? AND status = 'running' AND lease_token = ?`,
      )
      .run(
        succeeded ? "succeeded" : retry ? "scheduled" : "failed",
        retry ? 1 : 0,
        new Date(this.clock() + Math.max(1_000, retryDelayMs)).toISOString(),
        errorCode,
        succeeded || !retry ? 1 : 0,
        updatedAt,
        updatedAt,
        actionId,
        leaseToken,
      );
    return result.changes === 1;
  }

  getReservationGuard(userId) {
    const row = this.db
      .prepare(
        `SELECT id, status, rebook_before_seconds AS rebookBeforeSeconds,
           rebook_delay_seconds AS rebookDelaySeconds,
           max_cycles AS maxCycles, cycle_count AS cycleCount,
           next_check_at AS nextCheckAt, last_error_code AS lastErrorCode,
           created_at AS createdAt, updated_at AS updatedAt
         FROM reservation_guards
         WHERE user_id = ? AND status IN ('active', 'running', 'paused', 'completed')
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(userId);
    return row ?? null;
  }

  enableReservationGuard(
    userId,
    { rebookBeforeSeconds = 30, rebookDelaySeconds = 1, maxCycles = 1 } = {},
  ) {
    const createdAt = nowIso(this.clock);
    this.db
      .prepare(
        `UPDATE reservation_guards SET status = 'cancelled', updated_at = ?
         WHERE user_id = ? AND status IN ('active', 'running', 'paused')`,
      )
      .run(createdAt, userId);
    this.db
      .prepare(
        `INSERT INTO reservation_guards
          (id, user_id, status, rebook_before_seconds, rebook_delay_seconds,
           max_cycles, cycle_count, next_check_at, created_at, updated_at)
         VALUES (?, ?, 'active', ?, ?, ?, 0, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        userId,
        Math.max(15, Math.min(Number(rebookBeforeSeconds) || 30, 120)),
        Math.max(1, Math.min(Number(rebookDelaySeconds) || 1, 10)),
        Math.max(1, Math.min(Number(maxCycles) || 1, 3)),
        createdAt,
        createdAt,
        createdAt,
      );
    return this.getReservationGuard(userId);
  }

  disableReservationGuard(userId) {
    this.db
      .prepare(
        `UPDATE reservation_guards SET status = 'cancelled', updated_at = ?
         WHERE user_id = ? AND status IN ('active', 'running', 'paused')`,
      )
      .run(nowIso(this.clock), userId);
    return null;
  }

  listDueReservationGuards(limit = 10) {
    return this.db
      .prepare(
        `SELECT id, user_id AS userId, status,
           rebook_before_seconds AS rebookBeforeSeconds,
           rebook_delay_seconds AS rebookDelaySeconds,
           max_cycles AS maxCycles, cycle_count AS cycleCount
         FROM reservation_guards
         WHERE status = 'active' AND next_check_at <= ?
         ORDER BY next_check_at LIMIT ?`,
      )
      .all(nowIso(this.clock), Math.max(1, Math.min(Number(limit) || 10, 30)));
  }

  claimReservationGuard(guardId) {
    const leaseToken = randomUUID();
    const claimedAt = nowIso(this.clock);
    const leaseExpiresAt = new Date(this.clock() + WRITE_LEASE_MS).toISOString();
    const result = this.db
      .prepare(
        `UPDATE reservation_guards SET status = 'running', lease_token = ?,
           lease_expires_at = ?, updated_at = ?
         WHERE id = ? AND status = 'active'`,
      )
      .run(leaseToken, leaseExpiresAt, claimedAt, guardId);
    return result.changes === 1 ? leaseToken : null;
  }

  recoverExpiredReservationGuardLeases() {
    const recoveredAt = nowIso(this.clock);
    return this.db
      .prepare(
        `UPDATE reservation_guards SET
           status = 'paused',
           last_error_code = 'LEASE_EXPIRED_RECONCILE_REQUIRED',
           lease_token = NULL, lease_expires_at = NULL, updated_at = ?
         WHERE status = 'running' AND lease_expires_at <= ?
         RETURNING id, user_id AS userId`,
      )
      .all(recoveredAt, recoveredAt);
  }

  finishReservationGuardCheck(
    guardId,
    {
      status = "active",
      errorCode = null,
      delayMs = 60_000,
      incrementCycle = false,
      leaseToken,
    },
  ) {
    const allowedStatus = ["active", "paused", "completed"].includes(status)
      ? status
      : "paused";
    const updatedAt = nowIso(this.clock);
    const result = this.db
      .prepare(
        `UPDATE reservation_guards SET
           status = ?,
           cycle_count = cycle_count + ?,
           next_check_at = ?,
           last_error_code = ?,
           lease_token = NULL,
           lease_expires_at = NULL,
           updated_at = ?
         WHERE id = ? AND status = 'running' AND lease_token = ?`,
      )
      .run(
        allowedStatus,
        incrementCycle ? 1 : 0,
        new Date(this.clock() + Math.max(5_000, Number(delayMs) || 60_000)).toISOString(),
        errorCode,
        updatedAt,
        guardId,
        leaseToken,
      );
    return result.changes === 1;
  }

  exportUserData(userId) {
    return {
      format: "dufesh-xiaoying-backup",
      version: 1,
      exportedAt: nowIso(this.clock),
      profile: this.getUser(userId),
      preferences: this.getUserPreferences(userId),
      favoriteSeats: this.listFavoriteSeats(userId),
      seatWatches: this.listSeatWatches(userId),
      scheduledReservations: this.listScheduledReservations(userId),
      reservationGuard: this.getReservationGuard(userId),
      notifications: this.listNotifications(userId, 100),
      security: {
        includesCredentials: false,
        requiresReauthorizationAfterRestore: true,
        automationsRequireConfirmationAfterRestore: true,
      },
    };
  }

  importUserData(userId, backup) {
    if (
      !backup ||
      backup.format !== "dufesh-xiaoying-backup" ||
      Number(backup.version) !== 1
    ) {
      throw new Error("这不是东财之影支持的备份文件");
    }
    const summary = {
      preferences: false,
      favoriteSeats: 0,
      seatWatches: 0,
      skippedAutomations: 0,
    };
    if (backup.preferences && typeof backup.preferences === "object") {
      this.saveUserPreferences(userId, backup.preferences);
      summary.preferences = true;
    }
    for (const favorite of Array.isArray(backup.favoriteSeats)
      ? backup.favoriteSeats.slice(0, 200)
      : []) {
      this.saveFavoriteSeat(userId, favorite);
      summary.favoriteSeats += 1;
    }
    for (const watch of Array.isArray(backup.seatWatches)
      ? backup.seatWatches.slice(0, 50)
      : []) {
      this.saveSeatWatch(userId, watch);
      summary.seatWatches += 1;
    }
    summary.skippedAutomations =
      (Array.isArray(backup.scheduledReservations)
        ? backup.scheduledReservations.filter((item) =>
            ["scheduled", "running"].includes(item.status),
          ).length
        : 0) +
      (["active", "running"].includes(backup.reservationGuard?.status) ? 1 : 0);
    return summary;
  }

  claimTaskExecution(userId, task, leaseMs = WRITE_LEASE_MS) {
    const idempotencyKey = String(task?.idempotencyKey ?? "").trim();
    if (!idempotencyKey || idempotencyKey.length > 160) {
      throw new Error("幂等键格式无效");
    }
    const keyHash = hashToken(idempotencyKey);
    const requestDigest = contentHash({
      type: String(task?.type ?? ""),
      payload: task?.payload ?? null,
    });
    const claimedAt = nowIso(this.clock);
    const leaseToken = randomUUID();
    const leaseExpiresAt = new Date(
      this.clock() + Math.max(30_000, Number(leaseMs) || WRITE_LEASE_MS),
    ).toISOString();
    const expiresAt = new Date(this.clock() + 30 * DAY_MS).toISOString();

    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare("DELETE FROM task_executions WHERE expires_at <= ?")
        .run(claimedAt);
      const existing = this.db
        .prepare(
          `SELECT request_digest, status, result_json, lease_expires_at
           FROM task_executions
           WHERE user_id = ? AND idempotency_key_hash = ?`,
        )
        .get(userId, keyHash);

      if (existing) {
        if (existing.request_digest !== requestDigest) {
          this.db.exec("COMMIT");
          return { state: "conflict" };
        }
        if (["succeeded", "failed"].includes(existing.status) && existing.result_json) {
          const result = JSON.parse(existing.result_json);
          this.db.exec("COMMIT");
          return { state: "replay", result };
        }
        if (existing.status === "review_required") {
          this.db.exec("COMMIT");
          return { state: "review_required" };
        }
        if (
          existing.status === "running" &&
          Date.parse(existing.lease_expires_at ?? "") > this.clock()
        ) {
          this.db.exec("COMMIT");
          return { state: "in_progress" };
        }
        this.db
          .prepare(
            `UPDATE task_executions SET
               status = 'review_required', lease_token = NULL,
               lease_expires_at = NULL, updated_at = ?
             WHERE user_id = ? AND idempotency_key_hash = ?`,
          )
          .run(claimedAt, userId, keyHash);
        this.db.exec("COMMIT");
        return { state: "review_required" };
      }

      this.db
        .prepare(
          `INSERT INTO task_executions
            (id, user_id, idempotency_key_hash, request_digest, task_type,
             status, lease_token, lease_expires_at, expires_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?)`,
        )
        .run(
          randomUUID(),
          userId,
          keyHash,
          requestDigest,
          String(task?.type ?? "unknown").slice(0, 100),
          leaseToken,
          leaseExpiresAt,
          expiresAt,
          claimedAt,
          claimedAt,
        );
      this.db.exec("COMMIT");
      return { state: "claimed", leaseToken };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  finishTaskExecution(userId, idempotencyKey, leaseToken, result, auditRecord) {
    const keyHash = hashToken(String(idempotencyKey ?? "").trim());
    const updatedAt = nowIso(this.clock);
    const resultJson = JSON.stringify(result);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const updated = this.db
        .prepare(
          `UPDATE task_executions SET status = ?, result_json = ?,
             lease_token = NULL, lease_expires_at = NULL, updated_at = ?
           WHERE user_id = ? AND idempotency_key_hash = ?
             AND status = 'running' AND lease_token = ?`,
        )
        .run(
          result?.status === "succeeded" ? "succeeded" : "failed",
          resultJson,
          updatedAt,
          userId,
          keyHash,
          leaseToken,
        );
      if (updated.changes !== 1) {
        this.db.exec("ROLLBACK");
        return false;
      }
      this.appendAudit(userId, auditRecord);
      this.db.exec("COMMIT");
      return true;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  appendAudit(userId, record) {
    this.db
      .prepare(
        `INSERT INTO audit_logs
          (id, user_id, action, status, idempotency_key, error_code, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        userId,
        String(record.type ?? "unknown").slice(0, 100),
        String(record.status ?? "unknown").slice(0, 30),
        record.idempotencyKey ?? null,
        record.errorCode ?? null,
        record.completedAt ?? nowIso(this.clock),
      );
  }

  listAudit(userId, limit = 30) {
    const safeLimit = Math.max(1, Math.min(Number(limit) || 30, 100));
    return this.db
      .prepare(
        `SELECT action AS type, status, idempotency_key AS idempotencyKey,
           error_code AS errorCode, created_at AS completedAt
         FROM audit_logs WHERE user_id = ?
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(userId, safeLimit);
  }

  syncBaiguoSnapshot(userId, snapshot) {
    const source = "baiguo";
    const syncedAt = snapshot.syncedAt ?? nowIso(this.clock);
    const tables = [
      ["external_courses", snapshot.courses ?? []],
      ["external_assignments", snapshot.assignments ?? []],
      ["external_events", snapshot.events ?? []],
      ["external_notifications", snapshot.notifications ?? []],
    ];

    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const [table] of tables) {
        this.db
          .prepare(`UPDATE ${table} SET active = 0 WHERE user_id = ? AND source = ?`)
          .run(userId, source);
      }

      for (const course of snapshot.courses ?? []) {
        this.db
          .prepare(
            `INSERT INTO external_courses
              (id, user_id, source, external_id, title, section_external_id, content_hash, active, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
             ON CONFLICT(user_id, source, external_id) DO UPDATE SET
               title = excluded.title,
               section_external_id = excluded.section_external_id,
               content_hash = excluded.content_hash,
               active = 1,
               updated_at = excluded.updated_at`,
          )
          .run(
            `${userId}:${source}:course:${course.externalId}`,
            userId,
            source,
            course.externalId,
            course.title,
            course.sectionExternalId,
            course.contentHash,
            syncedAt,
          );
      }
      for (const assignment of snapshot.assignments ?? []) {
        this.db
          .prepare(
            `INSERT INTO external_assignments
              (id, user_id, source, external_id, course_external_id, title, published_at, due_at, status, content_hash, active, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
             ON CONFLICT(user_id, source, external_id) DO UPDATE SET
               course_external_id = excluded.course_external_id,
               title = excluded.title,
               published_at = excluded.published_at,
               due_at = excluded.due_at,
               status = excluded.status,
               content_hash = excluded.content_hash,
               active = 1,
               updated_at = excluded.updated_at`,
          )
          .run(
            `${userId}:${source}:assignment:${assignment.externalId}`,
            userId,
            source,
            assignment.externalId,
            assignment.courseExternalId,
            assignment.title,
            assignment.publishedAt,
            assignment.dueAt,
            assignment.status,
            assignment.contentHash,
            syncedAt,
          );
      }
      for (const event of snapshot.events ?? []) {
        this.db
          .prepare(
            `INSERT INTO external_events
              (id, user_id, source, external_id, course_external_id, title, starts_at, ends_at, event_type, content_hash, active, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
             ON CONFLICT(user_id, source, external_id) DO UPDATE SET
               course_external_id = excluded.course_external_id,
               title = excluded.title,
               starts_at = excluded.starts_at,
               ends_at = excluded.ends_at,
               event_type = excluded.event_type,
               content_hash = excluded.content_hash,
               active = 1,
               updated_at = excluded.updated_at`,
          )
          .run(
            `${userId}:${source}:event:${event.externalId}`,
            userId,
            source,
            event.externalId,
            event.courseExternalId,
            event.title,
            event.startsAt,
            event.endsAt,
            event.eventType,
            event.contentHash,
            syncedAt,
          );
      }
      for (const notification of snapshot.notifications ?? []) {
        this.db
          .prepare(
            `INSERT INTO external_notifications
              (id, user_id, source, external_id, title, published_at, is_read, source_path, content_hash, active, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
             ON CONFLICT(user_id, source, external_id) DO UPDATE SET
               title = excluded.title,
               published_at = excluded.published_at,
               is_read = excluded.is_read,
               source_path = excluded.source_path,
               content_hash = excluded.content_hash,
               active = 1,
               updated_at = excluded.updated_at`,
          )
          .run(
            `${userId}:${source}:notice:${notification.externalId}`,
            userId,
            source,
            notification.externalId,
            notification.title,
            notification.publishedAt,
            notification.read ? 1 : 0,
            notification.sourcePath,
            notification.contentHash,
            syncedAt,
          );
      }
      this.db
        .prepare(
          `INSERT INTO sync_states
            (id, user_id, provider, last_success_at, last_error_code, item_count, updated_at)
           VALUES (?, ?, ?, ?, NULL, ?, ?)
           ON CONFLICT(user_id, provider) DO UPDATE SET
             last_success_at = excluded.last_success_at,
             last_error_code = NULL,
             item_count = excluded.item_count,
             updated_at = excluded.updated_at`,
        )
        .run(
          `${userId}:${source}`,
          userId,
          source,
          syncedAt,
          tables.reduce((total, [, items]) => total + items.length, 0),
          syncedAt,
        );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }

    return {
      syncedAt,
      courses: snapshot.courses?.length ?? 0,
      assignments: snapshot.assignments?.length ?? 0,
      events: snapshot.events?.length ?? 0,
      notifications: snapshot.notifications?.length ?? 0,
    };
  }

  getBaiguoItems(userId) {
    const courses = this.db
      .prepare(
        `SELECT external_id AS externalId, title, section_external_id AS sectionExternalId,
           updated_at AS updatedAt
         FROM external_courses
         WHERE user_id = ? AND source = 'baiguo' AND active = 1
         ORDER BY title`,
      )
      .all(userId);
    const assignments = this.db
      .prepare(
        `SELECT external_id AS externalId, course_external_id AS courseExternalId,
           title, published_at AS publishedAt, due_at AS dueAt, status,
           updated_at AS updatedAt
         FROM external_assignments
         WHERE user_id = ? AND source = 'baiguo' AND active = 1
         ORDER BY CASE WHEN due_at IS NULL THEN 1 ELSE 0 END, due_at`,
      )
      .all(userId);
    const events = this.db
      .prepare(
        `SELECT external_id AS externalId, course_external_id AS courseExternalId,
           title, starts_at AS startsAt, ends_at AS endsAt, event_type AS eventType,
           updated_at AS updatedAt
         FROM external_events
         WHERE user_id = ? AND source = 'baiguo' AND active = 1
         ORDER BY starts_at`,
      )
      .all(userId);
    const notifications = this.db
      .prepare(
        `SELECT external_id AS externalId, title, published_at AS publishedAt,
           is_read AS isRead, source_path AS sourcePath, updated_at AS updatedAt
         FROM external_notifications
         WHERE user_id = ? AND source = 'baiguo' AND active = 1
         ORDER BY published_at DESC`,
      )
      .all(userId)
      .map((item) => ({ ...item, isRead: Boolean(item.isRead) }));
    const syncState = this.db
      .prepare(
        `SELECT last_success_at AS lastSuccessAt, last_error_code AS lastErrorCode,
           item_count AS itemCount, updated_at AS updatedAt
         FROM sync_states WHERE user_id = ? AND provider = 'baiguo'`,
      )
      .get(userId) ?? null;
    return { courses, assignments, events, notifications, syncState };
  }

  #seedDefaultInvite(defaultInviteCode) {
    const exists = this.db
      .prepare("SELECT 1 AS ok FROM invite_codes WHERE label = 'default-local-vip'")
      .get();
    if (exists) return;
    this.db
      .prepare(
        `INSERT INTO invite_codes
          (id, label, code_hash, max_uses, use_count, enabled, created_at)
         VALUES (?, 'default-local-vip', ?, NULL, 0, 1, ?)`,
      )
      .run(randomUUID(), hashInviteCode(defaultInviteCode), nowIso(this.clock));
  }

  #migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS invite_codes (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL UNIQUE,
        code_hash TEXT NOT NULL,
        max_uses INTEGER,
        use_count INTEGER NOT NULL DEFAULT 0,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS vip_entitlements (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        source TEXT NOT NULL,
        starts_at TEXT NOT NULL,
        revoked_at TEXT
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        revoked_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
      CREATE TABLE IF NOT EXISTS user_secrets (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        secret_kind TEXT NOT NULL,
        provider TEXT,
        model TEXT,
        base_url TEXT,
        algorithm TEXT NOT NULL,
        ciphertext TEXT NOT NULL,
        iv TEXT NOT NULL,
        tag TEXT NOT NULL,
        last4 TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(user_id, secret_kind)
      );
      CREATE TABLE IF NOT EXISTS external_connections (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        status TEXT NOT NULL,
        credential_secret_id TEXT REFERENCES user_secrets(id) ON DELETE SET NULL,
        credential_expires_at TEXT,
        last_success_at TEXT,
        last_error_code TEXT,
        updated_at TEXT NOT NULL,
        UNIQUE(user_id, provider)
      );
      CREATE TABLE IF NOT EXISTS favorite_seats (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        library_id TEXT NOT NULL,
        seat_key TEXT NOT NULL,
        label TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(user_id, library_id, seat_key)
      );
      CREATE TABLE IF NOT EXISTS audit_logs (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        action TEXT NOT NULL,
        status TEXT NOT NULL,
        idempotency_key TEXT,
        error_code TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_audit_user_time ON audit_logs(user_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS task_executions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        idempotency_key_hash TEXT NOT NULL,
        request_digest TEXT NOT NULL,
        task_type TEXT NOT NULL,
        status TEXT NOT NULL,
        result_json TEXT,
        lease_token TEXT,
        lease_expires_at TEXT,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(user_id, idempotency_key_hash)
      );
      CREATE INDEX IF NOT EXISTS idx_task_executions_expiry
        ON task_executions(expires_at);
      CREATE TABLE IF NOT EXISTS user_settings (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        setting_key TEXT NOT NULL,
        setting_value TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(user_id, setting_key)
      );
      CREATE TABLE IF NOT EXISTS user_notifications (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        action_url TEXT,
        deduplication_key TEXT,
        read_at TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(user_id, deduplication_key)
      );
      CREATE INDEX IF NOT EXISTS idx_user_notifications_time
        ON user_notifications(user_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS seat_watches (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        library_id TEXT NOT NULL,
        library_name TEXT NOT NULL,
        seat_key TEXT NOT NULL,
        seat_label TEXT NOT NULL,
        status TEXT NOT NULL,
        next_check_at TEXT NOT NULL,
        last_checked_at TEXT,
        last_error_code TEXT,
        lease_token TEXT,
        lease_expires_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(user_id, library_id, seat_key)
      );
      CREATE INDEX IF NOT EXISTS idx_seat_watches_due
        ON seat_watches(status, next_check_at);
      CREATE TABLE IF NOT EXISTS scheduled_library_actions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        library_id TEXT NOT NULL,
        library_name TEXT NOT NULL,
        seat_key TEXT NOT NULL,
        seat_label TEXT NOT NULL,
        reservation_kind TEXT NOT NULL,
        run_at TEXT NOT NULL,
        status TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 3,
        last_error_code TEXT,
        lease_token TEXT,
        lease_expires_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_scheduled_library_actions_due
        ON scheduled_library_actions(status, run_at);
      CREATE TABLE IF NOT EXISTS reservation_guards (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        status TEXT NOT NULL,
        rebook_before_seconds INTEGER NOT NULL,
        rebook_delay_seconds INTEGER NOT NULL,
        max_cycles INTEGER NOT NULL,
        cycle_count INTEGER NOT NULL DEFAULT 0,
        next_check_at TEXT NOT NULL,
        last_error_code TEXT,
        lease_token TEXT,
        lease_expires_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_reservation_guards_due
        ON reservation_guards(status, next_check_at);
      CREATE TABLE IF NOT EXISTS external_courses (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        source TEXT NOT NULL,
        external_id TEXT NOT NULL,
        title TEXT NOT NULL,
        section_external_id TEXT,
        content_hash TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL,
        UNIQUE(user_id, source, external_id)
      );
      CREATE TABLE IF NOT EXISTS external_assignments (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        source TEXT NOT NULL,
        external_id TEXT NOT NULL,
        course_external_id TEXT NOT NULL,
        title TEXT NOT NULL,
        published_at TEXT,
        due_at TEXT,
        status TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL,
        UNIQUE(user_id, source, external_id)
      );
      CREATE TABLE IF NOT EXISTS external_events (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        source TEXT NOT NULL,
        external_id TEXT NOT NULL,
        course_external_id TEXT,
        title TEXT NOT NULL,
        starts_at TEXT NOT NULL,
        ends_at TEXT,
        event_type TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL,
        UNIQUE(user_id, source, external_id)
      );
      CREATE TABLE IF NOT EXISTS external_notifications (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        source TEXT NOT NULL,
        external_id TEXT NOT NULL,
        title TEXT NOT NULL,
        published_at TEXT,
        is_read INTEGER NOT NULL DEFAULT 0,
        source_path TEXT,
        content_hash TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL,
        UNIQUE(user_id, source, external_id)
      );
      CREATE TABLE IF NOT EXISTS sync_states (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        last_success_at TEXT,
        last_error_code TEXT,
        item_count INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        UNIQUE(user_id, provider)
      );
    `);
    this.#ensureColumn("seat_watches", "lease_token", "TEXT");
    this.#ensureColumn("seat_watches", "lease_expires_at", "TEXT");
    this.#ensureColumn("scheduled_library_actions", "lease_token", "TEXT");
    this.#ensureColumn("scheduled_library_actions", "lease_expires_at", "TEXT");
    this.#ensureColumn("reservation_guards", "lease_token", "TEXT");
    this.#ensureColumn("reservation_guards", "lease_expires_at", "TEXT");
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_seat_watches_lease
        ON seat_watches(status, next_check_at, lease_expires_at);
      CREATE INDEX IF NOT EXISTS idx_scheduled_library_actions_lease
        ON scheduled_library_actions(status, lease_expires_at);
      CREATE INDEX IF NOT EXISTS idx_reservation_guards_lease
        ON reservation_guards(status, lease_expires_at);
    `);
  }

  #ensureColumn(table, column, definition) {
    const exists = this.db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .some((item) => item.name === column);
    if (!exists) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function requiredProvider(value) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!/^[a-z0-9_-]{2,40}$/.test(normalized)) throw new Error("外部服务标识无效");
  return normalized;
}

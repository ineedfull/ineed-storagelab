import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  validateConnection,
  validateCredentials,
  validateId,
} from "../src/domain/connection.js";
import { validateSettings, DEFAULT_SETTINGS } from "../src/domain/settings.js";
import { AppError, fail, record, text } from "../src/domain/errors.js";
const ACTIVE = new Set(["queued", "running", "cancelling"]);
const JOB_FIELDS = [
  "id",
  "connectionId",
  "connectionName",
  "bucket",
  "key",
  "versionId",
  "direction",
  "resumable",
  "state",
  "bytesTransferred",
  "totalBytes",
  "rate",
  "createdAt",
  "updatedAt",
  "error",
  "warning",
  "batchId",
  "verification",
  "sha256",
];
export function createStore({ directory, vault }) {
  let db;
  const sessions = new Map();
  const locks = new Map();
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    db = new DatabaseSync(join(directory, "storagelab.sqlite"));
    chmodSync(join(directory, "storagelab.sqlite"), 0o600);
    db.exec("PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON;");
    const version = db.prepare("PRAGMA user_version").get().user_version;
    if (version > 3)
      fail("SCHEMA_UNSUPPORTED", "数据版本高于当前应用支持范围。");
    db.exec(
      `BEGIN; CREATE TABLE IF NOT EXISTS connections(id TEXT PRIMARY KEY, public TEXT NOT NULL); CREATE TABLE IF NOT EXISTS credentials(connection_id TEXT PRIMARY KEY REFERENCES connections(id) ON DELETE CASCADE, blob BLOB NOT NULL); CREATE TABLE IF NOT EXISTS settings(id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS job_files(job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS directory_batches(id TEXT PRIMARY KEY,data TEXT NOT NULL); PRAGMA user_version=3; COMMIT;`,
    );
    for (const row of db
      .prepare("SELECT id,data FROM directory_batches")
      .all()) {
      const batch = JSON.parse(row.data);
      // Shutdown persists the batch before all aborted workers have settled.
      // Normalize interrupted batches too, including ones saved by older builds.
      if (
        ["running", "cancelling"].includes(batch.state) ||
        (batch.state === "interrupted" &&
          batch.entries.some((entry) =>
            ["ready", "queued", "running"].includes(entry.state),
          ))
      ) {
        batch.state = "interrupted";
        batch.updatedAt = new Date().toISOString();
        for (const entry of batch.entries)
          if (["ready", "queued", "running"].includes(entry.state))
            entry.state = "interrupted";
        db.prepare("UPDATE directory_batches SET data=? WHERE id=?").run(
          JSON.stringify(batch),
          row.id,
        );
      }
    }
    for (const row of db.prepare("SELECT id,data FROM jobs").all()) {
      const job = JSON.parse(row.data);
      if (ACTIVE.has(job.state)) {
        job.state = "interrupted";
        job.updatedAt = new Date().toISOString();
        job.warning = job.resumable
          ? "应用已重启，请通过恢复上传重新选择原文件并核验续传记录。"
          : "应用已重启，请重新选择文件；普通传输不支持重启续传。";
        db.prepare("UPDATE jobs SET data=? WHERE id=?").run(
          JSON.stringify(job),
          row.id,
        );
      }
    }
  } catch (e) {
    db?.close();
    if (e instanceof AppError) throw e;
    fail("PERSISTENCE_ERROR", "无法初始化本地数据。");
  }
  function transact(fn) {
    try {
      db.exec("BEGIN IMMEDIATE");
      const value = fn();
      db.exec("COMMIT");
      return value;
    } catch (e) {
      try {
        db.exec("ROLLBACK");
      } catch {}
      if (e instanceof AppError) throw e;
      fail("PERSISTENCE_ERROR", "本地数据保存失败。");
    }
  }
  function guarded(fn) {
    try {
      return fn();
    } catch (e) {
      if (e instanceof AppError) throw e;
      fail("PERSISTENCE_ERROR", "本地数据读取失败。");
    }
  }
  function connections() {
    return db
      .prepare("SELECT id,public FROM connections ORDER BY rowid")
      .all()
      .map((row) => {
        const c = JSON.parse(row.public);
        return {
          ...c,
          hasCredentials:
            c.credentialStorage === "session"
              ? sessions.has(row.id)
              : Boolean(
                  db
                    .prepare("SELECT 1 FROM credentials WHERE connection_id=?")
                    .get(row.id),
                ),
        };
      });
  }
  function jobs() {
    return db
      .prepare("SELECT data FROM jobs ORDER BY rowid DESC LIMIT 200")
      .all()
      .map((r) => JSON.parse(r.data));
  }
  function allJobs() {
    return db
      .prepare("SELECT data FROM jobs ORDER BY rowid DESC")
      .all()
      .map((r) => JSON.parse(r.data));
  }
  function assertUnlocked(id) {
    if (
      locks.has(id) ||
      allJobs().some((j) => j.connectionId === id && ACTIVE.has(j.state))
    )
      fail("CONNECTION_BUSY", "连接仍有关联任务，暂时无法编辑或删除。");
  }
  const api = {
    snapshot: () =>
      guarded(() => ({
        connections: connections(),
        settings: JSON.parse(
          db.prepare("SELECT data FROM settings WHERE id=1").get()?.data ??
            JSON.stringify(DEFAULT_SETTINGS),
        ),
        jobs: jobs(),
      })),
    saveConnection(payload) {
      record(payload);
      const c = validateConnection(payload.connection);
      const mode = payload.credentialStorage;
      if (!["session", "encrypted"].includes(mode))
        fail("INVALID_INPUT", "必须明确选择凭证存储模式。");
      let session;
      const result = transact(() => {
        const existing = c.id
          ? db.prepare("SELECT public FROM connections WHERE id=?").get(c.id)
          : undefined;
        if (c.id && !existing) fail("NOT_FOUND", "连接不存在。");
        if (c.id) assertUnlocked(c.id);
        else if (connections().length >= 100)
          fail("LIMIT_REACHED", "最多保存100个连接。");
        const id = c.id ?? randomUUID();
        let blob;
        if (payload.credentials !== undefined) {
          const credentials = validateCredentials(payload.credentials);
          if (mode === "encrypted") blob = vault.encrypt(credentials);
          else session = credentials;
        } else {
          if (!existing) fail("INVALID_INPUT", "新连接必须填写完整凭证。");
          const old = JSON.parse(existing.public);
          if (old.credentialStorage !== mode) {
            const credentials = api.getCredentials(id);
            if (!credentials) fail("CREDENTIALS_REQUIRED", "请重新填写凭证。");
            if (mode === "encrypted") blob = vault.encrypt(credentials);
            else session = credentials;
          } else if (mode === "session") session = sessions.get(id);
        }
        const value = { ...c, id, credentialStorage: mode };
        db.prepare(
          "INSERT INTO connections(id,public) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET public=excluded.public",
        ).run(id, JSON.stringify(value));
        if (mode === "session")
          db.prepare("DELETE FROM credentials WHERE connection_id=?").run(id);
        else if (blob)
          db.prepare(
            "INSERT INTO credentials(connection_id,blob) VALUES (?,?) ON CONFLICT(connection_id) DO UPDATE SET blob=excluded.blob",
          ).run(id, blob);
        return value;
      });
      if (mode === "session") {
        if (session) sessions.set(result.id, session);
      } else sessions.delete(result.id);
      return {
        ...result,
        hasCredentials: mode === "session" ? sessions.has(result.id) : true,
      };
    },
    removeConnection(id) {
      validateId(id);
      transact(() => {
        assertUnlocked(id);
        if (!db.prepare("DELETE FROM connections WHERE id=?").run(id).changes)
          fail("NOT_FOUND", "连接不存在。");
      });
      sessions.delete(id);
      return true;
    },
    getConnection: (id) =>
      guarded(() => connections().find((c) => c.id === validateId(id))),
    getCredentials(id) {
      return guarded(() => {
        validateId(id);
        if (sessions.has(id)) return structuredClone(sessions.get(id));
        const row = db
          .prepare("SELECT blob FROM credentials WHERE connection_id=?")
          .get(id);
        return row ? vault.decrypt(row.blob) : undefined;
      });
    },
    saveSettings(input) {
      const settings = validateSettings(input);
      return transact(() => {
        db.prepare(
          "INSERT INTO settings(id,data) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
        ).run(JSON.stringify(settings));
        return settings;
      });
    },
    saveJob(input, { localFile } = {}) {
      record(input);
      validateId(input.id);
      if (input.versionId !== undefined)
        text(input.versionId, "版本ID", 1024, true);
      if (
        ![
          "queued",
          "running",
          "cancelling",
          "success",
          "failed",
          "cancelled",
          "interrupted",
        ].includes(input.state)
      )
        fail("INVALID_INPUT", "任务状态无效。");
      for (const key of ["error", "warning"])
        if (input[key] !== undefined) text(input[key], key, 2048);
      const job = Object.fromEntries(
        JOB_FIELDS.filter((k) => input[k] !== undefined).map((k) => [
          k,
          input[k],
        ]),
      );
      return transact(() => {
        if (
          job.state === "queued" &&
          allJobs().filter((j) => j.state === "queued" && j.id !== job.id)
            .length >= 100
        )
          fail("LIMIT_REACHED", "排队任务不能超过100个。");
        db.prepare(
          "INSERT INTO jobs(id,data) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
        ).run(job.id, JSON.stringify(job));
        if (localFile)
          db.prepare(
            "INSERT INTO job_files(job_id,data) VALUES (?,?) ON CONFLICT(job_id) DO UPDATE SET data=excluded.data",
          ).run(job.id, JSON.stringify(localFile));
        const all = db
          .prepare("SELECT id,data FROM jobs ORDER BY rowid DESC")
          .all();
        let remaining =
          200 -
          all.filter((row) => ACTIVE.has(JSON.parse(row.data).state)).length;
        for (const row of all) {
          if (ACTIVE.has(JSON.parse(row.data).state)) continue;
          if (remaining-- > 0) continue;
          db.prepare("DELETE FROM jobs WHERE id=?").run(row.id);
        }
        return job;
      });
    },
    listJobs: () => guarded(jobs),
    listDirectoryBatches: () =>
      guarded(() =>
        db
          .prepare(
            "SELECT data FROM directory_batches ORDER BY rowid DESC LIMIT 20",
          )
          .all()
          .map((r) => JSON.parse(r.data)),
      ),
    getDirectoryBatch(id) {
      validateId(id);
      return guarded(() => {
        const row = db
          .prepare("SELECT data FROM directory_batches WHERE id=?")
          .get(id);
        return row ? JSON.parse(row.data) : undefined;
      });
    },
    saveDirectoryBatch(batch) {
      record(batch);
      validateId(batch.id);
      if (
        !Array.isArray(batch.entries) ||
        batch.entries.length > 1000 ||
        ![
          "running",
          "cancelling",
          "completed",
          "failed",
          "cancelled",
          "interrupted",
        ].includes(batch.state)
      )
        fail("INVALID_INPUT", "目录批次格式无效。");
      const json = JSON.stringify(batch);
      if (Buffer.byteLength(json) > 8 * 1024 * 1024)
        fail("INVALID_INPUT", "目录批次记录过大。");
      return transact(() => {
        db.prepare(
          "INSERT INTO directory_batches(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
        ).run(batch.id, json);
        const rows = db
          .prepare("SELECT id,data FROM directory_batches ORDER BY rowid DESC")
          .all();
        let remaining = 20;
        for (const row of rows) {
          if (["running", "cancelling"].includes(JSON.parse(row.data).state))
            continue;
          if (--remaining < 0)
            db.prepare("DELETE FROM directory_batches WHERE id=?").run(row.id);
        }
        return structuredClone(batch);
      });
    },
    // Native-only viewing references. Never include these in snapshot/export.
    getJobFile: (id) =>
      guarded(() => {
        const row = db
          .prepare("SELECT data FROM job_files WHERE job_id=?")
          .get(id);
        return row ? JSON.parse(row.data) : undefined;
      }),
    saveJobFile(id, file) {
      return transact(() => {
        db.prepare(
          "INSERT INTO job_files(job_id,data) VALUES (?,?) ON CONFLICT(job_id) DO UPDATE SET data=excluded.data",
        ).run(id, JSON.stringify(file));
      });
    },
    removeJob(id) {
      return transact(() => {
        const row = db.prepare("SELECT data FROM jobs WHERE id=?").get(id);
        if (row && ACTIVE.has(JSON.parse(row.data).state))
          fail("JOB_BUSY", "请先停止任务，再删除记录。");
        db.prepare("DELETE FROM jobs WHERE id=?").run(id);
        return true;
      });
    },
    lockConnection(id) {
      validateId(id);
      locks.set(id, (locks.get(id) ?? 0) + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const count = locks.get(id) - 1;
        if (count) locks.set(id, count);
        else locks.delete(id);
      };
    },
    close() {
      sessions.clear();
      locks.clear();
      db.close();
    },
  };
  return api;
}

/* 《寻宝奇兵》存档模块（游戏外壳）
 * - 存档：localStorage `tq.save.v1`（schema 校验 / 缺字段补默认 / 损坏兜底）
 * - 登录态：localStorage `tq.session.v1`（{token, username, displayName, expiresAt}）
 * - 对外接口：TQ.Save（见 docs/GAMEDESIGN.md 5.3、6 节）
 * - 依赖：无（可单独加载）；不操作 DOM
 */
(function (global) {
  'use strict';

  var TQ = global.TQ = global.TQ || {};

  var SAVE_KEY = 'tq.save.v1';
  var SESSION_KEY = 'tq.session.v1';
  var SCHEMA = 1;
  var MAX_LEVEL_INDEX = 999;
  var MAX_BEST_TIME_KEYS = 100;

  var DEFAULT_SAVE = {
    schema: SCHEMA,
    unlockedLevel: 0,
    bestTimes: {},
    totalTreasures: 0,
    sound: true,
    updatedAt: ''
  };

  /* -------------------------------------------------------------------
   * 内容版本迁移（v1 3 关 → v2 4 关，contentVersion 1 → 2）
   * v1 时代最多只有 3 关，老玩家通关第 3 关（index 2）后 unlockedLevel 也只能到 2。
   * 读取存档时若发现「第 3 关已有最佳成绩」且 unlockedLevel < 3，则一次性把
   * unlockedLevel 提到 3，让老玩家无需重打即可进入第 4 关（index 3）。
   * 只提升 unlockedLevel，不改动 bestTimes / totalTreasures / sound 等已有进度。
   * 迁移结果会立即写回 localStorage，保证只迁移一次。
   * ------------------------------------------------------------------- */
  var MIGRATION_LEGACY_LAST_LEVEL = 2;   /* v1 最后一关（第 3 关）index */
  var MIGRATION_UNLOCKED_LEVEL = 3;      /* v2 第 4 关 index */

  function applyContentMigrations(data) {
    if (!data || !data.bestTimes) return data;
    var legacyBest = data.bestTimes[String(MIGRATION_LEGACY_LAST_LEVEL)];
    if (typeof legacyBest === 'number' && data.unlockedLevel < MIGRATION_UNLOCKED_LEVEL) {
      data.unlockedLevel = MIGRATION_UNLOCKED_LEVEL;
    }
    return data;
  }

  /* ---------------- 基础工具 ---------------- */

  function clone(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  function isObject(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
  }

  function toInt(value, fallback, min, max) {
    var n = typeof value === 'number' ? value : parseInt(value, 10);
    if (typeof n !== 'number' || !isFinite(n)) return fallback;
    n = Math.floor(n);
    if (typeof min === 'number' && n < min) n = min;
    if (typeof max === 'number' && n > max) n = max;
    return n;
  }

  function pad2(n) {
    return (n < 10 ? '0' : '') + n;
  }

  /* 与契约示例一致的带时区 ISO 时间（本地时区，如 2026-11-03T14:00:00+08:00） */
  function localIsoNow() {
    try {
      var d = new Date();
      var offset = -d.getTimezoneOffset();
      var sign = offset >= 0 ? '+' : '-';
      var abs = Math.abs(offset);
      return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
        'T' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds()) +
        sign + pad2(Math.floor(abs / 60)) + ':' + pad2(abs % 60);
    } catch (e) {
      return '';
    }
  }

  /* ---------------- localStorage（带内存兜底） ---------------- */

  var memoryStore = {};
  var storageAvailable = (function () {
    try {
      var probe = '__tq_probe__';
      global.localStorage.setItem(probe, '1');
      global.localStorage.removeItem(probe);
      return true;
    } catch (e) {
      return false;
    }
  })();

  function readRaw(key) {
    if (storageAvailable) {
      try {
        return global.localStorage.getItem(key);
      } catch (e) {
        /* 隐私模式等场景降级为内存 */
      }
    }
    return Object.prototype.hasOwnProperty.call(memoryStore, key) ? memoryStore[key] : null;
  }

  function writeRaw(key, value) {
    if (storageAvailable) {
      try {
        global.localStorage.setItem(key, value);
        return true;
      } catch (e) {
        /* 配额/权限异常时降级为内存，保证游戏流程不中断 */
      }
    }
    memoryStore[key] = value;
    return false;
  }

  function removeRaw(key) {
    if (storageAvailable) {
      try {
        global.localStorage.removeItem(key);
      } catch (e) {
        /* ignore */
      }
    }
    delete memoryStore[key];
  }

  function parseJson(raw) {
    if (typeof raw !== 'string' || raw === '') return null;
    try {
      return JSON.parse(raw);
    } catch (e) {
      return null;
    }
  }

  /* ---------------- 存档校验 / 归一化 ---------------- */

  function normalizeBestTimes(raw) {
    var result = {};
    if (!isObject(raw)) return result;
    var keys = Object.keys(raw);
    var count = 0;
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      if (!/^\d+$/.test(key)) continue;
      var level = toInt(key, -1, 0, MAX_LEVEL_INDEX);
      if (level < 0) continue;
      var ms = toInt(raw[key], -1, 0, 86400000);
      if (ms < 0) continue;
      result[String(level)] = ms;
      count += 1;
      if (count >= MAX_BEST_TIME_KEYS) break;
    }
    return result;
  }

  function normalizeSave(raw) {
    var data = clone(DEFAULT_SAVE);
    if (!isObject(raw)) return data;
    if (toInt(raw.schema, -1, -1, 999) !== SCHEMA) {
      /* 未知 schema（未来的版本或损坏）：退回默认存档，避免把脏数据写回 */
      return data;
    }
    data.unlockedLevel = toInt(raw.unlockedLevel, 0, 0, MAX_LEVEL_INDEX);
    data.bestTimes = normalizeBestTimes(raw.bestTimes);
    data.totalTreasures = toInt(raw.totalTreasures, 0, 0, 1000000000);
    data.sound = raw.sound === false ? false : true;
    data.updatedAt = typeof raw.updatedAt === 'string' ? raw.updatedAt : '';
    return applyContentMigrations(data);
  }

  function normalizeSession(raw) {
    if (!isObject(raw)) return null;
    var username = typeof raw.username === 'string' ? raw.username.trim() : '';
    var guest = raw.guest === true || username === 'guest';
    var token = typeof raw.token === 'string' ? raw.token : '';
    if (!guest && !token) return null;
    if (!username) username = guest ? 'guest' : '';
    if (!username) return null;
    return {
      token: token,
      username: username,
      displayName: (typeof raw.displayName === 'string' && raw.displayName) ? raw.displayName : username,
      expiresAt: (typeof raw.expiresAt === 'string' && raw.expiresAt) ? raw.expiresAt : null,
      guest: guest,
      savedAt: typeof raw.savedAt === 'string' ? raw.savedAt : ''
    };
  }

  function isSessionExpired(session) {
    if (!session || session.guest) return false;
    if (!session.expiresAt) return false;
    var expires = Date.parse(session.expiresAt);
    if (!isFinite(expires)) return true;
    return expires <= Date.now();
  }

  /* ---------------- TQ.Save ---------------- */

  var Save = {

    DEFAULT: clone(DEFAULT_SAVE),

    /** 读取存档；缺失/损坏时返回默认存档（不抛异常）
     *  内容迁移（v1→v2 解锁第 4 关）若生效会立即写回，保证只迁移一次 */
    load: function () {
      var raw = parseJson(readRaw(SAVE_KEY));
      var data = normalizeSave(raw);
      if (isObject(raw) && toInt(raw.schema, -1, -1, 999) === SCHEMA) {
        var rawUnlocked = toInt(raw.unlockedLevel, 0, 0, MAX_LEVEL_INDEX);
        if (rawUnlocked < data.unlockedLevel) {
          data.updatedAt = localIsoNow();
          writeRaw(SAVE_KEY, JSON.stringify(data));
        }
      }
      return data;
    },

    /** 整体覆盖写入；返回实际写入的归一化存档 */
    save: function (data) {
      var next = normalizeSave(data);
      next.schema = SCHEMA;
      next.updatedAt = localIsoNow();
      writeRaw(SAVE_KEY, JSON.stringify(next));
      return clone(next);
    },

    /** 合并更新（bestTimes 按关卡合并，其余字段覆盖） */
    patch: function (partial) {
      var current = Save.load();
      if (isObject(partial)) {
        var keys = Object.keys(partial);
        for (var i = 0; i < keys.length; i++) {
          var key = keys[i];
          if (key === 'bestTimes' && isObject(partial.bestTimes)) {
            var levels = Object.keys(partial.bestTimes);
            for (var j = 0; j < levels.length; j++) {
              current.bestTimes[levels[j]] = partial.bestTimes[levels[j]];
            }
          } else if (key !== 'schema' && key !== 'updatedAt') {
            current[key] = partial[key];
          }
        }
      }
      return Save.save(current);
    },

    /** 重置为默认存档（保留登录态） */
    reset: function () {
      removeRaw(SAVE_KEY);
      return Save.load();
    },

    /** 读取登录态；无/损坏/过期返回 null（过期会顺手清理） */
    loadSession: function () {
      var session = normalizeSession(parseJson(readRaw(SESSION_KEY)));
      if (!session) {
        if (readRaw(SESSION_KEY) !== null) removeRaw(SESSION_KEY);
        return null;
      }
      if (isSessionExpired(session)) {
        removeRaw(SESSION_KEY);
        return null;
      }
      return session;
    },

    /** 保存登录态（游客也保存，便于刷新后继续试玩） */
    saveSession: function (session) {
      var next = normalizeSession(session);
      if (!next) return null;
      next.savedAt = localIsoNow();
      writeRaw(SESSION_KEY, JSON.stringify(next));
      return clone(next);
    },

    /** 清除登录态 */
    clearSession: function () {
      removeRaw(SESSION_KEY);
    },

    /** 判断登录态是否已过期（供 UI 兜底） */
    isSessionExpired: isSessionExpired,

    /** localStorage 是否可用（不可用时降级到内存，仅在当前页面生命周期有效） */
    isPersistent: function () {
      return storageAvailable;
    },

    /** 调试/测试辅助：暴露存储键 */
    STORAGE_KEYS: {
      save: SAVE_KEY,
      session: SESSION_KEY
    }
  };

  TQ.Save = Save;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = Save;
  }
})(typeof window !== 'undefined' ? window : globalThis);

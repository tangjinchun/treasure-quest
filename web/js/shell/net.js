/* 《寻宝奇兵》网络 / 更新模块（游戏外壳）
 * - apiBase 解析优先级：TQNative.getState().apiBase > URL ?api= > localStorage tq.apiBase
 *   > localhost 默认 http://127.0.0.1:3001 > 线上 https://zzysjqr.cn/treasure
 * - 浏览器 fetch 与 APP 原生桥（TQNative）双模式：
 *   login / checkVersion 走 fetch；APP 内检查更新、下载、重启则走 TQNative 事件
 * - 定义 window.TQNativeEvent(type, payload)，处理 ota_* 事件（docs/OTA.md 3.3/3.5）
 * - 对外接口：TQ.Net（见 docs/GAMEDESIGN.md 5.3）
 */
(function (global) {
  'use strict';

  var TQ = global.TQ = global.TQ || {};

  var LS_API_KEY = 'tq.apiBase';
  var LOCAL_DEFAULT = 'http://127.0.0.1:3001';
  var PROD_DEFAULT = 'https://zzysjqr.cn/treasure';
  var REQUEST_TIMEOUT = 10000;
  var VERSION_TIMEOUT = 8000;
  var VERSION_MANIFEST_TIMEOUT = 5000;

  var OTA_TYPES = ['ota_checking', 'ota_up_to_date', 'ota_available', 'ota_progress', 'ota_done', 'ota_error'];

  var nativeState = null;
  var nativeStateLoaded = false;
  var localManifest = null;
  var listeners = {};

  var ota = {
    phase: 'idle',          /* idle | checking | available | downloading | done | error */
    available: null,        /* {version, notes, size, publishedAt} */
    progress: null,         /* {phase, percent, received, total} */
    done: null,             /* {contentVersion, restartRequired} */
    error: null,            /* {code, message} */
    lastEventAt: 0
  };

  /* ---------------- 基础工具 ---------------- */

  function logInfo() {
    try {
      if (global.console && typeof global.console.info === 'function') {
        global.console.info.apply(global.console, ['[TQ.Net]'].concat(Array.prototype.slice.call(arguments)));
      }
    } catch (e) { /* ignore */ }
  }

  function logWarn() {
    try {
      if (global.console && typeof global.console.warn === 'function') {
        global.console.warn.apply(global.console, ['[TQ.Net]'].concat(Array.prototype.slice.call(arguments)));
      }
    } catch (e) { /* ignore */ }
  }

  function isObject(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
  }

  function trimBase(url) {
    if (typeof url !== 'string') return '';
    var value = url.trim();
    if (!value) return '';
    if (!/^https?:\/\/[^\s]+$/i.test(value)) return '';
    return value.replace(/\/+$/, '');
  }

  function storageGet(key) {
    try {
      return global.localStorage.getItem(key);
    } catch (e) {
      return null;
    }
  }

  function storageSet(key, value) {
    try {
      global.localStorage.setItem(key, value);
      return true;
    } catch (e) {
      return false;
    }
  }

  function storageRemove(key) {
    try {
      global.localStorage.removeItem(key);
    } catch (e) { /* ignore */ }
  }

  function queryParam(name) {
    try {
      if (global.URLSearchParams && global.location && global.location.search) {
        return new global.URLSearchParams(global.location.search).get(name) || '';
      }
      if (global.location && global.location.search) {
        var parts = global.location.search.replace(/^\?/, '').split('&');
        for (var i = 0; i < parts.length; i++) {
          var pair = parts[i].split('=');
          if (decodeURIComponent(pair[0] || '') === name) {
            return decodeURIComponent(pair[1] || '');
          }
        }
      }
    } catch (e) { /* ignore */ }
    return '';
  }

  /* ---------------- 原生桥 ---------------- */

  function getBridge() {
    try {
      var bridge = global.TQNative;
      if (bridge && typeof bridge === 'object') return bridge;
    } catch (e) { /* ignore */ }
    return null;
  }

  function refreshNativeState() {
    nativeStateLoaded = true;
    nativeState = null;
    var bridge = getBridge();
    if (!bridge || typeof bridge.getState !== 'function') return null;
    try {
      var raw = bridge.getState();
      var parsed = raw;
      if (typeof raw === 'string') {
        parsed = raw ? JSON.parse(raw) : null;
      }
      if (isObject(parsed)) nativeState = parsed;
    } catch (e) {
      logWarn('TQNative.getState() 解析失败：', e && e.message);
    }
    return nativeState;
  }

  function getNativeState() {
    if (!nativeStateLoaded) refreshNativeState();
    return nativeState;
  }

  function isNative() {
    return !!getBridge();
  }

  function isLocalhost() {
    try {
      var host = (global.location && global.location.hostname) || '';
      host = String(host).toLowerCase();
      return host === 'localhost' || host === '127.0.0.1' || host === '::1' ||
        host === '[::1]' || host === '0.0.0.0';
    } catch (e) {
      return false;
    }
  }

  /** 网络是否可用：优先 navigator.onLine，未知时按在线处理 */
  function isOnline() {
    try {
      if (global.navigator && typeof global.navigator.onLine === 'boolean') {
        return global.navigator.onLine;
      }
    } catch (e) { /* ignore */ }
    return true;
  }

  /* ---------------- apiBase ---------------- */

  function getApiBase() {
    /* 1) APP 原生桥运行时状态（OTA.md 3.3） */
    var state = getNativeState();
    if (state && trimBase(state.apiBase)) return trimBase(state.apiBase);

    /* 2) URL 查询参数 ?api=（本地联调覆盖） */
    var fromQuery = trimBase(queryParam('api'));
    if (fromQuery) return fromQuery;

    /* 3) localStorage tq.apiBase（调试可写） */
    var fromStorage = trimBase(storageGet(LS_API_KEY));
    if (fromStorage) return fromStorage;

    /* 4) 本地开发默认 / 5) 线上默认 */
    if (isLocalhost()) return LOCAL_DEFAULT;
    return PROD_DEFAULT;
  }

  /** 写入/清除 localStorage 的 apiBase 覆盖（仅调试用） */
  function setApiBaseOverride(url) {
    var base = trimBase(url);
    if (base) {
      storageSet(LS_API_KEY, base);
      return base;
    }
    storageRemove(LS_API_KEY);
    return getApiBase();
  }

  /* ---------------- HTTP ---------------- */

  function httpJson(url, options, timeoutMs) {
    options = options || {};
    return new Promise(function (resolve) {
      if (typeof global.fetch !== 'function') {
        resolve({
          ok: false, code: 'no_fetch', status: 0,
          message: '当前运行环境不支持 fetch，无法联网'
        });
        return;
      }

      var settled = false;
      var controller = null;
      var timer = null;

      function finish(result) {
        if (settled) return;
        settled = true;
        if (timer) global.clearTimeout(timer);
        resolve(result);
      }

      try {
        if (typeof global.AbortController === 'function') controller = new global.AbortController();
      } catch (e) {
        controller = null;
      }

      timer = global.setTimeout(function () {
        if (controller) {
          try { controller.abort(); } catch (e) { /* ignore */ }
        }
        finish({ ok: false, code: 'timeout', status: 0, message: '请求超时，请检查网络后重试' });
      }, timeoutMs || REQUEST_TIMEOUT);

      var fetchOptions = {
        method: options.method || 'GET',
        headers: options.headers || {},
        cache: 'no-store'
      };
      if (options.body !== undefined) fetchOptions.body = options.body;
      if (controller) fetchOptions.signal = controller.signal;

      var request;
      try {
        request = global.fetch(url, fetchOptions);
      } catch (e) {
        finish({ ok: false, code: 'network', status: 0, message: '网络异常，请检查网络连接' });
        return;
      }

      request.then(function (response) {
        var reader;
        try {
          reader = response.text();
        } catch (e) {
          finish({ ok: false, code: 'bad_response', status: response.status, message: '服务响应异常' });
          return;
        }
        reader.then(function (text) {
          var data = null;
          try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
          var code = null;
          var message = '';
          if (data && typeof data === 'object') {
            code = (typeof data.error === 'string' && data.error) ? data.error : null;
            message = (typeof data.message === 'string' && data.message) ? data.message : '';
          }
          if (response.ok && data && data.ok !== false) {
            finish({ ok: true, status: response.status, data: data, code: null, message: '' });
          } else {
            finish({
              ok: false,
              status: response.status,
              data: data,
              code: code || ('http_' + response.status),
              message: message
            });
          }
        }, function () {
          finish({ ok: false, code: 'bad_response', status: response.status, message: '服务响应异常' });
        });
      }, function (error) {
        var aborted = !!(error && (error.name === 'AbortError' || error.code === 20));
        finish({
          ok: false,
          status: 0,
          code: aborted ? 'timeout' : 'network',
          message: aborted ? '请求超时，请检查网络后重试' : '网络异常，请检查网络连接'
        });
      });
    });
  }

  /* ---------------- 运行环境信息 ---------------- */

  function getRuntimeInfo() {
    var state = getNativeState();
    var native = isNative();
    var manifest = localManifest;
    var info = {
      isNative: native,
      platform: native ? 'android' : 'web',
      appVersionCode: 0,
      appVersionName: '',
      contentVersion: 0,
      bundledContentVersion: 0,
      channel: 'test',
      deviceId: '',
      apiBase: getApiBase(),
      hasContentVersion: false
    };

    if (native && state) {
      info.appVersionCode = typeof state.appVersionCode === 'number' ? state.appVersionCode : 0;
      info.appVersionName = typeof state.appVersionName === 'string' ? state.appVersionName : '';
      info.contentVersion = typeof state.contentVersion === 'number' ? state.contentVersion : 0;
      info.bundledContentVersion = typeof state.bundledContentVersion === 'number' ? state.bundledContentVersion : info.contentVersion;
      info.channel = typeof state.channel === 'string' && state.channel ? state.channel : 'test';
      info.deviceId = typeof state.deviceId === 'string' ? state.deviceId : '';
      info.hasContentVersion = typeof state.contentVersion === 'number';
      if (typeof state.platform === 'string' && state.platform) info.platform = state.platform;
    } else if (manifest && typeof manifest.contentVersion === 'number') {
      info.contentVersion = manifest.contentVersion;
      info.bundledContentVersion = typeof manifest.contentVersion === 'number' ? manifest.contentVersion : 0;
      info.channel = typeof manifest.channel === 'string' && manifest.channel ? manifest.channel : 'test';
      info.hasContentVersion = true;
    }

    return info;
  }

  /** 读取当前内容包自带的 version.json（浏览器模式；APP 内以原生 getState 为准） */
  function loadLocalVersion() {
    if (isNative()) {
      refreshNativeState();
      return Promise.resolve(null);
    }
    if (localManifest) return Promise.resolve(localManifest);
    var url = 'version.json?t=' + Date.now();
    return httpJson(url, { method: 'GET' }, VERSION_MANIFEST_TIMEOUT).then(function (res) {
      if (res.ok && isObject(res.data) && typeof res.data.contentVersion === 'number') {
        localManifest = res.data;
      } else if (!res.ok) {
        logWarn('读取本地 version.json 失败：', res.code || res.message);
      }
      return localManifest;
    }, function () {
      return null;
    });
  }

  /* ---------------- 登录 ---------------- */

  function normalizeLoginResult(data) {
    return {
      ok: true,
      token: typeof data.token === 'string' ? data.token : '',
      displayName: (typeof data.displayName === 'string' && data.displayName) ? data.displayName : '',
      username: (typeof data.username === 'string' && data.username) ? data.username : '',
      expiresAt: (typeof data.expiresAt === 'string' && data.expiresAt) ? data.expiresAt : null
    };
  }

  function nativeLogin(bridge, username, password) {
    if (typeof bridge.login !== 'function') return null;
    try {
      var raw = bridge.login(username, password);
      var data = typeof raw === 'string' ? (raw ? JSON.parse(raw) : null) : raw;
      if (!isObject(data)) return null;
      if (data.ok === false || data.token === undefined) {
        return {
          ok: false,
          code: typeof data.error === 'string' ? data.error : 'invalid_credentials',
          message: typeof data.message === 'string' ? data.message : ''
        };
      }
      return normalizeLoginResult(data);
    } catch (e) {
      logWarn('原生登录桥调用失败，回退 fetch：', e && e.message);
      return null;
    }
  }

  /** 登录：APP 内若有原生 login 桥则优先，否则 fetch；始终 resolve，不 reject */
  function login(username, password) {
    var user = typeof username === 'string' ? username.trim() : '';
    var pass = typeof password === 'string' ? password : '';
    if (!user || !pass) {
      return Promise.resolve({ ok: false, code: 'empty', message: '请输入账号和密码' });
    }
    if (!isOnline()) {
      return Promise.resolve({ ok: false, code: 'offline', message: '当前处于离线状态，请先连接网络或游客试玩' });
    }
    var base = getApiBase();
    if (!base) {
      return Promise.resolve({ ok: false, code: 'bad_config', message: '服务器地址无效' });
    }

    var bridge = getBridge();
    if (bridge) {
      var nativeResult = nativeLogin(bridge, user, pass);
      if (nativeResult) return Promise.resolve(nativeResult);
    }

    var url = base + '/api/login';
    return httpJson(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: user, password: pass })
    }, REQUEST_TIMEOUT).then(function (res) {
      if (res.ok) {
        var result = normalizeLoginResult(res.data || {});
        if (!result.displayName) result.displayName = user;
        if (!result.username) result.username = user;
        return result;
      }
      return {
        ok: false,
        code: res.code || 'network',
        status: res.status || 0,
        message: res.message || ''
      };
    });
  }

  /* ---------------- 版本检查（fetch 模式） ---------------- */

  function buildVersionQuery() {
    var info = getRuntimeInfo();
    var params = [];
    params.push('platform=' + encodeURIComponent(info.isNative ? 'android' : 'web'));
    if (info.isNative) params.push('shell=' + encodeURIComponent(String(info.appVersionCode || 0)));
    params.push('content=' + encodeURIComponent(String(info.contentVersion || 0)));
    params.push('channel=' + encodeURIComponent(info.channel || 'test'));
    return params.join('&');
  }

  function versionFailure(code, message) {
    return {
      ok: false,
      error: code || 'network',
      message: message || '检查更新失败',
      content: null,
      updateAvailable: false,
      currentContentVersion: getRuntimeInfo().contentVersion || 0
    };
  }

  /**
   * 检查内容版本（浏览器 fetch；APP 内也可用于展示）。
   * resolve 的 manifest 在服务端响应基础上附加：
   *   updateAvailable / currentContentVersion
   */
  function checkVersion() {
    var base = getApiBase();
    if (!base) return Promise.resolve(versionFailure('bad_config', '服务器地址无效'));
    if (!isOnline()) return Promise.resolve(versionFailure('offline', '当前处于离线状态'));
    var url = base + '/api/version?' + buildVersionQuery();
    return httpJson(url, { method: 'GET' }, VERSION_TIMEOUT).then(function (res) {
      if (!res.ok) {
        return versionFailure(res.code || 'network', res.message || '检查更新失败');
      }
      var data = res.data || {};
      var info = getRuntimeInfo();
      var current = info.contentVersion || 0;
      var content = (data.content && typeof data.content.version === 'number') ? data.content : null;
      var updateAvailable = false;
      var reason = '';
      if (content && content.version > current) {
        var minShell = typeof content.minShellVersion === 'number' ? content.minShellVersion : 0;
        var shellCode = info.appVersionCode || (info.isNative ? 0 : 999);
        if (minShell && shellCode < minShell) {
          reason = 'shell_too_old';
        } else {
          updateAvailable = true;
        }
      }
      data.ok = true;
      data.content = content;
      data.currentContentVersion = current;
      data.updateAvailable = updateAvailable;
      data.reason = reason;
      return data;
    });
  }

  /* ---------------- 原生 OTA ---------------- */

  function checkUpdateViaNative() {
    var bridge = getBridge();
    return !!(bridge && typeof bridge.checkUpdate === 'function');
  }

  function callNative(methodName) {
    var bridge = getBridge();
    if (!bridge || typeof bridge[methodName] !== 'function') return false;
    try {
      bridge[methodName]();
      return true;
    } catch (e) {
      logWarn('调用 TQNative.' + methodName + '() 失败：', e && e.message);
      return false;
    }
  }

  function startNativeCheck() {
    var started = callNative('checkUpdate');
    if (started) {
      ota.phase = 'checking';
      ota.error = null;
    }
    return started;
  }

  function startNativeDownload() {
    var started = callNative('downloadUpdate');
    if (started && ota.available) {
      ota.phase = 'downloading';
      ota.progress = { phase: 'download', percent: 0, received: 0, total: ota.available.size || 0 };
    }
    return started;
  }

  function restartApp() {
    return callNative('restartApp');
  }

  function openExternal(url) {
    var bridge = getBridge();
    if (bridge && typeof bridge.openExternal === 'function' && typeof url === 'string' && /^https?:\/\//i.test(url)) {
      try {
        bridge.openExternal(url);
        return true;
      } catch (e) { /* ignore */ }
    }
    if (typeof global.open === 'function') {
      try {
        global.open(url, '_blank');
        return true;
      } catch (e) { /* ignore */ }
    }
    return false;
  }

  function normalizeAvailable(payload) {
    payload = isObject(payload) ? payload : {};
    return {
      version: typeof payload.version === 'number' ? payload.version : (typeof payload.contentVersion === 'number' ? payload.contentVersion : 0),
      notes: typeof payload.notes === 'string' ? payload.notes : '',
      size: typeof payload.size === 'number' ? payload.size : 0,
      publishedAt: typeof payload.publishedAt === 'string' ? payload.publishedAt : '',
      minShellVersion: typeof payload.minShellVersion === 'number' ? payload.minShellVersion : 0
    };
  }

  /* ---------------- 事件总线 ---------------- */

  function emit(type, payload) {
    var list = listeners[type];
    var wildcard = listeners['*'];
    var i;
    if (list) {
      list = list.slice();
      for (i = 0; i < list.length; i++) {
        try { list[i](payload, type); } catch (e) { logWarn('监听器异常(' + type + ')：', e && e.message); }
      }
    }
    if (wildcard) {
      wildcard = wildcard.slice();
      for (i = 0; i < wildcard.length; i++) {
        try { wildcard[i](payload, type); } catch (e) { logWarn('通配监听器异常(' + type + ')：', e && e.message); }
      }
    }
  }

  function addListener(type, handler) {
    if (typeof handler !== 'function' || typeof type !== 'string' || !type) return false;
    if (!listeners[type]) listeners[type] = [];
    listeners[type].push(handler);
    return true;
  }

  function removeListener(type, handler) {
    var list = listeners[type];
    if (!list) return false;
    for (var i = list.length - 1; i >= 0; i--) {
      if (list[i] === handler) list.splice(i, 1);
    }
    return true;
  }

  function getOtaState() {
    return {
      phase: ota.phase,
      available: ota.available ? { version: ota.available.version, notes: ota.available.notes, size: ota.available.size, publishedAt: ota.available.publishedAt } : null,
      progress: ota.progress ? { phase: ota.progress.phase, percent: ota.progress.percent, received: ota.progress.received, total: ota.progress.total } : null,
      done: ota.done ? { contentVersion: ota.done.contentVersion, restartRequired: ota.done.restartRequired !== false } : null,
      error: ota.error ? { code: ota.error.code, message: ota.error.message } : null,
      lastEventAt: ota.lastEventAt
    };
  }

  function resetOtaState() {
    ota.phase = 'idle';
    ota.available = null;
    ota.progress = null;
    ota.done = null;
    ota.error = null;
    ota.lastEventAt = 0;
  }

  /** window.TQNativeEvent 的统一入口（OTA.md 3.3） */
  function onNativeEvent(type, payload) {
    var eventType = String(type || '');
    if (OTA_TYPES.indexOf(eventType) < 0) {
      logWarn('未知原生事件：', eventType);
      return;
    }
    var data = isObject(payload) ? payload : {};
    ota.lastEventAt = Date.now();

    switch (eventType) {
      case 'ota_checking':
        ota.phase = 'checking';
        ota.error = null;
        ota.progress = null;
        break;
      case 'ota_up_to_date':
        ota.phase = 'idle';
        ota.available = null;
        ota.error = null;
        ota.progress = null;
        break;
      case 'ota_available':
        ota.phase = 'available';
        ota.available = normalizeAvailable(data);
        ota.error = null;
        ota.progress = null;
        break;
      case 'ota_progress':
        ota.phase = 'downloading';
        ota.progress = {
          phase: typeof data.phase === 'string' ? data.phase : 'download',
          percent: typeof data.percent === 'number' ? Math.max(0, Math.min(100, data.percent)) : 0,
          received: typeof data.received === 'number' ? data.received : 0,
          total: typeof data.total === 'number' ? data.total : 0
        };
        break;
      case 'ota_done':
        ota.phase = 'done';
        ota.progress = null;
        ota.done = {
          contentVersion: typeof data.contentVersion === 'number' ? data.contentVersion : (ota.available ? ota.available.version : 0),
          restartRequired: data.restartRequired !== false
        };
        break;
      case 'ota_error':
        ota.phase = 'error';
        ota.error = {
          code: typeof data.code === 'string' ? data.code : 'unknown',
          message: typeof data.message === 'string' ? data.message : ''
        };
        ota.progress = null;
        break;
      default:
        break;
    }

    emit(eventType, data);
  }

  /* ---------------- 对外接口 ---------------- */

  TQ.Net = {
    /* ---- 契约接口（GAMEDESIGN 5.3） ---- */
    getApiBase: getApiBase,
    login: login,
    checkVersion: checkVersion,
    checkUpdateViaNative: checkUpdateViaNative,
    onNativeEvent: onNativeEvent,
    isOnline: isOnline,

    /* ---- 游戏外壳 内部扩展 ---- */
    isNative: isNative,
    getNativeState: getNativeState,
    refreshNativeState: refreshNativeState,
    getRuntimeInfo: getRuntimeInfo,
    loadLocalVersion: loadLocalVersion,
    getLocalManifest: function () { return localManifest ? JSON.parse(JSON.stringify(localManifest)) : null; },
    setLocalManifest: function (manifest) { if (isObject(manifest)) localManifest = manifest; return localManifest; },
    setApiBaseOverride: setApiBaseOverride,
    startNativeCheck: startNativeCheck,
    startNativeDownload: startNativeDownload,
    restartApp: restartApp,
    openExternal: openExternal,
    addListener: addListener,
    removeListener: removeListener,
    getOtaState: getOtaState,
    resetOtaState: resetOtaState
  };

  /* ---------------- 全局原生事件入口 ---------------- */

  global.TQNativeEvent = function (type, payload) {
    try {
      var eventType = String(type || '');
      var data = payload;
      if (typeof data === 'string') {
        try { data = data ? JSON.parse(data) : {}; } catch (e) { data = {}; }
      }
      if (!isObject(data)) data = {};
      TQ.Net.onNativeEvent(eventType, data);
    } catch (e) {
      logWarn('window.TQNativeEvent 处理异常：', e && e.message);
    }
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = TQ.Net;
  }
})(typeof window !== 'undefined' ? window : globalThis);

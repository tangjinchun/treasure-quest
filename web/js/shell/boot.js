/* 《寻宝奇兵》启动模块（游戏外壳）
 * - DOMContentLoaded 后调用 TQ.Boot.start()，组装 Save / Net / UI / Game
 * - 处理首页选择：有未过期登录态 → 主菜单，否则登录页
 * - 启动 3 秒后静默检查更新：只在设置入口显示红点，不打断玩家
 * - 安卓返回键入口：window.TQ.Shell.onAndroidBack()
 * - core 未加载时仍可浏览界面，开始关卡会提示「游戏模块加载中」
 */
(function (global) {
  'use strict';

  var TQ = global.TQ = global.TQ || {};
  var doc = global.document;

  var SILENT_CHECK_DELAY = 3000;
  var MIN_BOOT_MS = 550;

  var started = false;
  var gameReady = false;
  var silentCheckTimer = null;

  /* =======================================================================
   * 日志
   * ===================================================================== */

  function logWarn() {
    try {
      if (global.console && global.console.warn) {
        global.console.warn.apply(global.console, ['[TQ.Boot]'].concat(Array.prototype.slice.call(arguments)));
      }
    } catch (e) { /* ignore */ }
  }

  function logError() {
    try {
      if (global.console && global.console.error) {
        global.console.error.apply(global.console, ['[TQ.Boot]'].concat(Array.prototype.slice.call(arguments)));
      }
    } catch (e) { /* ignore */ }
  }

  /* =======================================================================
   * 游戏核心装配
   * ===================================================================== */

  function getGameCanvas() {
    return doc ? doc.getElementById('game-canvas') : null;
  }

  function onGameEvent(event) {
    try {
      if (TQ.UI && typeof TQ.UI.onGameEvent === 'function') {
        TQ.UI.onGameEvent(event || {});
      }
    } catch (e) {
      logError('游戏事件处理异常：', e);
    }
  }

  function initGame() {
    if (gameReady) return true;

    var canvas = getGameCanvas();
    if (!canvas) {
      logWarn('未找到 #game-canvas，跳过 TQ.Game.init');
      return false;
    }
    if (!TQ.Game || typeof TQ.Game.init !== 'function') {
      logWarn('未检测到 TQ.Game.init（游戏核心尚未加载）；界面仍可浏览，开始关卡会提示加载中');
      return false;
    }

    try {
      TQ.Game.init({ canvas: canvas, onEvent: onGameEvent });
      gameReady = true;
      return true;
    } catch (e) {
      gameReady = false;
      logError('TQ.Game.init 调用失败：', e);
      return false;
    }
  }

  /** core 晚于 shell 加载时，可从控制台调用 TQ.Boot.retryInitGame() 重新装配 */
  function retryInitGame() {
    var result = initGame();
    if (TQ.UI && typeof TQ.UI.setBootStep === 'function') {
      TQ.UI.setBootStep(result ? 'ready' : 'game');
    }
    return result;
  }

  /* =======================================================================
   * 安卓返回键入口：由 Java 调用 window.TQ.Shell.onAndroidBack()
   * ===================================================================== */

  function onAndroidBack() {
    try {
      if (TQ.UI && typeof TQ.UI.onAndroidBack === 'function') {
        return !!TQ.UI.onAndroidBack();
      }
    } catch (e) {
      logError('返回键处理异常：', e);
    }
    return false;
  }

  /* 安卓 Activity.onPause / onResume（Java 存在才调用） */
  function onAppPause() {
    try {
      if (TQ.UI && typeof TQ.UI.onAppPause === 'function') {
        TQ.UI.onAppPause();
      }
    } catch (e) {
      logError('onPause 处理异常：', e);
    }
  }

  function onAppResume() {
    try {
      if (TQ.UI && typeof TQ.UI.onAppResume === 'function') {
        TQ.UI.onAppResume();
      }
    } catch (e) {
      logError('onResume 处理异常：', e);
    }
  }

  /* =======================================================================
   * 启动 3 秒静默检查更新（仅红点）
   * ===================================================================== */

  function silentUpdateCheck() {
    if (!TQ.Net) return;

    /* APP 模式（存在 TQNative）：冷启动静默检查由原生 MainActivity 在启动 3s 后发起（OTA 契约），
       JS 侧不再调用 checkUpdate，避免启动时重复请求 /api/version；
       原生检查结果仍通过 ota_* 事件进入 TQ.Net / TQ.UI，仅点亮设置页红点。 */
    var nativeAvailable = false;
    try {
      nativeAvailable = typeof TQ.Net.checkUpdateViaNative === 'function' && TQ.Net.checkUpdateViaNative();
    } catch (e) {
      nativeAvailable = false;
    }
    if (nativeAvailable) return;

    /* 浏览器模式：fetch /api/version（本地联调/演示），仅在有新版时点亮红点 */
    try {
      if (typeof TQ.Net.isOnline === 'function' && !TQ.Net.isOnline()) return;
    } catch (e) { /* ignore */ }
    if (typeof TQ.Net.checkVersion !== 'function') return;

    TQ.Net.checkVersion().then(function (result) {
      if (!result || !result.ok || !result.content) return;
      if (!result.updateAvailable) return;
      try {
        if (TQ.UI && typeof TQ.UI.setUpdateAvailable === 'function') {
          TQ.UI.setUpdateAvailable({
            version: result.content.version,
            notes: result.content.notes,
            size: result.content.size,
            publishedAt: result.content.publishedAt
          });
        }
      } catch (e) {
        logWarn('静默更新结果渲染失败：', e);
      }
    }, function () {
      /* 静默检查失败不打扰玩家 */
    });
  }

  function scheduleSilentCheck() {
    if (silentCheckTimer) return;
    silentCheckTimer = global.setTimeout(function () {
      silentCheckTimer = null;
      silentUpdateCheck();
    }, SILENT_CHECK_DELAY);
  }

  /* =======================================================================
   * 启动流程
   * ===================================================================== */

  function wait(ms) {
    return new Promise(function (resolve) {
      global.setTimeout(resolve, ms);
    });
  }

  function loadVersionInfo() {
    if (!TQ.Net || typeof TQ.Net.loadLocalVersion !== 'function') return Promise.resolve(null);
    try {
      return TQ.Net.loadLocalVersion().then(function (manifest) {
        return manifest || null;
      }, function () {
        return null;
      });
    } catch (e) {
      return Promise.resolve(null);
    }
  }

  function enterInitialScreen() {
    var session = null;
    try {
      if (TQ.UI && typeof TQ.UI.getSavedSession === 'function') {
        session = TQ.UI.getSavedSession();
      } else if (TQ.Save && typeof TQ.Save.loadSession === 'function') {
        session = TQ.Save.loadSession();
      }
    } catch (e) {
      session = null;
    }

    if (session && !(TQ.Save && typeof TQ.Save.isSessionExpired === 'function' && TQ.Save.isSessionExpired(session))) {
      TQ.UI.enterMenu(session);
    } else {
      TQ.UI.showLogin();
    }
  }

  function start() {
    if (started) return;
    started = true;

    if (TQ.UI && typeof TQ.UI.init === 'function') {
      try {
        TQ.UI.init();
      } catch (e) {
        logError('TQ.UI.init 调用失败：', e);
      }
    } else {
      logError('未检测到 TQ.UI.init，界面无法初始化');
    }

    if (TQ.UI && typeof TQ.UI.setBootStep === 'function') TQ.UI.setBootStep('save');

    var bootPromise = Promise.all([wait(MIN_BOOT_MS), loadVersionInfo()]);
    bootPromise.then(function () {
      if (TQ.UI && typeof TQ.UI.setBootStep === 'function') TQ.UI.setBootStep('version');
      if (TQ.UI && typeof TQ.UI.refreshVersionInfo === 'function') {
        try { TQ.UI.refreshVersionInfo(); } catch (e) { logWarn('版本信息刷新失败：', e); }
      }

      var ready = initGame();
      if (TQ.UI && typeof TQ.UI.setBootStep === 'function') {
        TQ.UI.setBootStep(ready ? 'ready' : 'game');
      }

      try {
        enterInitialScreen();
      } catch (e) {
        logError('进入初始界面失败：', e);
        if (TQ.UI && typeof TQ.UI.showLogin === 'function') TQ.UI.showLogin();
      }

      scheduleSilentCheck();

      if (doc && doc.documentElement) {
        doc.documentElement.setAttribute('data-tq-ready', '1');
      }
      if (doc && typeof global.CustomEvent === 'function') {
        try {
          doc.dispatchEvent(new global.CustomEvent('tq:booted'));
        } catch (e) { /* ignore */ }
      }
    }, function (e) {
      logError('启动流程异常：', e);
      if (TQ.UI && typeof TQ.UI.showLogin === 'function') TQ.UI.showLogin();
    });
  }

  /* =======================================================================
   * 对外接口
   * ===================================================================== */

  TQ.Boot = {
    start: start,
    isGameReady: function () { return gameReady; },
    isStarted: function () { return started; },
    retryInitGame: retryInitGame
  };

  /* 安卓 WebView：Java 调用 window.TQ.Shell.onAndroidBack() / onPause() / onResume() */
  TQ.Shell = {
    onAndroidBack: onAndroidBack,
    onPause: onAppPause,
    onResume: onAppResume,
    isGameReady: function () { return gameReady; }
  };

  /* 自动化测试探测标记（可选，供 Edge + puppeteer 使用） */
  global.TQ_TEST_HOOKS = {
    version: 1,
    isBooted: function () { return started; },
    isGameReady: function () { return gameReady; },
    getScreen: function () {
      try {
        if (TQ.UI && typeof TQ.UI.getDebugState === 'function') return TQ.UI.getDebugState().screen;
      } catch (e) { /* ignore */ }
      return 'boot';
    },
    getState: function () {
      try {
        if (TQ.UI && typeof TQ.UI.getDebugState === 'function') return TQ.UI.getDebugState();
      } catch (e) { /* ignore */ }
      return { screen: 'boot' };
    },
    getApiBase: function () {
      try {
        if (TQ.Net && typeof TQ.Net.getApiBase === 'function') return TQ.Net.getApiBase();
      } catch (e) { /* ignore */ }
      return '';
    },
    onAndroidBack: onAndroidBack
  };

  /* DOMContentLoaded 后自动启动（TQ.Boot.start 也可被外部调用，重复调用安全） */
  if (doc) {
    if (doc.readyState === 'loading') {
      doc.addEventListener('DOMContentLoaded', start);
    } else {
      global.setTimeout(start, 0);
    }
  }
})(typeof window !== 'undefined' ? window : globalThis);

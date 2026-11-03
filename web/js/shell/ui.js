/* 《寻宝奇兵》界面模块（游戏外壳）
 * - 负责：启动页 / 登录 / 主菜单 / 选关（锁定态）/ 设置 / 游戏层 / 暂停·死亡·通关覆盖层 / 更新弹窗
 * - 事件接线：把 TQ.Game 的 onEvent 映射为界面行为（通关解锁+存档、死亡重开、暂停、提示）
 * - 更新 UI：APP 内走 TQNative 事件（ota_*），浏览器 fetch /api/version 演示
 * - 中文文案统一集中在 STR 表；不绘制 canvas，HUD 由 core 负责
 * - 对外接口：TQ.UI（见 docs/GAMEDESIGN.md 5.3）
 */
(function (global) {
  'use strict';

  var TQ = global.TQ = global.TQ || {};
  var doc = global.document;

  /* =======================================================================
   * 中文文案表（统一管理，便于后续国际化）
   * ===================================================================== */
  var STR = {
    appTitle: '寻宝奇兵',
    appSlogan: '深入遗迹 · 收集星辰碎片',

    /* 启动 */
    bootStarting: '正在初始化…',
    bootSave: '读取本地存档…',
    bootVersion: '加载版本信息…',
    bootReady: '准备就绪',
    bootGameModule: '游戏模块加载中…',

    /* 登录 */
    loginSubtitle: '登录以验证测试链路，或直接游客试玩',
    loginUserLabel: '账号',
    loginUserPlaceholder: '请输入账号',
    loginPasswordLabel: '密码',
    loginPasswordPlaceholder: '请输入密码',
    loginSubmit: '登录',
    loginSubmitting: '登录中…',
    loginGuest: '游客试玩',
    loginTestTip: '测试账号：admin / 123456',
    loginGuestTip: '游客模式离线可玩，进度自动保存在本机',
    loginErrorEmpty: '请输入账号和密码',
    loginErrorInvalid: '账号或密码错误，请重试',
    loginErrorNetwork: '网络异常，请检查网络后重试（也可先游客试玩）',
    loginErrorOffline: '当前处于离线状态，可先游客试玩',
    loginErrorTooMany: '尝试次数过多，请稍后再试',
    loginErrorUnknown: '登录失败，请稍后重试',
    toastLoginSuccess: '登录成功，欢迎回来',

    /* 版本通用 */
    versionFooter: '内容版本 v{version} · {mode}',
    versionFooterWeb: '内容版本 v{version} · 浏览器模式',
    versionFooterApp: '内容版本 v{version} · 安卓 APP',
    modeWeb: '浏览器',
    modeApp: '安卓 APP',
    versionUnknown: '版本信息未知',

    /* 主菜单 */
    menuWelcome: '欢迎，{name}',
    menuPlay: '开始冒险',
    menuLevels: '选择关卡',
    menuSettings: '设置',
    menuLogout: '退出登录',
    menuProgress: '已解锁 {unlocked}/{total} 关 · 累计宝物 {treasures}',
    toastGuest: '已进入游客试玩，进度保存在本机',
    toastLogout: '已退出登录',

    /* 选关 */
    levelsTitle: '选择关卡',
    levelsTip: '通关后解锁下一关；失败或退出不扣进度',
    levelsLocked: '未解锁',
    levelsBest: '最佳 {time}',
    levelsNoBest: '暂无记录',
    levelsProgress: '已解锁 {unlocked}/{total}',
    levelsStart: '进入',
    levelFallbackName: '第 {index} 关',
    toastLevelLocked: '该关卡尚未解锁，先通关上一关吧',
    toastGameNotReady: '游戏模块加载中，请稍后再试',
    toastGameError: '关卡启动失败，请重试',

    /* 通用 */
    commonBack: '返回',

    /* 设置 */
    settingsTitle: '设置',
    settingsSound: '音效',
    settingsSoundDesc: '攻击、收集与受击音效',
    settingsResetSave: '重置游戏进度',
    settingsResetSaveDesc: '清空关卡解锁与最佳记录，不影响登录状态',
    settingsResetSaveBtn: '重置',
    settingsResetConfirm: '确定要清除本机游戏进度吗？此操作不可恢复。',
    settingsResetDone: '已重置游戏进度',
    toastSoundOn: '音效已开启',
    toastSoundOff: '音效已关闭',
    settingsVersionTitle: '版本与更新',
    settingsContentVersion: '内容版本',
    settingsBuiltinVersion: '内置版本',
    settingsRuntime: '运行环境',
    settingsCheckUpdate: '检查更新',
    settingsChecking: '正在检查更新…',
    settingsUpToDate: '当前已是最新版本',
    settingsShellTooOld: '发现新内容，但需要先升级 APP 版本',
    settingsUpdateFound: '发现新版本 v{version}',
    settingsUpdateError: '检查更新失败：{message}',
    settingsUpdateHintWeb: '浏览器模式仅演示版本检查结果，无法应用更新；请在安卓 APP 内检查并下载更新。',
    settingsUpdateHintApp: '下载完成后需要重启 APP 才能让新内容生效。',

    /* 更新弹窗 */
    updateTitle: '发现新版本',
    updateVersion: '内容版本 v{version}',
    updateSize: '更新包大小约 {size}',
    updateNotesTitle: '更新内容',
    updateNotesDefault: '修复问题与体验优化。',
    updateDownload: '下载更新',
    updateLater: '稍后再说',
    updateRestart: '立即重启生效',
    updateDownloading: '正在下载更新…',
    updateVerifying: '正在校验更新包…',
    updateUnzipping: '正在安装更新…',
    updateDone: '更新已就绪，重启 APP 后生效',
    updateDoneToast: '内容更新已下载完成',
    updateProgress: '{phase} {percent}%',
    toastUpdateFound: '发现新版本 v{version}',
    toastRestartHint: '更新已下载，重启 APP 后生效',
    toastRestartFailed: '重启调用失败，请手动重启 APP',
    otaErrors: {
      network: '网络异常，请检查网络后重试',
      sha256_mismatch: '更新包校验失败，已保留当前版本',
      unzip_failed: '更新包安装失败，请稍后重试',
      too_large: '更新包超出大小限制，无法下载',
      not_available: '当前没有可用的更新包',
      unknown: '更新失败，请稍后重试'
    },

    /* 游戏内覆盖层 */
    gamePause: '已暂停',
    gamePauseDesc: '按 ESC 或点击继续回到探险',
    gameResume: '继续游戏',
    gameRestart: '重开本关',
    gameBackMenu: '返回主菜单',
    deathTitle: '探险失败',
    deathDesc: '第 {level} 关血量耗尽，本关收集进度不保存',
    deathRetry: '重开本关',
    completeTitle: '关卡完成',
    completeDesc: '第 {level} 关 · {name}',
    completeAll: '恭喜！全部关卡已通关',
    completeTime: '用时',
    completeTreasures: '宝物',
    completeHp: '剩余生命',
    completeNext: '下一关',
    completeReplay: '重玩本关',
    completeLast: '返回主菜单',
    toastKey: '获得钥匙',
    toastDoor: '门已打开'
  };

  /* 兜底展示文案：仅在 core（TQ.Game / TQ.Levels）尚未就绪、拿不到关卡名时使用。
   * 关卡数量与顺序始终以 core 动态数据为准（v2 起为 4 关，后续还可能增长），不写死。 */
  var LEVEL_FALLBACK = [
    { name: '迷雾森林', theme: '森林绿地' },
    { name: '幽暗洞窟', theme: '洞穴暗色' },
    { name: '失落神殿', theme: '遗迹金色' },
    { name: '云端秘殿', theme: '云端遗迹' }
  ];

  /* core 的 theme 可能是内部代号（forest/cave/temple/cloud），映射为中文展示 */
  var LEVEL_THEME_LABELS = {
    forest: '森林绿地',
    cave: '洞穴暗色',
    temple: '遗迹金色',
    ruins: '遗迹金色',
    cloud: '云端遗迹',
    clouds: '云端遗迹',
    sky: '云端遗迹'
  };

  /* =======================================================================
   * 内部状态
   * ===================================================================== */
  var initialized = false;
  var els = {};
  var state = {
    screen: 'boot',
    session: null,
    save: null,
    currentLevel: 0,
    currentTreasures: 0,
    currentHp: 0,
    maxHp: 3,
    overlay: null,            /* null | 'pause' | 'death' | 'complete' */
    audioMutedByLifecycle: false,
    update: {
      checking: false,
      explicit: false,
      modalOpen: false,
      modalMode: 'browser',   /* 'browser' | 'native' */
      downloading: false,
      available: null,
      progress: null,
      done: null,
      error: null,
      status: { text: '', kind: '' }
    }
  };

  /* =======================================================================
   * 小工具
   * ===================================================================== */

  function $(id) {
    return doc ? doc.getElementById(id) : null;
  }

  function text(node, value) {
    if (node) node.textContent = (value === null || value === undefined) ? '' : String(value);
  }

  function setHidden(node, hidden) {
    if (node) node.hidden = !!hidden;
  }

  function escapeHtml(value) {
    return String(value === null || value === undefined ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function fmt(template, data) {
    return String(template).replace(/\{(\w+)\}/g, function (match, key) {
      return (data && data[key] !== null && data[key] !== undefined) ? String(data[key]) : match;
    });
  }

  function pad2(n) {
    return (n < 10 ? '0' : '') + n;
  }

  function fmtTime(ms) {
    var totalMs = typeof ms === 'number' && isFinite(ms) ? Math.max(0, ms) : 0;
    var totalSec = Math.floor(totalMs / 1000);
    var minutes = Math.floor(totalSec / 60);
    var seconds = totalSec % 60;
    var tenths = Math.floor((totalMs % 1000) / 100);
    return pad2(minutes) + ':' + pad2(seconds) + '.' + tenths;
  }

  function fmtSize(bytes) {
    var n = typeof bytes === 'number' && isFinite(bytes) ? bytes : 0;
    if (n <= 0) return '--';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(2) + ' MB';
  }

  function setClass(node, className, condition) {
    if (!node) return;
    if (condition) node.classList.add(className);
    else node.classList.remove(className);
  }

  function toInt(value, fallback) {
    var n = typeof value === 'number' ? value : parseInt(value, 10);
    return (typeof n === 'number' && isFinite(n)) ? Math.floor(n) : fallback;
  }

  function getSaveModule() {
    return TQ.Save || null;
  }

  function loadSave() {
    var save = null;
    try {
      save = TQ.Save ? TQ.Save.load() : null;
    } catch (e) {
      save = null;
    }
    if (!save) {
      save = {
        schema: 1, unlockedLevel: 0, bestTimes: {}, totalTreasures: 0, sound: true, updatedAt: ''
      };
    }
    state.save = save;
    return save;
  }

  /* =======================================================================
   * i18n：把 STR 文案写入 DOM（data-i18n 系列属性）
   * ===================================================================== */

  function applyI18n() {
    if (!doc) return;

    var nodes = doc.querySelectorAll('[data-i18n]');
    for (var i = 0; i < nodes.length; i++) {
      var key = nodes[i].getAttribute('data-i18n');
      if (Object.prototype.hasOwnProperty.call(STR, key) && typeof STR[key] === 'string') {
        nodes[i].textContent = STR[key];
      }
    }

    var attrs = [
      ['data-i18n-placeholder', 'placeholder'],
      ['data-i18n-aria-label', 'aria-label'],
      ['data-i18n-title', 'title']
    ];
    for (var a = 0; a < attrs.length; a++) {
      var selector = '[' + attrs[a][0] + ']';
      var attrName = attrs[a][1];
      var matched = doc.querySelectorAll(selector);
      for (var m = 0; m < matched.length; m++) {
        var propKey = matched[m].getAttribute(attrs[a][0]);
        if (Object.prototype.hasOwnProperty.call(STR, propKey) && typeof STR[propKey] === 'string') {
          matched[m].setAttribute(attrName, STR[propKey]);
        }
      }
    }

    if (doc.title !== undefined) doc.title = STR.appTitle;
  }

  /* =======================================================================
   * 关卡元信息（优先使用 core 暴露的关卡数据，兜底内置名称）
   * ===================================================================== */

  function getCoreLevelList() {
    var holders = [TQ.Levels, TQ.LevelData, TQ.LevelsData];
    var arrayKeys = ['LEVELS', 'levels', 'LIST', 'list', 'DATA', 'data'];
    for (var h = 0; h < holders.length; h++) {
      var holder = holders[h];
      if (!holder) continue;
      if (Array.isArray(holder)) return holder;
      if (typeof holder !== 'object') continue;
      for (var k = 0; k < arrayKeys.length; k++) {
        var value = holder[arrayKeys[k]];
        if (Array.isArray(value) && value.length > 0) return value;
      }
    }
    return null;
  }

  /** 关卡数量：以 core 动态数据为准（TQ.Game.getLevelCount 优先，TQ.Levels.length 兜底），
   *  v2 起为 4 关；shell 不写死关卡数。 */
  function getLevelCount() {
    try {
      if (TQ.Game && typeof TQ.Game.getLevelCount === 'function') {
        var count = TQ.Game.getLevelCount();
        if (typeof count === 'number' && count > 0) return Math.min(count, 99);
      }
    } catch (e) { /* ignore */ }
    var list = getCoreLevelList();
    if (list && list.length > 0) return Math.min(list.length, 99);
    /* core 未就绪：用兜底文案数量占位，此时开始关卡会被 gameReady 拦截 */
    return LEVEL_FALLBACK.length;
  }

  function getLevelMeta(index) {
    var list = getCoreLevelList();
    var item = (list && list[index]) ? list[index] : null;
    var name = null;
    var theme = null;
    if (item && typeof item === 'object') {
      name = item.name || item.title || item.label || null;
      theme = item.theme || item.subtitle || item.desc || null;
    }
    var fallback = LEVEL_FALLBACK[index] || {
      name: fmt(STR.levelFallbackName, { index: index + 1 }),
      theme: ''
    };
    var themeText = '';
    if (typeof theme === 'string' && theme) {
      if (LEVEL_THEME_LABELS[theme]) {
        themeText = LEVEL_THEME_LABELS[theme];
      } else if (/^[a-z][a-z0-9_-]*$/i.test(theme)) {
        /* 未登记的内部代号不直接展示给玩家，退回兜底文案 */
        themeText = fallback.theme;
      } else {
        themeText = theme;
      }
    } else {
      themeText = fallback.theme;
    }
    return {
      name: (typeof name === 'string' && name) ? name : fallback.name,
      theme: themeText
    };
  }

  /* =======================================================================
   * 屏幕切换
   * ===================================================================== */

  function showScreen(name) {
    var valid = ['boot', 'login', 'menu', 'levels', 'settings', 'game'];
    if (valid.indexOf(name) < 0) name = 'menu';
    state.screen = name;

    var nodes = doc.querySelectorAll('.screen');
    for (var i = 0; i < nodes.length; i++) {
      var active = nodes[i].getAttribute('data-screen') === name;
      setClass(nodes[i], 'is-active', active);
      nodes[i].setAttribute('aria-hidden', active ? 'false' : 'true');
    }
    if (doc.body) doc.body.setAttribute('data-screen', name);

    if (name !== 'game') hideOverlays();
    if (name !== 'settings') closeUpdateModal();
    if (name === 'menu') refreshMenu();
    if (name === 'levels') renderLevels();
    if (name === 'settings') refreshSettings();
    syncBackTestId();
  }

  /* 自动化测试钩子：当前页面唯一可见的「返回」按钮持有 data-testid="btn-back" */
  function syncBackTestId() {
    var backs = [els.btnLevelsBack, els.btnSettingsBack];
    for (var i = 0; i < backs.length; i++) {
      if (backs[i]) backs[i].removeAttribute('data-testid');
    }
    var active = null;
    if (state.screen === 'levels') active = els.btnLevelsBack;
    else if (state.screen === 'settings') active = els.btnSettingsBack;
    if (active) active.setAttribute('data-testid', 'btn-back');
  }

  function setBootStatus(message, percent) {
    text(els.bootStatus, message || '');
    if (typeof percent === 'number' && els.bootBar) {
      els.bootBar.style.width = Math.max(0, Math.min(100, percent)) + '%';
    }
  }

  var BOOT_STEPS = {
    start: { key: 'bootStarting', percent: 8 },
    save: { key: 'bootSave', percent: 36 },
    version: { key: 'bootVersion', percent: 68 },
    ready: { key: 'bootReady', percent: 100 },
    game: { key: 'bootGameModule', percent: 100 }
  };

  function setBootStep(step) {
    var conf = BOOT_STEPS[step] || BOOT_STEPS.start;
    setBootStatus(STR[conf.key], conf.percent);
  }

  /* =======================================================================
   * 版本信息渲染
   * ===================================================================== */

  function getRuntimeInfo() {
    if (TQ.Net && typeof TQ.Net.getRuntimeInfo === 'function') {
      try {
        return TQ.Net.getRuntimeInfo();
      } catch (e) { /* ignore */ }
    }
    return {
      isNative: false, contentVersion: 0, bundledContentVersion: 0,
      appVersionName: '', hasContentVersion: false
    };
  }

  function updateVersionUI() {
    var info = getRuntimeInfo();
    var hasVersion = !!info.hasContentVersion && info.contentVersion > 0;
    var contentLabel = hasVersion ? ('v' + info.contentVersion) : '--';
    text(els.settingsContentVersion, contentLabel);
    text(els.settingsBuiltinVersion, info.bundledContentVersion > 0 ? ('v' + info.bundledContentVersion) : '--');

    var runtimeLabel = info.isNative ? STR.modeApp : STR.modeWeb;
    if (info.isNative && info.appVersionName) {
      runtimeLabel = STR.modeApp + ' ' + info.appVersionName;
    }
    text(els.settingsRuntime, runtimeLabel);

    var footer = '';
    if (hasVersion) {
      footer = fmt(STR.versionFooter, {
        version: info.contentVersion,
        mode: info.isNative ? STR.modeApp : STR.modeWeb
      });
    }
    text(els.loginVersion, footer);
    text(els.menuVersion, footer);
    text(els.bootVersion, footer);

    if (els.settingsUpdateHint) {
      text(els.settingsUpdateHint, TQ.Net && TQ.Net.checkUpdateViaNative() ?
        STR.settingsUpdateHintApp : STR.settingsUpdateHintWeb);
    }
  }

  /* =======================================================================
   * 登录 / 菜单
   * ===================================================================== */

  function setLoginError(message) {
    text(els.loginError, message || '');
  }

  function setLoginBusy(busy) {
    if (els.btnLogin) {
      els.btnLogin.disabled = !!busy;
      text(els.btnLogin, busy ? STR.loginSubmitting : STR.loginSubmit);
    }
    if (els.btnGuest) els.btnGuest.disabled = !!busy;
  }

  function showLogin() {
    state.session = null;
    setLoginError('');
    setLoginBusy(false);
    showScreen('login');
    updateVersionUI();
  }

  function setSession(session) {
    state.session = session || null;
    try {
      if (session && TQ.Save) TQ.Save.saveSession(session);
    } catch (e) { /* ignore */ }
  }

  function enterMenu(session) {
    state.session = session || null;
    refreshMenu();
    showScreen('menu');
    updateVersionUI();
  }

  function loginErrorText(result) {
    var code = result && result.code;
    if (code === 'empty') return STR.loginErrorEmpty;
    if (code === 'invalid_credentials') return STR.loginErrorInvalid;
    if (code === 'offline') return STR.loginErrorOffline;
    if (code === 'too_many_requests') return STR.loginErrorTooMany;
    if (code === 'network' || code === 'timeout' || code === 'no_fetch' || code === 'bad_config') {
      return STR.loginErrorNetwork;
    }
    if (result && result.message) return result.message;
    return STR.loginErrorUnknown;
  }

  function onLoginSubmit(event) {
    if (event && event.preventDefault) event.preventDefault();
    var username = els.loginUsername ? String(els.loginUsername.value || '').trim() : '';
    var password = els.loginPassword ? String(els.loginPassword.value || '') : '';
    if (!username || !password) {
      setLoginError(STR.loginErrorEmpty);
      return;
    }
    setLoginError('');
    setLoginBusy(true);

    if (!TQ.Net || typeof TQ.Net.login !== 'function') {
      setLoginBusy(false);
      setLoginError(STR.loginErrorNetwork);
      return;
    }

    TQ.Net.login(username, password).then(function (result) {
      setLoginBusy(false);
      if (!result || !result.ok) {
        setLoginError(loginErrorText(result));
        return;
      }
      var session = {
        token: result.token || '',
        username: result.username || username,
        displayName: result.displayName || username,
        expiresAt: result.expiresAt || null,
        guest: false
      };
      setSession(session);
      enterMenu(session);
      if (els.loginPassword) els.loginPassword.value = '';
      toast(STR.toastLoginSuccess, 'success');
    }, function () {
      setLoginBusy(false);
      setLoginError(STR.loginErrorNetwork);
    });
  }

  function onGuestLogin() {
    var session = {
      token: '',
      username: 'guest',
      displayName: '游客',
      expiresAt: null,
      guest: true
    };
    setSession(session);
    setLoginError('');
    if (els.loginPassword) els.loginPassword.value = '';
    enterMenu(session);
    toast(STR.toastGuest, 'info');
  }

  function logout() {
    try {
      if (TQ.Save && typeof TQ.Save.clearSession === 'function') TQ.Save.clearSession();
    } catch (e) { /* ignore */ }
    showLogin();
    toast(STR.toastLogout, 'info');
  }

  function refreshMenu() {
    var save = loadSave();
    var count = getLevelCount();
    var unlocked = Math.min((save.unlockedLevel || 0) + 1, count);
    var name = state.session ? (state.session.displayName || state.session.username || '游客') : '游客';
    text(els.menuWelcome, fmt(STR.menuWelcome, { name: name }));
    text(els.menuProgressText, fmt(STR.menuProgress, {
      unlocked: unlocked,
      total: count,
      treasures: save.totalTreasures || 0
    }));
    if (els.menuProgressFill) {
      els.menuProgressFill.style.width = (count > 0 ? Math.round(unlocked / count * 100) : 0) + '%';
    }
    updateVersionUI();
  }

  /* =======================================================================
   * 选关 / 游戏启动
   * ===================================================================== */

  function gameReady() {
    if (TQ.Boot && typeof TQ.Boot.isGameReady === 'function') {
      return !!TQ.Boot.isGameReady();
    }
    return !!(TQ.Game && typeof TQ.Game.startLevel === 'function');
  }

  function renderLevels() {
    if (!els.levelGrid) return;
    var save = loadSave();
    var count = getLevelCount();
    var html = '';
    for (var i = 0; i < count; i++) {
      var meta = getLevelMeta(i);
      var locked = i > (save.unlockedLevel || 0);
      var best = save.bestTimes ? save.bestTimes[String(i)] : null;
      var bestText = locked
        ? STR.levelsLocked
        : (typeof best === 'number' ? fmt(STR.levelsBest, { time: fmtTime(best) }) : STR.levelsNoBest);
      var playTestId = i === 0 ? 'btn-play-level' : ('btn-play-level-' + i);
      html += '<div class="level-card' + (locked ? ' is-locked' : '') +
        '" data-level="' + i + '" data-testid="level-card-' + i + '"' +
        ' role="button" tabindex="' + (locked ? '-1' : '0') + '"' +
        (locked ? ' aria-disabled="true"' : '') + '>' +
        '<span class="level-badge" aria-hidden="true">' + (locked ? '锁' : (i + 1)) + '</span>' +
        '<span class="level-name">' + escapeHtml(meta.name) + '</span>' +
        '<span class="level-theme">' + escapeHtml(meta.theme) + '</span>' +
        '<span class="level-best">' + escapeHtml(bestText) + '</span>' +
        (locked ? '' :
          '<button type="button" class="btn btn-primary level-card-play" data-level="' + i +
          '" data-testid="' + playTestId + '" data-i18n="levelsStart">' + escapeHtml(STR.levelsStart) + '</button>') +
        '</div>';
    }
    els.levelGrid.innerHTML = html;
    var unlockedCount = Math.min((save.unlockedLevel || 0) + 1, count);
    text(els.levelsProgress, fmt(STR.levelsProgress, { unlocked: unlockedCount, total: count }));
  }

  function onLevelGridClick(event) {
    var target = event && event.target;
    if (!target || typeof target.closest !== 'function') return;
    var card = target.closest('[data-level]');
    if (!card) return;
    if (card.disabled || card.getAttribute('aria-disabled') === 'true') return;
    var index = parseInt(card.getAttribute('data-level'), 10);
    if (isNaN(index)) return;
    startLevel(index);
  }

  function startLevel(index) {
    var save = loadSave();
    var count = getLevelCount();
    var level = toInt(index, 0);
    if (level < 0 || level >= count) return;
    if (level > (save.unlockedLevel || 0)) {
      toast(STR.toastLevelLocked, 'warn');
      return;
    }
    if (!gameReady()) {
      toast(STR.toastGameNotReady, 'warn');
      return;
    }

    state.currentLevel = level;
    state.currentTreasures = 0;
    state.currentHp = 0;
    hideOverlays();
    closeUpdateModal();
    showScreen('game');
    applySound(save.sound !== false, false);

    try {
      TQ.Game.startLevel(level);
    } catch (e) {
      if (global.console && global.console.error) {
        global.console.error('[TQ.UI] TQ.Game.startLevel 调用失败：', e);
      }
      toast(STR.toastGameError, 'error');
      showScreen('levels');
    }
  }

  /* =======================================================================
   * 覆盖层
   * ===================================================================== */

  function hideOverlays() {
    setHidden(els.overlayPause, true);
    setHidden(els.overlayDeath, true);
    setHidden(els.overlayComplete, true);
    state.overlay = null;
  }

  function showOverlay(name) {
    hideOverlays();
    state.overlay = name;
    if (name === 'pause') setHidden(els.overlayPause, false);
    else if (name === 'death') setHidden(els.overlayDeath, false);
    else if (name === 'complete') setHidden(els.overlayComplete, false);
  }

  function resumeGame() {
    hideOverlays();
    try {
      if (TQ.Game && typeof TQ.Game.resume === 'function') TQ.Game.resume();
    } catch (e) { /* ignore */ }
  }

  function restartLevelFlow() {
    hideOverlays();
    state.currentTreasures = 0;
    try {
      if (TQ.Game && typeof TQ.Game.restartLevel === 'function') {
        TQ.Game.restartLevel();
      } else {
        startLevel(state.currentLevel);
      }
    } catch (e) {
      startLevel(state.currentLevel);
    }
  }

  function exitToMenu() {
    hideOverlays();
    closeUpdateModal();
    try {
      if (TQ.Game && typeof TQ.Game.pause === 'function') TQ.Game.pause();
    } catch (e) { /* ignore */ }
    showScreen('menu');
  }

  function goNextLevel() {
    var next = state.currentLevel + 1;
    if (next < getLevelCount()) {
      hideOverlays();
      startLevel(next);
    } else {
      exitToMenu();
    }
  }

  function replayCurrentLevel() {
    hideOverlays();
    startLevel(state.currentLevel);
  }

  /* =======================================================================
   * 游戏事件 → 界面
   * ===================================================================== */

  function onGameEvent(ev) {
    var event = ev || {};
    var type = event.type;
    switch (type) {
      case 'levelStart':
        state.currentLevel = typeof event.level === 'number' ? event.level : state.currentLevel;
        state.currentTreasures = 0;
        hideOverlays();
        break;
      case 'treasure':
        state.currentTreasures = toInt(event.collected, state.currentTreasures);
        break;
      case 'playerHp':
        state.currentHp = toInt(event.hp, state.currentHp);
        state.maxHp = toInt(event.maxHp, state.maxHp || 3);
        break;
      case 'key':
        if (event.collected !== false) toast(STR.toastKey, 'success');
        break;
      case 'door':
        if (event.opened !== false) toast(STR.toastDoor, 'success');
        break;
      case 'hint':
        if (typeof event.text === 'string' && event.text) toast(event.text, 'info');
        break;
      case 'levelComplete':
        handleLevelComplete(event);
        break;
      case 'playerDied':
        handlePlayerDied(event);
        break;
      case 'requestPause':
        handlePauseRequest();
        break;
      default:
        break;
    }
  }

  function handleLevelComplete(ev) {
    var count = getLevelCount();
    var level = toInt(ev.level, state.currentLevel);
    if (level < 0 || level >= count) level = state.currentLevel;
    var treasures = Math.max(0, toInt(ev.treasures, 0));
    var total = Math.max(treasures, toInt(ev.total, treasures));
    var timeMs = Math.max(0, toInt(ev.timeMs, 0));
    var hp = Math.max(0, toInt(ev.hp, 0));
    var maxHp = Math.max(1, state.maxHp || 3);

    /* 解锁下一关 + 最佳用时 + 累计宝物 */
    var save = loadSave();
    var nextUnlocked = Math.min(level + 1, Math.max(0, count - 1));
    if (nextUnlocked > (save.unlockedLevel || 0)) save.unlockedLevel = nextUnlocked;
    var bestKey = String(level);
    var prevBest = (save.bestTimes && typeof save.bestTimes[bestKey] === 'number') ? save.bestTimes[bestKey] : null;
    if (!save.bestTimes) save.bestTimes = {};
    if (prevBest === null || timeMs < prevBest) save.bestTimes[bestKey] = timeMs;
    save.totalTreasures = (save.totalTreasures || 0) + treasures;

    try {
      if (TQ.Save) save = TQ.Save.save(save);
    } catch (e) { /* ignore */ }
    state.save = save;

    /* 填充通关覆盖层 */
    var meta = getLevelMeta(level);
    var hasNext = level + 1 < count;
    text(els.completeDesc, hasNext ? fmt(STR.completeDesc, { level: level + 1, name: meta.name }) : STR.completeAll);
    if (els.completeStats) {
      els.completeStats.innerHTML =
        '<div class="stat"><span class="stat-label">' + escapeHtml(STR.completeTime) + '</span>' +
        '<span class="stat-value">' + escapeHtml(fmtTime(timeMs)) + '</span></div>' +
        '<div class="stat"><span class="stat-label">' + escapeHtml(STR.completeTreasures) + '</span>' +
        '<span class="stat-value">' + treasures + '/' + total + '</span></div>' +
        '<div class="stat"><span class="stat-label">' + escapeHtml(STR.completeHp) + '</span>' +
        '<span class="stat-value">' + hp + '/' + maxHp + '</span></div>';
    }
    setHidden(els.btnNextLevel, !hasNext);
    showOverlay('complete');
    refreshMenu();
  }

  function handlePlayerDied(ev) {
    var level = toInt(ev.level, state.currentLevel);
    state.currentLevel = level;
    text(els.deathDesc, fmt(STR.deathDesc, { level: level + 1 }));
    showOverlay('death');
  }

  function handlePauseRequest() {
    if (state.screen !== 'game') return;
    if (state.overlay) return;
    showOverlay('pause');
    try {
      if (TQ.Game && typeof TQ.Game.pause === 'function') TQ.Game.pause();
    } catch (e) { /* ignore */ }
  }

  /* =======================================================================
   * 设置页
   * ===================================================================== */

  function refreshSettings() {
    toggleSoundUI();
    updateVersionUI();
    refreshUpdateSection();
  }

  function refreshUpdateSection() {
    var update = state.update;
    if (els.btnCheckUpdate) els.btnCheckUpdate.disabled = !!update.checking;

    if (update.done) {
      setUpdateStatus(STR.updateDone, 'ok');
      setProgressVisual(100);
    } else if (update.checking) {
      setUpdateStatus(STR.settingsChecking, 'checking');
    } else if (update.status && update.status.text) {
      setUpdateStatus(update.status.text, update.status.kind);
    } else if (update.available) {
      setUpdateStatus(fmt(STR.settingsUpdateFound, { version: update.available.version }), 'warn');
    } else {
      setUpdateStatus('', '');
    }

    if (update.progress) {
      setHidden(els.updateProgressWrap, false);
      applyProgressVisual(update.progress);
    } else if (!update.done) {
      setHidden(els.updateProgressWrap, true);
    }
  }

  function toggleSoundUI() {
    var save = loadSave();
    var enabled = save.sound !== false;
    if (els.switchSound) {
      els.switchSound.setAttribute('aria-checked', enabled ? 'true' : 'false');
      setClass(els.switchSound, 'is-on', enabled);
    }
  }

  function applySound(enabled, persist) {
    var on = enabled !== false;
    if (persist !== false) {
      try {
        if (TQ.Save && typeof TQ.Save.patch === 'function') TQ.Save.patch({ sound: on });
      } catch (e) { /* ignore */ }
    }
    try {
      if (TQ.Audio) {
        if (typeof TQ.Audio.setEnabled === 'function') TQ.Audio.setEnabled(on);
        else if (typeof TQ.Audio.setMuted === 'function') TQ.Audio.setMuted(!on);
        else if (typeof TQ.Audio.setSoundEnabled === 'function') TQ.Audio.setSoundEnabled(on);
      }
      if (TQ.Game && typeof TQ.Game.setSoundEnabled === 'function') {
        TQ.Game.setSoundEnabled(on);
      }
    } catch (e) { /* core 未提供音效开关时忽略 */ }
  }

  function toggleSound() {
    var save = loadSave();
    var enabled = save.sound === false;
    applySound(enabled, true);
    toggleSoundUI();
    toast(enabled ? STR.toastSoundOn : STR.toastSoundOff, 'success');
  }

  function resetSave() {
    var confirmed = true;
    if (typeof global.confirm === 'function') {
      try { confirmed = global.confirm(STR.settingsResetConfirm); } catch (e) { confirmed = true; }
    }
    if (!confirmed) return;
    try {
      if (TQ.Save && typeof TQ.Save.reset === 'function') TQ.Save.reset();
    } catch (e) { /* ignore */ }
    loadSave();
    toggleSoundUI();
    refreshLevelsIfVisible();
    toast(STR.settingsResetDone, 'success');
  }

  function refreshLevelsIfVisible() {
    if (state.screen === 'levels') renderLevels();
    if (state.screen === 'menu') refreshMenu();
  }

  /* =======================================================================
   * 更新 UI
   * ===================================================================== */

  function setUpdateBadge(show) {
    var visible = !!show;
    setHidden(els.menuSettingsDot, !visible);
    setHidden(els.settingsUpdateDot, !visible);
  }

  function setUpdateStatus(message, kind) {
    state.update.status = { text: message || '', kind: kind || '' };
    var node = els.settingsUpdateStatus;
    if (!node) return;
    node.textContent = message || '';
    node.classList.remove('is-ok', 'is-warn', 'is-error', 'is-checking');
    if (kind) node.classList.add('is-' + kind);
  }

  function updateCheckBusy(busy) {
    state.update.checking = !!busy;
    if (els.btnCheckUpdate) els.btnCheckUpdate.disabled = !!busy;
  }

  function normalizeAvailable(payload) {
    var data = payload || {};
    return {
      version: toInt(data.version, toInt(data.contentVersion, 0)),
      notes: typeof data.notes === 'string' ? data.notes : '',
      size: toInt(data.size, 0),
      publishedAt: typeof data.publishedAt === 'string' ? data.publishedAt : ''
    };
  }

  function setUpdateAvailable(payload) {
    if (!payload) return;
    state.update.available = normalizeAvailable(payload);
    state.update.done = null;
    state.update.downloading = false;
    state.update.progress = null;
    setUpdateBadge(true);
    if (state.screen === 'settings') {
      if (!state.update.checking) {
        setUpdateStatus(fmt(STR.settingsUpdateFound, { version: state.update.available.version }), 'warn');
      }
      setHidden(els.updateProgressWrap, true);
    }
  }

  function updateErrorText(code, message) {
    var map = {
      network: STR.otaErrors.network,
      timeout: STR.otaErrors.network,
      offline: STR.otaErrors.network,
      no_fetch: STR.otaErrors.network,
      bad_config: STR.otaErrors.network,
      sha256_mismatch: STR.otaErrors.sha256_mismatch,
      unzip_failed: STR.otaErrors.unzip_failed,
      too_large: STR.otaErrors.too_large,
      not_available: STR.otaErrors.not_available,
      shell_too_old: STR.settingsShellTooOld
    };
    return map[code] || (typeof message === 'string' && message ? message : STR.otaErrors.unknown);
  }

  function phaseLabel(phase) {
    if (phase === 'verify') return STR.updateVerifying;
    if (phase === 'unzip') return STR.updateUnzipping;
    return STR.updateDownloading;
  }

  function setProgressVisual(percent) {
    var value = Math.max(0, Math.min(100, toInt(percent, 0)));
    if (els.updateProgressBar) els.updateProgressBar.style.width = value + '%';
    if (els.updateModalBar) els.updateModalBar.style.width = value + '%';
  }

  function applyProgressVisual(progress) {
    var percent = toInt(progress && progress.percent, 0);
    var label = fmt(STR.updateProgress, { phase: phaseLabel(progress && progress.phase), percent: percent });
    setProgressVisual(percent);
    text(els.updateProgressText, label);
    text(els.updateModalStatus, label);
    setUpdateStatus(label, 'checking');
  }

  function showModalError(message) {
    if (!els.updateModalError) return;
    text(els.updateModalError, message || '');
    setHidden(els.updateModalError, !message);
  }

  function openUpdateModal() {
    var update = state.update;
    if (!els.modalUpdate) return;
    update.modalOpen = true;
    var available = update.available || {};
    text(els.updateVersion, fmt(STR.updateVersion, { version: available.version || 0 }));
    text(els.updateSize, available.size > 0 ? fmt(STR.updateSize, { size: fmtSize(available.size) }) : '');
    text(els.updateNotes, available.notes || STR.updateNotesDefault);
    text(els.updateModalHint, update.modalMode === 'native' ? STR.settingsUpdateHintApp : STR.settingsUpdateHintWeb);
    showModalError('');
    setHidden(els.updateModalProgress, !update.progress);
    if (update.progress) applyProgressVisual(update.progress);
    renderUpdateModal();
    els.modalUpdate.hidden = false;
  }

  function closeUpdateModal() {
    if (!els.modalUpdate) return;
    state.update.modalOpen = false;
    els.modalUpdate.hidden = true;
  }

  function renderUpdateModal() {
    if (!els.btnUpdateDownload) return;
    var update = state.update;
    var browserMode = update.modalMode === 'browser';
    var done = !!update.done;

    /* 自动化测试钩子：同一个按钮在「下载」和「重启」阶段使用不同 testid */
    els.btnUpdateDownload.setAttribute('data-testid', done ? 'btn-restart-update' : 'btn-download-update');

    if (browserMode) {
      text(els.btnUpdateDownload, STR.updateDownload);
      els.btnUpdateDownload.disabled = true;
      text(els.btnUpdateLater, STR.updateLater);
    } else if (done) {
      text(els.btnUpdateDownload, STR.updateRestart);
      els.btnUpdateDownload.disabled = false;
      text(els.btnUpdateLater, STR.updateLater);
    } else if (update.downloading) {
      text(els.btnUpdateDownload, STR.updateDownloading);
      els.btnUpdateDownload.disabled = true;
      text(els.btnUpdateLater, STR.updateLater);
    } else {
      text(els.btnUpdateDownload, STR.updateDownload);
      els.btnUpdateDownload.disabled = false;
      text(els.btnUpdateLater, STR.updateLater);
    }
  }

  function onUpdateDownloadClick() {
    var update = state.update;
    if (update.modalMode === 'browser') {
      toast(STR.settingsUpdateHintWeb, 'warn');
      return;
    }
    if (update.done) {
      var restarted = TQ.Net && typeof TQ.Net.restartApp === 'function' ? TQ.Net.restartApp() : false;
      if (!restarted) toast(STR.toastRestartFailed, 'error');
      return;
    }
    if (update.downloading) return;
    if (!update.available) {
      toast(STR.otaErrors.not_available, 'warn');
      return;
    }

    update.downloading = true;
    update.error = null;
    showModalError('');
    setHidden(els.updateModalProgress, false);
    applyProgressVisual({ phase: 'download', percent: 0 });
    renderUpdateModal();

    var started = TQ.Net && typeof TQ.Net.startNativeDownload === 'function' ?
      TQ.Net.startNativeDownload() : false;
    if (!started) {
      update.downloading = false;
      var message = STR.otaErrors.unknown;
      showModalError(message);
      setUpdateStatus(fmt(STR.settingsUpdateError, { message: message }), 'error');
      renderUpdateModal();
    }
  }

  function onUpdateLater() {
    var wasDone = !!state.update.done;
    closeUpdateModal();
    if (wasDone) toast(STR.toastRestartHint, 'info');
  }

  function onCheckUpdateClick() {
    var update = state.update;
    if (update.checking) return;
    if (update.done) {
      toast(STR.toastRestartHint, 'info');
      return;
    }
    update.explicit = true;
    update.error = null;
    update.progress = null;
    update.downloading = false;
    updateCheckBusy(true);
    setHidden(els.updateProgressWrap, true);
    setUpdateStatus(STR.settingsChecking, 'checking');

    var nativeMode = !!(TQ.Net && typeof TQ.Net.checkUpdateViaNative === 'function' && TQ.Net.checkUpdateViaNative());
    update.modalMode = nativeMode ? 'native' : 'browser';

    if (nativeMode) {
      try {
        if (TQ.Net.resetOtaState) TQ.Net.resetOtaState();
      } catch (e) { /* ignore */ }
      var started = TQ.Net.startNativeCheck();
      if (!started) {
        updateCheckBusy(false);
        var message = STR.otaErrors.unknown;
        setUpdateStatus(fmt(STR.settingsUpdateError, { message: message }), 'error');
        toast(message, 'error');
      }
      return;
    }

    runBrowserCheck();
  }

  function runBrowserCheck() {
    TQ.Net.checkVersion().then(function (result) {
      updateCheckBusy(false);
      var update = state.update;
      if (!result || !result.ok) {
        var message = updateErrorText(result && result.error, result && result.message);
        update.error = { code: result && result.error, message: message };
        setUpdateStatus(fmt(STR.settingsUpdateError, { message: message }), 'error');
        toast(message, 'error');
        return;
      }
      var content = result.content;
      if (content && result.updateAvailable) {
        setUpdateAvailable(content);
        update.modalMode = 'browser';
        openUpdateModal();
        setUpdateStatus(fmt(STR.settingsUpdateFound, { version: content.version }), 'warn');
        toast(fmt(STR.toastUpdateFound, { version: content.version }), 'success');
      } else if (content && result.reason === 'shell_too_old') {
        setUpdateBadge(false);
        setUpdateStatus(STR.settingsShellTooOld, 'warn');
        toast(STR.settingsShellTooOld, 'warn');
      } else {
        setUpdateBadge(false);
        update.available = null;
        setUpdateStatus(STR.settingsUpToDate, 'ok');
        toast(STR.settingsUpToDate, 'success');
      }
    }, function () {
      updateCheckBusy(false);
      setUpdateStatus(fmt(STR.settingsUpdateError, { message: STR.otaErrors.network }), 'error');
      toast(STR.otaErrors.network, 'error');
    });
  }

  /* ---------------- 原生 ota_* 事件 ---------------- */

  function onOtaChecking() {
    if (!state.update.explicit) return;
    updateCheckBusy(true);
    state.update.status = { text: STR.settingsChecking, kind: 'checking' };
    if (state.screen === 'settings') setUpdateStatus(STR.settingsChecking, 'checking');
  }

  function onOtaUpToDate() {
    updateCheckBusy(false);
    state.update.available = null;
    state.update.progress = null;
    state.update.error = null;
    setUpdateBadge(false);
    setUpdateStatus(STR.settingsUpToDate, 'ok');
    if (state.update.explicit) toast(STR.settingsUpToDate, 'success');
  }

  function onOtaAvailable(payload) {
    updateCheckBusy(false);
    state.update.explicit = state.update.explicit;
    setUpdateAvailable(payload);
    if (state.update.explicit) {
      openUpdateModal();
      toast(fmt(STR.toastUpdateFound, { version: state.update.available.version }), 'success');
    }
  }

  function onOtaProgress(payload) {
    var update = state.update;
    update.progress = {
      phase: payload && typeof payload.phase === 'string' ? payload.phase : 'download',
      percent: payload && typeof payload.percent === 'number' ? Math.max(0, Math.min(100, payload.percent)) : 0
    };
    update.downloading = true;
    setHidden(els.updateProgressWrap, false);
    setHidden(els.updateModalProgress, false);
    applyProgressVisual(update.progress);
    renderUpdateModal();
  }

  function onOtaDone(payload) {
    var update = state.update;
    updateCheckBusy(false);
    update.downloading = false;
    update.progress = null;
    update.done = {
      contentVersion: payload && typeof payload.contentVersion === 'number' ? payload.contentVersion : 0,
      restartRequired: !(payload && payload.restartRequired === false)
    };
    state.update.status = { text: STR.updateDone, kind: 'ok' };
    setUpdateStatus(STR.updateDone, 'ok');
    setProgressVisual(100);
    setHidden(els.updateProgressWrap, true);
    setHidden(els.updateModalProgress, true);
    setUpdateBadge(false);
    if (update.modalOpen || update.explicit) {
      openUpdateModal();
    }
    toast(STR.updateDoneToast, 'success');
  }

  function onOtaError(payload) {
    var update = state.update;
    updateCheckBusy(false);
    update.downloading = false;
    var code = payload && payload.code;
    var message = updateErrorText(code, payload && payload.message);
    update.error = { code: code, message: message };
    setUpdateStatus(fmt(STR.settingsUpdateError, { message: message }), 'error');
    toast(message, 'error');
    if (update.modalOpen) {
      showModalError(message);
      renderUpdateModal();
    }
  }

  /* =======================================================================
   * 安卓返回键入口（由 TQ.Shell.onAndroidBack 调用）
   * ===================================================================== */

  function onAndroidBack() {
    if (els.modalUpdate && !els.modalUpdate.hidden) {
      closeUpdateModal();
      return true;
    }
    if (state.screen === 'settings' || state.screen === 'levels') {
      showScreen('menu');
      return true;
    }
    if (state.screen === 'game') {
      if (state.overlay === 'pause') {
        resumeGame();
        return true;
      }
      if (state.overlay === 'death' || state.overlay === 'complete') {
        exitToMenu();
        return true;
      }
      handlePauseRequest();
      return true;
    }
    if (state.screen === 'login') return false;
    if (state.screen === 'menu') return false;
    return false;
  }

  /* =======================================================================
   * 安卓 Activity 生命周期（由 TQ.Shell.onPause / onResume 调用）
   * - onPause：暂停当前关卡并显示暂停覆盖层，暂停/静音 WebAudio；不丢关卡状态
   * - onResume：恢复音频上下文；不自动继续游戏（保持暂停覆盖层，等用户点继续）
   * ===================================================================== */

  function suspendAudioForLifecycle() {
    try {
      if (TQ.Audio && typeof TQ.Audio.suspend === 'function') {
        TQ.Audio.suspend();
        return;
      }
    } catch (e) { /* ignore */ }
    /* audio.js 未提供 suspend 时退化为临时静音，恢复时按存档设置还原 */
    try {
      if (TQ.Audio && typeof TQ.Audio.setEnabled === 'function') {
        state.audioMutedByLifecycle = true;
        TQ.Audio.setEnabled(false);
      }
    } catch (e) { /* ignore */ }
  }

  function resumeAudioAfterLifecycle() {
    try {
      if (TQ.Audio && typeof TQ.Audio.resume === 'function') {
        TQ.Audio.resume();
      }
    } catch (e) { /* ignore */ }
    if (state.audioMutedByLifecycle) {
      state.audioMutedByLifecycle = false;
      var save = loadSave();
      applySound(save.sound !== false, false);
    } else {
      try {
        if (TQ.Audio && typeof TQ.Audio.unlock === 'function') TQ.Audio.unlock();
      } catch (e) { /* ignore */ }
    }
  }

  function onAppPause() {
    if (state.screen === 'game' && !state.overlay) {
      showOverlay('pause');
      try {
        if (TQ.Game && typeof TQ.Game.pause === 'function') TQ.Game.pause();
      } catch (e) { /* ignore */ }
    }
    suspendAudioForLifecycle();
  }

  function onAppResume() {
    /* 只恢复音频；游戏保持暂停，等待用户点「继续游戏」 */
    resumeAudioAfterLifecycle();
  }

  /* =======================================================================
   * 轻提示
   * ===================================================================== */

  function toast(message, type) {
    if (!message || !els.toastWrap) return;
    var node = doc.createElement('div');
    node.className = 'toast' + (type ? (' toast-' + type) : '');
    node.textContent = String(message);
    els.toastWrap.appendChild(node);

    while (els.toastWrap.children.length > 3) {
      els.toastWrap.removeChild(els.toastWrap.firstChild);
    }

    global.setTimeout(function () {
      node.classList.add('is-out');
    }, 2400);
    global.setTimeout(function () {
      if (node.parentNode) node.parentNode.removeChild(node);
    }, 2820);
  }

  /* =======================================================================
   * 事件绑定
   * ===================================================================== */

  function cacheElements() {
    els = {
      bootBar: $('boot-bar-fill'),
      bootStatus: $('boot-status'),
      bootVersion: $('boot-version'),

      loginForm: $('login-form'),
      loginUsername: $('login-username'),
      loginPassword: $('login-password'),
      loginError: $('login-error'),
      btnLogin: $('btn-login'),
      btnGuest: $('btn-guest'),
      loginVersion: $('login-version'),

      menuWelcome: $('menu-welcome'),
      menuProgressText: $('menu-progress-text'),
      menuProgressFill: $('menu-progress-fill'),
      btnPlay: $('btn-play'),
      btnLevels: $('btn-levels'),
      btnMenuSettings: $('btn-menu-settings'),
      menuSettingsDot: $('menu-settings-dot'),
      btnLogout: $('btn-logout'),
      menuVersion: $('menu-version'),

      btnLevelsBack: $('btn-levels-back'),
      levelGrid: $('level-grid'),
      levelsProgress: $('levels-progress'),

      btnSettingsBack: $('btn-settings-back'),
      switchSound: $('switch-sound'),
      btnResetSave: $('btn-reset-save'),
      settingsContentVersion: $('settings-content-version'),
      settingsBuiltinVersion: $('settings-builtin-version'),
      settingsRuntime: $('settings-runtime'),
      btnCheckUpdate: $('btn-check-update'),
      settingsUpdateDot: $('settings-update-dot'),
      settingsUpdateStatus: $('settings-update-status'),
      updateProgressWrap: $('update-progress-wrap'),
      updateProgressBar: $('update-progress-bar'),
      updateProgressText: $('update-progress-text'),
      settingsUpdateHint: $('settings-update-hint'),

      overlayPause: $('overlay-pause'),
      overlayDeath: $('overlay-death'),
      overlayComplete: $('overlay-complete'),
      btnResume: $('btn-resume'),
      btnPauseRestart: $('btn-pause-restart'),
      btnPauseMenu: $('btn-pause-menu'),
      deathDesc: $('death-desc'),
      btnDeathRetry: $('btn-death-retry'),
      btnDeathMenu: $('btn-death-menu'),
      completeDesc: $('complete-desc'),
      completeStats: $('complete-stats'),
      btnNextLevel: $('btn-next-level'),
      btnReplayLevel: $('btn-replay-level'),
      btnCompleteMenu: $('btn-complete-menu'),

      modalUpdate: $('modal-update'),
      modalUpdateMask: $('modal-update-mask'),
      updateVersion: $('update-version'),
      updateSize: $('update-size'),
      updateNotes: $('update-notes'),
      updateModalProgress: $('update-modal-progress'),
      updateModalBar: $('update-modal-bar'),
      updateModalStatus: $('update-modal-status'),
      updateModalError: $('update-modal-error'),
      updateModalHint: $('update-modal-hint'),
      btnUpdateDownload: $('btn-update-download'),
      btnUpdateLater: $('btn-update-later'),

      toastWrap: $('toast-wrap')
    };
  }

  function bindEvents() {
    if (els.loginForm) {
      els.loginForm.addEventListener('submit', onLoginSubmit);
    }
    if (els.btnGuest) {
      els.btnGuest.addEventListener('click', onGuestLogin);
    }
    if (els.loginUsername) {
      els.loginUsername.addEventListener('input', function () { setLoginError(''); });
    }
    if (els.loginPassword) {
      els.loginPassword.addEventListener('input', function () { setLoginError(''); });
    }

    if (els.btnPlay) {
      els.btnPlay.addEventListener('click', function () {
        /* 开始冒险：直接继续当前可玩的最高已解锁关卡 */
        var save = loadSave();
        var count = getLevelCount();
        var target = Math.min(Math.max(0, save.unlockedLevel || 0), Math.max(0, count - 1));
        startLevel(target);
      });
    }
    if (els.btnLevels) {
      els.btnLevels.addEventListener('click', function () {
        renderLevels();
        showScreen('levels');
      });
    }
    if (els.btnMenuSettings) {
      els.btnMenuSettings.addEventListener('click', function () {
        refreshSettings();
        showScreen('settings');
      });
    }
    if (els.btnLogout) {
      els.btnLogout.addEventListener('click', logout);
    }

    if (els.btnLevelsBack) {
      els.btnLevelsBack.addEventListener('click', function () {
        showScreen('menu');
      });
    }
    if (els.levelGrid) {
      els.levelGrid.addEventListener('click', onLevelGridClick);
      els.levelGrid.addEventListener('keydown', function (event) {
        if (!event || (event.key !== 'Enter' && event.key !== ' ')) return;
        var target = event.target;
        if (!target || typeof target.closest !== 'function') return;
        var card = target.closest('[data-level]');
        if (!card || card.getAttribute('aria-disabled') === 'true') return;
        event.preventDefault();
        var index = parseInt(card.getAttribute('data-level'), 10);
        if (!isNaN(index)) startLevel(index);
      });
    }

    if (els.btnSettingsBack) {
      els.btnSettingsBack.addEventListener('click', function () {
        showScreen('menu');
      });
    }
    if (els.switchSound) {
      els.switchSound.addEventListener('click', toggleSound);
    }
    if (els.btnResetSave) {
      els.btnResetSave.addEventListener('click', resetSave);
    }
    if (els.btnCheckUpdate) {
      els.btnCheckUpdate.addEventListener('click', onCheckUpdateClick);
    }

    if (els.btnResume) {
      els.btnResume.addEventListener('click', resumeGame);
    }
    if (els.btnPauseRestart) {
      els.btnPauseRestart.addEventListener('click', restartLevelFlow);
    }
    if (els.btnPauseMenu) {
      els.btnPauseMenu.addEventListener('click', exitToMenu);
    }
    if (els.btnDeathRetry) {
      els.btnDeathRetry.addEventListener('click', restartLevelFlow);
    }
    if (els.btnDeathMenu) {
      els.btnDeathMenu.addEventListener('click', exitToMenu);
    }
    if (els.btnNextLevel) {
      els.btnNextLevel.addEventListener('click', goNextLevel);
    }
    if (els.btnReplayLevel) {
      els.btnReplayLevel.addEventListener('click', replayCurrentLevel);
    }
    if (els.btnCompleteMenu) {
      els.btnCompleteMenu.addEventListener('click', exitToMenu);
    }

    if (els.btnUpdateDownload) {
      els.btnUpdateDownload.addEventListener('click', onUpdateDownloadClick);
    }
    if (els.btnUpdateLater) {
      els.btnUpdateLater.addEventListener('click', onUpdateLater);
    }
    if (els.modalUpdateMask) {
      els.modalUpdateMask.addEventListener('click', closeUpdateModal);
    }

    if (doc) {
      doc.addEventListener('keydown', function (event) {
        if (!event || event.defaultPrevented) return;
        if (event.key !== 'Escape' && event.key !== 'Esc') return;
        if (els.modalUpdate && !els.modalUpdate.hidden) {
          closeUpdateModal();
          event.preventDefault();
          return;
        }
        if (state.screen === 'settings' || state.screen === 'levels') {
          showScreen('menu');
          event.preventDefault();
        }
      });
    }
  }

  function bindNetEvents() {
    if (!TQ.Net || typeof TQ.Net.addListener !== 'function') return;
    TQ.Net.addListener('ota_checking', onOtaChecking);
    TQ.Net.addListener('ota_up_to_date', onOtaUpToDate);
    TQ.Net.addListener('ota_available', onOtaAvailable);
    TQ.Net.addListener('ota_progress', onOtaProgress);
    TQ.Net.addListener('ota_done', onOtaDone);
    TQ.Net.addListener('ota_error', onOtaError);
  }

  /* =======================================================================
   * 初始化 / 对外接口
   * ===================================================================== */

  function init() {
    if (initialized) return;
    initialized = true;
    cacheElements();
    applyI18n();
    loadSave();
    bindEvents();
    bindNetEvents();
    toggleSoundUI();
    updateVersionUI();

    var savedSession = null;
    try {
      if (TQ.Save && typeof TQ.Save.loadSession === 'function') savedSession = TQ.Save.loadSession();
    } catch (e) { /* ignore */ }
    state.session = savedSession || null;

    showScreen('boot');
    setBootStatus(STR.bootStarting, 8);
  }

  /* 自动化测试辅助：只读的内部状态快照 */
  function getDebugState() {
    var save = loadSave();
    return {
      version: 1,
      screen: state.screen,
      overlay: state.overlay,
      session: state.session ? {
        username: state.session.username,
        displayName: state.session.displayName,
        guest: !!state.session.guest
      } : null,
      save: {
        unlockedLevel: save.unlockedLevel || 0,
        totalTreasures: save.totalTreasures || 0,
        sound: save.sound !== false,
        bestTimes: save.bestTimes || {}
      },
      levelCount: getLevelCount(),
      currentLevel: state.currentLevel,
      update: {
        mode: state.update.modalMode,
        checking: !!state.update.checking,
        modalOpen: !!state.update.modalOpen,
        available: !!state.update.available,
        availableVersion: state.update.available ? state.update.available.version : 0,
        done: !!state.update.done
      }
    };
  }

  TQ.UI = {
    /* ---- 契约接口（GAMEDESIGN 5.3） ---- */
    init: init,
    showScreen: showScreen,
    toast: toast,
    setUpdateBadge: setUpdateBadge,

    /* ---- 供 boot.js 使用 ---- */
    setBootStatus: setBootStatus,
    setBootStep: setBootStep,
    showLogin: showLogin,
    enterMenu: enterMenu,
    refreshVersionInfo: updateVersionUI,
    refreshMenu: refreshMenu,
    setUpdateAvailable: setUpdateAvailable,
    onGameEvent: onGameEvent,
    onAndroidBack: onAndroidBack,
    onAppPause: onAppPause,
    onAppResume: onAppResume,
    getSavedSession: function () { return state.session; },
    getDebugState: getDebugState
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = TQ.UI;
  }
})(typeof window !== 'undefined' ? window : globalThis);

/**
 * 游戏核心无头冒烟测试（node:test）
 * 用最小 Canvas/DOM 模拟对象驱动 TQ.Game，验证：
 * - 5.2 节对外接口与事件
 * - 移动/瓦片碰撞、剑击击杀、宝石收集与通关、锁门钥匙、死亡、暂停、重开
 * - 真实执行完整渲染路径（无异常）
 * 不依赖第三方库。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const CORE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/js/core');

// ---------------------------------------------------------------------------
// 最小 DOM / Canvas 模拟（Proxy 吞掉 2D 绘制调用，仅用于无头逻辑验证）
// ---------------------------------------------------------------------------
function createGradientStub() {
  return { addColorStop() {} };
}

function createCanvasStub() {
  let ctx;
  const canvas = {
    width: 960,
    height: 540,
    clientWidth: 960,
    clientHeight: 540,
    style: {},
    parentElement: null,
    getContext(type) {
      return type === '2d' ? ctx : null;
    },
    getBoundingClientRect() {
      return { left: 0, top: 0, width: 960, height: 540 };
    },
    addEventListener() {},
    removeEventListener() {},
    setPointerCapture() {},
    releasePointerCapture() {}
  };
  const target = { canvas };
  ctx = new Proxy(target, {
    get(t, prop) {
      if (prop === 'measureText') return () => ({ width: 24 });
      if (prop === 'createLinearGradient' || prop === 'createRadialGradient') return () => createGradientStub();
      if (prop in t) return t[prop];
      return () => {};
    },
    set(t, prop, value) {
      t[prop] = value;
      return true;
    }
  });
  return canvas;
}

function createWindowStub() {
  return {
    devicePixelRatio: 1,
    performance: { now: () => Date.now() },
    console,
    setTimeout,
    clearTimeout,
    addEventListener() {},
    removeEventListener() {},
    requestAnimationFrame() {
      return 0;
    },
    cancelAnimationFrame() {},
    document: {
      addEventListener() {},
      removeEventListener() {}
    }
  };
}

globalThis.window = createWindowStub();
const CORE_FILES = ['util.js', 'audio.js', 'input.js', 'graphics.js', 'level_data.js', 'game.js'];
// 同一进程内可能已被其他测试文件 import（例如 map.test.mjs 引入了 level_data.js），
// 此时 require 缓存里的模块没有挂到本文件的模拟 window 上，需要清缓存后重新执行。
for (const file of CORE_FILES) {
  try {
    delete require.cache[require.resolve(path.join(CORE_DIR, file))];
  } catch (e) {
    /* ignore */
  }
}
for (const file of CORE_FILES) require(path.join(CORE_DIR, file));

const TQ = globalThis.window.TQ;
const Game = TQ.Game;

// ---------------------------------------------------------------------------
// 测试辅助
// ---------------------------------------------------------------------------
function startGame(levelIndex) {
  const events = [];
  Game.init({
    canvas: createCanvasStub(),
    onEvent: (ev) => events.push(ev),
    autoLoop: false
  });
  Game.startLevel(levelIndex || 0);
  return { events, state: Game.__test.state() };
}

function stepFrames(count, dt) {
  const delta = dt || 1 / 60;
  for (let i = 0; i < count; i++) Game.__test.step(delta);
}

function eventTypes(events) {
  return events.map((e) => e.type);
}

// ---------------------------------------------------------------------------
// 接口
// ---------------------------------------------------------------------------
test('TQ.Game 实现 5.2 节全部接口', () => {
  for (const name of ['init', 'startLevel', 'restartLevel', 'pause', 'resume', 'destroy', 'isRunning', 'getLevelCount']) {
    assert.equal(typeof Game[name], 'function', `缺少接口 ${name}`);
  }
  assert.equal(Game.getLevelCount(), 4);
});

// ---------------------------------------------------------------------------
// 关卡开始 / 事件
// ---------------------------------------------------------------------------
test('startLevel 上报 levelStart / playerHp，初始状态正确', () => {
  const { events, state } = startGame(0);
  assert.equal(events[0].type, 'levelStart');
  assert.equal(events[0].level, 0);
  const start = events.find((e) => e.type === 'levelStart');
  assert.deepEqual(start, { type: 'levelStart', level: 0 });

  const hp = events.find((e) => e.type === 'playerHp');
  assert.ok(hp);
  assert.equal(hp.hp, 3);
  assert.equal(hp.maxHp, 3);

  assert.equal(Game.isRunning(), true);
  assert.equal(state.status, 'playing');
  assert.equal(state.gemsTotal, 5);
  assert.equal(state.gemsCollected, 0);
  assert.equal(state.enemies.length, 4);
  assert.equal(state.spikes.length, 0);
  const snap = Game.getSnapshot();
  assert.equal(snap.enemiesAlive, 4);
  assert.equal(snap.totalGems, 5);
});

// ---------------------------------------------------------------------------
// 移动与碰撞
// ---------------------------------------------------------------------------
test('键盘 8 方向移动（向右）与边界钳制', () => {
  const { state } = startGame(0);
  const p = state.player;
  const startX = p.x;
  const startY = p.y;
  state.input.keys.d = true;
  stepFrames(30);
  state.input.keys.d = false;
  assert.ok(p.x > startX + 40, `应向右移动，实际位移 ${p.x - startX}`);
  assert.ok(Math.abs(p.y - startY) < 0.001, '水平移动不应改变 y');

  // 向左一直走，最终被地图左边界/墙体挡住
  state.input.keys.a = true;
  stepFrames(300);
  state.input.keys.a = false;
  assert.ok(p.x >= p.r - 0.001, `x 不应越界: ${p.x}`);
  assert.ok(p.x < startX, '应向左移动');
});

test('瓦片碰撞：第 2 关中央隔墙能挡住玩家', () => {
  const { state } = startGame(1);
  const p = state.player;
  p.invuln = 999;
  state.enemies.forEach((e) => { e.dead = true; });
  // 隔墙在 x=20（tile），玩家放在 x=17.5 tile 处向右走
  p.x = 17 * 32 + 16;
  p.y = 6 * 32 + 16;
  state.input.keys.d = true;
  stepFrames(120);
  state.input.keys.d = false;
  assert.ok(p.x <= 20 * 32 - p.hitHalf + 0.001, `应被 x=20 的墙挡住，实际 x=${p.x}`);
  assert.ok(p.x > 18 * 32, `应移动到墙前，实际 x=${p.x}`);
});

// ---------------------------------------------------------------------------
// 战斗
// ---------------------------------------------------------------------------
test('剑击可击杀史莱姆并上报 enemyKilled', () => {
  const { events, state } = startGame(0);
  const p = state.player;
  p.invuln = 999;
  const slime = state.enemies.find((e) => e.kind === 'slime');
  assert.ok(slime);
  slime.speed = 0;

  // 第一次挥砍（朝向右侧的史莱姆）
  slime.x = p.x + 30;
  slime.y = p.y;
  slime.kx = 0;
  slime.ky = 0;
  p.facing = 0;
  state.input._attackQueued = true;
  stepFrames(2);
  assert.equal(slime.hp, 1, '史莱姆血量应为 2 -> 1');

  // 等冷却后第二次挥砍
  stepFrames(30);
  slime.x = p.x + 30;
  slime.y = p.y;
  slime.kx = 0;
  slime.ky = 0;
  p.facing = 0;
  state.input._attackQueued = true;
  stepFrames(2);
  assert.equal(slime.dead, true, '史莱姆应被击杀');
  assert.ok(
    events.some((e) => e.type === 'enemyKilled' && e.kind === 'slime'),
    '应上报 enemyKilled'
  );
});

test('受击：玩家掉血进入无敌帧并上报 playerHp', () => {
  const { events, state } = startGame(0);
  const p = state.player;
  p.invuln = 0;
  const slime = state.enemies.find((e) => e.kind === 'slime');
  slime.x = p.x;
  slime.y = p.y;
  stepFrames(1);
  assert.equal(p.hp, 2);
  assert.ok(p.invuln > 0, '受击后应有无敌帧');
  assert.ok(events.some((e) => e.type === 'playerHp' && e.hp === 2 && e.maxHp === 3));

  // 无敌帧内再次接触不掉血
  stepFrames(10);
  assert.equal(p.hp, 2);
});

// ---------------------------------------------------------------------------
// 收集 / 通关
// ---------------------------------------------------------------------------
test('收集全部宝石 -> 传送门激活 -> levelComplete 事件字段正确', () => {
  const { events, state } = startGame(0);
  const p = state.player;
  p.invuln = 99999;
  state.enemies.forEach((e) => { e.dead = true; });

  let guard = 0;
  while (state.items.some((it) => it.kind === 'gem') && guard++ < 20) {
    const gem = state.items.find((it) => it.kind === 'gem');
    p.x = gem.x;
    p.y = gem.y;
    stepFrames(1);
  }

  const treasureEvents = events.filter((e) => e.type === 'treasure');
  assert.equal(treasureEvents.length, 5, '应收集 5 颗宝石');
  assert.deepEqual(treasureEvents.map((e) => e.collected), [1, 2, 3, 4, 5]);
  assert.deepEqual(treasureEvents.map((e) => e.total), [5, 5, 5, 5, 5]);
  for (const e of treasureEvents) assert.ok(typeof e.treasureId === 'string' && e.treasureId.length > 0);

  assert.equal(state.gemsCollected, 5);
  assert.equal(state.portal.activated, true, '集齐宝石后传送门应激活');

  p.x = state.portal.x;
  p.y = state.portal.y;
  stepFrames(2);

  const complete = events.find((e) => e.type === 'levelComplete');
  assert.ok(complete, '应上报 levelComplete');
  assert.equal(complete.level, 0);
  assert.equal(complete.treasures, 5);
  assert.equal(complete.total, 5);
  assert.equal(complete.hp, 3);
  assert.ok(complete.timeMs >= 0);
  assert.equal(state.status, 'complete');
  assert.equal(Game.isRunning(), false);
});

test('未集齐宝石时进入传送门不会被判定通关', () => {
  const { events, state } = startGame(0);
  state.player.invuln = 99999;
  state.player.x = state.portal.x;
  state.player.y = state.portal.y;
  stepFrames(2);
  assert.notEqual(state.status, 'complete');
  assert.equal(events.some((e) => e.type === 'levelComplete'), false);
});

// ---------------------------------------------------------------------------
// 第 2 关：钥匙 / 锁门
// ---------------------------------------------------------------------------
test('第 2 关：拾取钥匙后撞门可开门并上报 key/door 事件', () => {
  const { events, state } = startGame(1);
  const p = state.player;
  p.invuln = 99999;
  state.enemies.forEach((e) => { e.dead = true; });

  const key = state.items.find((it) => it.kind === 'key');
  assert.ok(key, '第 2 关应存在钥匙');
  p.x = key.x;
  p.y = key.y;
  stepFrames(1);
  assert.equal(p.hasKey, true);
  assert.ok(events.some((e) => e.type === 'key' && e.collected === true));

  // 无钥匙时门是阻挡的
  assert.equal(state.door.open, false);

  // 走到门前向右撞门
  p.x = state.door.x - 24;
  p.y = state.door.y;
  state.input.keys.d = true;
  stepFrames(10);
  state.input.keys.d = false;

  assert.equal(state.door.open, true, '有钥匙撞门应开门');
  assert.ok(events.some((e) => e.type === 'door' && e.opened === true));
  assert.equal(state.level.grid[state.door.ty][state.door.tx], '.', '开门后地图瓦片应变为可通行');
});

// ---------------------------------------------------------------------------
// 第 4 关（v2 新增）：云端秘殿
// ---------------------------------------------------------------------------
test('第 4 关可加载运行：52x29 地图、8 宝石、9 敌人、传送门在右下', () => {
  const { events, state } = startGame(3);
  assert.equal(events[0].type, 'levelStart');
  assert.equal(events[0].level, 3);
  assert.equal(Game.isRunning(), true);
  assert.equal(state.status, 'playing');
  assert.equal(state.level.name, '云端秘殿');
  assert.equal(state.level.width, 52);
  assert.equal(state.level.height, 29);
  assert.equal(state.gemsTotal, 8);
  assert.equal(state.enemies.length, 9);
  assert.equal(state.enemies.filter((e) => e.kind === 'ghost').length, 4);
  assert.equal(state.enemies.filter((e) => e.kind === 'bat').length, 2);
  assert.equal(state.enemies.filter((e) => e.kind === 'slime').length, 3);
  assert.ok(state.spikes.length >= 12);
  assert.ok(state.door, '第 4 关应有锁门');
  assert.equal(state.door.open, false);
  assert.ok(state.portal.activated === false);
  assert.ok(state.portal.x > 40 * 32, '传送门应在右下区域');
  assert.ok(state.portal.y > 20 * 32, '传送门应在右下区域');

  // 渲染 + 更新若干帧不应报错
  state.player.invuln = 99999;
  stepFrames(30);
  assert.equal(state.status, 'playing');
});

test('第 4 关：钥匙开门后可收集 8 宝石并通关', () => {
  const { events, state } = startGame(3);
  const p = state.player;
  p.invuln = 99999;
  state.enemies.forEach((e) => { e.dead = true; });

  const key = state.items.find((it) => it.kind === 'key');
  assert.ok(key, '第 4 关应有钥匙');
  p.x = key.x;
  p.y = key.y;
  stepFrames(1);
  assert.equal(p.hasKey, true);
  assert.ok(events.some((e) => e.type === 'key' && e.collected === true));

  // 撞门开门（门在 (34,14)，从上方接近）
  p.x = state.door.x;
  p.y = state.door.y - 24;
  state.input.keys.s = true;
  stepFrames(10);
  state.input.keys.s = false;
  assert.equal(state.door.open, true, '有钥匙撞门应开门');
  assert.ok(events.some((e) => e.type === 'door' && e.opened === true));

  // 收集全部 8 颗宝石
  let guard = 0;
  while (state.items.some((it) => it.kind === 'gem') && guard++ < 30) {
    const gem = state.items.find((it) => it.kind === 'gem');
    p.x = gem.x;
    p.y = gem.y;
    stepFrames(1);
  }
  const treasureEvents = events.filter((e) => e.type === 'treasure');
  assert.equal(treasureEvents.length, 8, '第 4 关应收集 8 颗宝石');
  assert.deepEqual(treasureEvents.map((e) => e.collected), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(state.portal.activated, true);

  p.x = state.portal.x;
  p.y = state.portal.y;
  stepFrames(2);
  const complete = events.find((e) => e.type === 'levelComplete');
  assert.ok(complete, '第 4 关应能通关');
  assert.equal(complete.level, 3);
  assert.equal(complete.treasures, 8);
  assert.equal(complete.total, 8);
  assert.equal(state.status, 'complete');
});

// ---------------------------------------------------------------------------
// 尖刺 / 死亡
// ---------------------------------------------------------------------------
test('第 3 关尖刺在伸出时造成伤害', () => {
  const { state } = startGame(2);
  const p = state.player;
  p.invuln = 0;
  state.enemies.forEach((e) => { e.dead = true; });
  const spike = state.spikes[0];
  assert.ok(spike, '第 3 关应有尖刺');
  // 调整时间让该尖刺处于伸出状态
  state.elapsed = (2.4 - spike.phase + 0.05) % 2.4;
  p.x = spike.x;
  p.y = spike.y;
  stepFrames(1);
  assert.equal(p.hp, 2, '尖刺应造成 1 点伤害');
});

test('血量归零触发死亡：playerDied 事件 + 停止运行', () => {
  const { events, state } = startGame(0);
  const p = state.player;
  p.hp = 1;
  p.invuln = 0;
  const slime = state.enemies.find((e) => e.kind === 'slime');
  slime.x = p.x;
  slime.y = p.y;
  stepFrames(2);
  assert.equal(state.status, 'dead');
  assert.equal(p.hp, 0);
  assert.ok(events.some((e) => e.type === 'playerDied' && e.level === 0));
  assert.equal(Game.isRunning(), false);
});

// ---------------------------------------------------------------------------
// 暂停 / 重开 / 销毁
// ---------------------------------------------------------------------------
test('pause/resume：暂停时计时停止且 isRunning 为 false', () => {
  const { state } = startGame(0);
  stepFrames(10);
  const t0 = state.timeMs;
  Game.pause();
  assert.equal(Game.isRunning(), false);
  assert.equal(state.status, 'paused');
  stepFrames(30);
  assert.equal(state.timeMs, t0, '暂停时不应累计计时');
  Game.resume();
  assert.equal(Game.isRunning(), true);
  stepFrames(30);
  assert.ok(state.timeMs > t0, '恢复后应继续计时');
});

test('ESC 暂停请求通过 requestPause 事件上报（由外壳决定是否暂停）', () => {
  const { events, state } = startGame(0);
  state.input._pauseQueued = true;
  stepFrames(1);
  assert.ok(events.some((e) => e.type === 'requestPause'));
});

test('restartLevel 重置宝石/计时/状态', () => {
  const { state } = startGame(0);
  const p = state.player;
  p.invuln = 99999;
  const gem = state.items.find((it) => it.kind === 'gem');
  p.x = gem.x;
  p.y = gem.y;
  stepFrames(1);
  assert.equal(Game.getSnapshot().gems, 1);

  stepFrames(30);
  Game.restartLevel();
  const snap = Game.getSnapshot();
  assert.equal(snap.status, 'playing');
  assert.equal(snap.gems, 0);
  assert.equal(snap.timeMs, 0);
  assert.equal(snap.hp, 3);
  assert.equal(Game.isRunning(), true);
});

test('destroy 可安全重复调用，之后 startLevel 为空操作', () => {
  startGame(0);
  Game.destroy();
  assert.equal(Game.isRunning(), false);
  assert.equal(Game.getSnapshot().status, 'idle');
  Game.destroy();
  Game.startLevel(0);
  assert.equal(Game.isRunning(), false);
});

test('startLevel 越界索引回退到第 1 关', () => {
  const { state } = startGame(0);
  Game.startLevel(99);
  assert.equal(state.status, 'playing');
  assert.equal(Game.getSnapshot().level, 0);
  Game.startLevel(-5);
  assert.equal(Game.getSnapshot().level, 0);
});

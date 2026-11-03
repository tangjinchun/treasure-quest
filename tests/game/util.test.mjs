/**
 * 核心工具库测试（node:test）
 * 验证 UMD 导出、数学/时间/几何工具与确定性随机数。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import utilModule from '../../web/js/core/util.js';

const { Util } = utilModule;

test('UMD：Node 下 module.exports 暴露 Util', () => {
  assert.equal(typeof Util, 'object');
  assert.equal(typeof Util.clamp, 'function');
  assert.equal(typeof Util.formatTime, 'function');
  assert.equal(typeof Util.hash2, 'function');
});

test('clamp / lerp / approach', () => {
  assert.equal(Util.clamp(5, 0, 10), 5);
  assert.equal(Util.clamp(-1, 0, 10), 0);
  assert.equal(Util.clamp(99, 0, 10), 10);
  assert.equal(Util.lerp(0, 10, 0.5), 5);
  assert.equal(Util.approach(0, 10, 3), 3);
  assert.equal(Util.approach(9, 10, 3), 10);
  assert.equal(Util.approach(10, 10, 3), 10);
});

test('dist / normalize / angleDiff', () => {
  assert.equal(Util.dist(0, 0, 3, 4), 5);
  const n = Util.normalize(3, 4);
  assert.ok(Math.abs(n.x - 0.6) < 1e-9);
  assert.ok(Math.abs(n.y - 0.8) < 1e-9);
  assert.equal(Util.normalize(0, 0).len, 0);
  // 最短角差（有符号）：跨 ±PI 时应为 -0.2
  assert.ok(Math.abs(Util.angleDiff(Math.PI - 0.1, -Math.PI + 0.1) + 0.2) < 1e-9);
  assert.ok(Math.abs(Util.angleDiff(0, Math.PI / 2) + Math.PI / 2) < 1e-9);
});

test('formatTime：毫秒 -> MM:SS', () => {
  assert.equal(Util.formatTime(0), '00:00');
  assert.equal(Util.formatTime(999), '00:00');
  assert.equal(Util.formatTime(1000), '00:01');
  assert.equal(Util.formatTime(61000), '01:01');
  assert.equal(Util.formatTime(3599000), '59:59');
  assert.equal(Util.formatTime(3600000), '1:00:00');
  assert.equal(Util.formatTime(-5), '00:00');
});

test('hash2 确定性且在 [0,1) 范围', () => {
  assert.equal(Util.hash2(3, 7), Util.hash2(3, 7));
  assert.notEqual(Util.hash2(3, 7), Util.hash2(4, 7));
  for (let x = 0; x < 20; x++) {
    for (let y = 0; y < 20; y++) {
      const v = Util.hash2(x, y);
      assert.ok(v >= 0 && v < 1, `hash2(${x},${y}) = ${v}`);
    }
  }
});

test('makeRng 可复现', () => {
  const a = Util.makeRng(42);
  const b = Util.makeRng(42);
  for (let i = 0; i < 10; i++) assert.equal(a(), b());
  const c = Util.makeRng(43);
  assert.notEqual(Util.makeRng(42)(), c());
});

test('几何判定：矩形 / 圆与矩形', () => {
  assert.equal(Util.rectsOverlap(0, 0, 10, 10, 5, 5, 10, 10), true);
  assert.equal(Util.rectsOverlap(0, 0, 10, 10, 20, 20, 5, 5), false);
  assert.equal(Util.pointInRect(5, 5, 0, 0, 10, 10), true);
  assert.equal(Util.pointInRect(11, 5, 0, 0, 10, 10), false);
  assert.equal(Util.circleRectOverlap(0, 0, 5, 3, 3, 4, 4), true);
  assert.equal(Util.circleRectOverlap(20, 20, 5, 0, 0, 4, 4), false);
});

/**
 * 《寻宝奇兵》核心工具库
 * 浏览器：window.TQ.Util；Node：module.exports = { Util }（供 tests/game 使用）。
 * ES2019、无外部依赖。
 */
(function (global) {
  'use strict';

  var TQ = global.TQ = global.TQ || {};

  var TAU = Math.PI * 2;

  function clamp(v, min, max) {
    if (v < min) return min;
    if (v > max) return max;
    return v;
  }

  function clamp01(v) {
    return clamp(v, 0, 1);
  }

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  /** 帧率无关插值：向 target 平滑靠近（lambda 越大越快） */
  function damp(current, target, lambda, dt) {
    return lerp(current, target, 1 - Math.exp(-lambda * dt));
  }

  /** 线性逼近，每次最多移动 delta */
  function approach(current, target, delta) {
    if (current < target) return Math.min(current + delta, target);
    if (current > target) return Math.max(current - delta, target);
    return target;
  }

  function dist2(x1, y1, x2, y2) {
    var dx = x2 - x1;
    var dy = y2 - y1;
    return dx * dx + dy * dy;
  }

  function dist(x1, y1, x2, y2) {
    return Math.sqrt(dist2(x1, y1, x2, y2));
  }

  function length(x, y) {
    return Math.sqrt(x * x + y * y);
  }

  /** 归一化向量；零向量返回 {x:0,y:0,len:0} */
  function normalize(x, y) {
    var len = Math.sqrt(x * x + y * y);
    if (len < 1e-6) return { x: 0, y: 0, len: 0 };
    return { x: x / len, y: y / len, len: len };
  }

  function angleTo(x1, y1, x2, y2) {
    return Math.atan2(y2 - y1, x2 - x1);
  }

  /** 两个角度的最短有符号差，范围 (-PI, PI] */
  function angleDiff(a, b) {
    var d = (a - b) % TAU;
    if (d > Math.PI) d -= TAU;
    if (d <= -Math.PI) d += TAU;
    return d;
  }

  function rand() {
    return Math.random();
  }

  function randRange(min, max) {
    return min + Math.random() * (max - min);
  }

  function randInt(min, max) {
    return Math.floor(min + Math.random() * (max - min + 1));
  }

  function choice(arr) {
    if (!arr || !arr.length) return undefined;
    return arr[Math.floor(Math.random() * arr.length)];
  }

  function shuffle(arr) {
    var i;
    var j;
    var tmp;
    for (i = arr.length - 1; i > 0; i--) {
      j = Math.floor(Math.random() * (i + 1));
      tmp = arr[i];
      arr[i] = arr[j];
      arr[j] = tmp;
    }
    return arr;
  }

  /** 二维整数哈希 -> [0,1)，用于地图瓦片变化、尖刺相位等确定性随机 */
  function hash2(x, y) {
    var h = (x | 0) * 374761393 + (y | 0) * 668265263;
    h = (h ^ (h >>> 13)) * 1274126177;
    h = h ^ (h >>> 16);
    return ((h >>> 0) % 100000) / 100000;
  }

  /** mulberry32 伪随机数生成器，返回 function() -> [0,1) */
  function makeRng(seed) {
    var a = (seed | 0) || 1;
    return function () {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function easeOutCubic(t) {
    var p = 1 - clamp01(t);
    return 1 - p * p * p;
  }

  function easeInOutQuad(t) {
    var x = clamp01(t);
    return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2;
  }

  function easeOutBack(t) {
    var x = clamp01(t);
    var c1 = 1.70158;
    var c3 = c1 + 1;
    return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
  }

  /** 毫秒 -> "MM:SS"（超过 1 小时则 "H:MM:SS"） */
  function formatTime(ms) {
    var total = Math.max(0, Math.floor(ms / 1000));
    var h = Math.floor(total / 3600);
    var m = Math.floor((total % 3600) / 60);
    var s = total % 60;
    var mm = String(m).padStart(2, '0');
    return (h > 0 ? h + ':' : '') + mm + ':' + String(s).padStart(2, '0');
  }

  function formatTimeMs(ms) {
    var total = Math.max(0, ms);
    var m = Math.floor(total / 60000);
    var s = Math.floor((total % 60000) / 1000);
    var ds = Math.floor((total % 1000) / 100);
    return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0') + '.' + ds;
  }

  function rectsOverlap(ax, ay, aw, ah, bx, by, bw, bh) {
    return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
  }

  function pointInRect(px, py, x, y, w, h) {
    return px >= x && px <= x + w && py >= y && py <= y + h;
  }

  function circleRectOverlap(cx, cy, r, x, y, w, h) {
    var nx = clamp(cx, x, x + w);
    var ny = clamp(cy, y, y + h);
    var dx = cx - nx;
    var dy = cy - ny;
    return dx * dx + dy * dy <= r * r;
  }

  /** 8 方向吸附（用于角色朝向），返回弧度 */
  function snapAngle(angle) {
    var step = Math.PI / 4;
    return Math.round(angle / step) * step;
  }

  var Util = {
    TAU: TAU,
    clamp: clamp,
    clamp01: clamp01,
    lerp: lerp,
    damp: damp,
    approach: approach,
    dist: dist,
    dist2: dist2,
    length: length,
    normalize: normalize,
    angleTo: angleTo,
    angleDiff: angleDiff,
    snapAngle: snapAngle,
    rand: rand,
    randRange: randRange,
    randInt: randInt,
    choice: choice,
    shuffle: shuffle,
    hash2: hash2,
    makeRng: makeRng,
    easeOutCubic: easeOutCubic,
    easeInOutQuad: easeInOutQuad,
    easeOutBack: easeOutBack,
    formatTime: formatTime,
    formatTimeMs: formatTimeMs,
    rectsOverlap: rectsOverlap,
    pointInRect: pointInRect,
    circleRectOverlap: circleRectOverlap
  };

  TQ.Util = Util;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { Util: Util };
  }
})(typeof window !== 'undefined' ? window : globalThis);

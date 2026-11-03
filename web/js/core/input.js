/**
 * 《寻宝奇兵》输入系统：键盘 + 触屏虚拟摇杆/攻击按钮
 * 键盘：WASD / 方向键移动，J / 空格攻击，ESC 暂停
 * 触屏：左下虚拟摇杆、右下攻击按钮、右上暂停按钮（鼠标也可模拟，便于桌面调试）
 * 浏览器挂载 window.TQ.Input；游戏内通过 new TQ.Input() 使用。
 */
(function (global) {
  'use strict';

  var TQ = global.TQ = global.TQ || {};

  // 逻辑分辨率 960x540 下的触屏控件布局（绘制与命中判定共用）
  var DEFAULT_LAYOUT = {
    joystick: { cx: 152, cy: 392, r: 74, knob: 30 },
    attack: { cx: 810, cy: 394, r: 58 },
    pause: { x: 892, y: 16, w: 44, h: 44 }
  };

  var GAME_KEYS = {
    w: true,
    a: true,
    s: true,
    d: true,
    arrowup: true,
    arrowdown: true,
    arrowleft: true,
    arrowright: true,
    j: true,
    ' ': true,
    escape: true
  };

  function isFormTarget(el) {
    if (!el) return false;
    var tag = el.tagName ? String(el.tagName).toUpperCase() : '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'BUTTON') return true;
    return el.isContentEditable === true;
  }

  function normKey(e) {
    var key = '';
    if (e.key) key = String(e.key).toLowerCase();
    else if (e.keyCode === 27) key = 'escape';
    else if (e.keyCode === 32) key = ' ';
    if (key === 'spacebar' || key === 'space') key = ' ';
    if (key === 'esc') key = 'escape';
    return key;
  }

  function Input() {
    this.enabled = false;
    this.layout = {
      joystick: { cx: 0, cy: 0, r: 0, knob: 0 },
      attack: { cx: 0, cy: 0, r: 0 },
      pause: { x: 0, y: 0, w: 0, h: 0 }
    };
    // 深拷贝布局，避免多个 Input 实例互相影响
    var l = DEFAULT_LAYOUT;
    this.layout.joystick = { cx: l.joystick.cx, cy: l.joystick.cy, r: l.joystick.r, knob: l.joystick.knob };
    this.layout.attack = { cx: l.attack.cx, cy: l.attack.cy, r: l.attack.r };
    this.layout.pause = { x: l.pause.x, y: l.pause.y, w: l.pause.w, h: l.pause.h };

    this.keys = {};
    this.move = { x: 0, y: 0, mag: 0 };
    this.joystick = { active: false, pointerId: null, dx: 0, dy: 0, mag: 0, touch: false };
    this.attackHeld = false;
    this.attackPointerId = null;
    this.touchUsed = false;
    this.lastPointerType = 'mouse';
    this.onGesture = null; // 首次交互回调（用于解锁音频）

    this._attackQueued = false;
    this._pauseQueued = false;
    this._canvas = null;
    this._listeners = [];
    this._transform = { scale: 1, offX: 0, offY: 0 };
    this._rect = { left: 0, top: 0, width: 960, height: 540 };
  }

  Input.prototype.attach = function (canvas) {
    if (!canvas) return;
    if (this._canvas === canvas) return;
    this.detach();
    this._canvas = canvas;
    if (canvas.style) canvas.style.touchAction = 'none';

    var self = this;

    this._on(canvas, 'pointerdown', function (e) { self._handlePointerDown(e); });
    this._on(canvas, 'pointermove', function (e) { self._handlePointerMove(e); });
    this._on(canvas, 'pointerup', function (e) { self._handlePointerUp(e); });
    this._on(canvas, 'pointercancel', function (e) { self._handlePointerUp(e); });
    this._on(canvas, 'lostpointercapture', function (e) { self._handlePointerUp(e); });
    this._on(canvas, 'contextmenu', function (e) {
      if (e.preventDefault) e.preventDefault();
    });

    this._on(global, 'keydown', function (e) { self._handleKeyDown(e); });
    this._on(global, 'keyup', function (e) { self._handleKeyUp(e); });
    this._on(global, 'blur', function () { self._resetState(); });
    this._on(global, 'resize', function () { self.refreshRect(); });

    this.refreshRect();
  };

  Input.prototype.detach = function () {
    for (var i = 0; i < this._listeners.length; i++) {
      var l = this._listeners[i];
      try {
        l.target.removeEventListener(l.type, l.fn, l.opts);
      } catch (e) {
        /* ignore */
      }
    }
    this._listeners = [];
    if (this._canvas && this._canvas.style) this._canvas.style.touchAction = '';
    this._canvas = null;
    this._resetState();
  };

  Input.prototype._on = function (target, type, fn, opts) {
    if (!target || typeof target.addEventListener !== 'function') return;
    target.addEventListener(type, fn, opts);
    this._listeners.push({ target: target, type: type, fn: fn, opts: opts });
  };

  Input.prototype._resetState = function () {
    this.keys = {};
    this.move = { x: 0, y: 0, mag: 0 };
    this.joystick.active = false;
    this.joystick.pointerId = null;
    this.joystick.dx = 0;
    this.joystick.dy = 0;
    this.joystick.mag = 0;
    this.attackHeld = false;
    this.attackPointerId = null;
    this._attackQueued = false;
    this._pauseQueued = false;
  };

  /** 游戏未运行时禁止键盘输入，避免影响外壳的 DOM 表单 */
  Input.prototype.setEnabled = function (on) {
    var next = !!on;
    if (!next) {
      this.keys = {};
      this.move = { x: 0, y: 0, mag: 0 };
      this.joystick.active = false;
      this.joystick.pointerId = null;
      this.joystick.dx = 0;
      this.joystick.dy = 0;
      this.joystick.mag = 0;
      this.attackHeld = false;
      this.attackPointerId = null;
      this._attackQueued = false;
      this._pauseQueued = false;
    }
    this.enabled = next;
  };

  Input.prototype.setTransform = function (scale, offX, offY) {
    this._transform.scale = scale || 1;
    this._transform.offX = offX || 0;
    this._transform.offY = offY || 0;
  };

  Input.prototype.refreshRect = function () {
    var c = this._canvas;
    if (c && typeof c.getBoundingClientRect === 'function') {
      var r = c.getBoundingClientRect();
      this._rect = { left: r.left, top: r.top, width: r.width, height: r.height };
    }
  };

  /** 浏览器客户区坐标 -> 游戏逻辑坐标（960x540） */
  Input.prototype.toLogical = function (clientX, clientY) {
    var t = this._transform;
    var scale = t.scale || 1;
    return {
      x: (clientX - this._rect.left - t.offX) / scale,
      y: (clientY - this._rect.top - t.offY) / scale
    };
  };

  Input.prototype._distance = function (p, cx, cy) {
    var dx = p.x - cx;
    var dy = p.y - cy;
    return Math.sqrt(dx * dx + dy * dy);
  };

  Input.prototype._handlePointerDown = function (e) {
    if (this._canvas) this.refreshRect();
    if (typeof this.onGesture === 'function') this.onGesture();

    if (e.pointerType === 'touch' || e.pointerType === 'pen') {
      this.touchUsed = true;
      this.lastPointerType = e.pointerType;
    } else if (e.pointerType) {
      this.lastPointerType = e.pointerType;
    }

    if (!this.enabled) return;
    if (e.preventDefault) e.preventDefault();

    var p = this.toLogical(e.clientX, e.clientY);
    var L = this.layout;

    // 暂停按钮（画在 HUD 右上角）
    if (
      p.x >= L.pause.x - 6 &&
      p.x <= L.pause.x + L.pause.w + 6 &&
      p.y >= L.pause.y - 6 &&
      p.y <= L.pause.y + L.pause.h + 6
    ) {
      this._pauseQueued = true;
      return;
    }

    // 虚拟摇杆
    if (this._distance(p, L.joystick.cx, L.joystick.cy) <= L.joystick.r + 22) {
      this.joystick.active = true;
      this.joystick.pointerId = e.pointerId;
      this.joystick.touch = e.pointerType === 'touch';
      this._updateJoystick(p);
      this._capture(e.pointerId);
      return;
    }

    // 攻击按钮
    if (this._distance(p, L.attack.cx, L.attack.cy) <= L.attack.r + 22) {
      this.attackHeld = true;
      this.attackPointerId = e.pointerId;
      this._attackQueued = true;
      this._capture(e.pointerId);
    }
  };

  Input.prototype._capture = function (pointerId) {
    var c = this._canvas;
    if (!c || typeof c.setPointerCapture !== 'function') return;
    try {
      c.setPointerCapture(pointerId);
    } catch (e) {
      /* ignore */
    }
  };

  Input.prototype._updateJoystick = function (p) {
    var L = this.layout.joystick;
    var dx = (p.x - L.cx) / L.r;
    var dy = (p.y - L.cy) / L.r;
    var len = Math.sqrt(dx * dx + dy * dy);
    if (len > 1) {
      dx /= len;
      dy /= len;
      len = 1;
    }
    this.joystick.dx = dx;
    this.joystick.dy = dy;
    this.joystick.mag = len;
  };

  Input.prototype._handlePointerMove = function (e) {
    if (!this.enabled) return;
    if (!this.joystick.active || e.pointerId !== this.joystick.pointerId) return;
    if (e.preventDefault) e.preventDefault();
    var p = this.toLogical(e.clientX, e.clientY);
    this._updateJoystick(p);
  };

  Input.prototype._handlePointerUp = function (e) {
    if (e.pointerType === 'touch' || e.pointerType === 'pen') this.touchUsed = true;
    if (this.joystick.active && e.pointerId === this.joystick.pointerId) {
      this.joystick.active = false;
      this.joystick.pointerId = null;
      this.joystick.dx = 0;
      this.joystick.dy = 0;
      this.joystick.mag = 0;
    }
    if (this.attackPointerId === e.pointerId) {
      this.attackHeld = false;
      this.attackPointerId = null;
    }
  };

  Input.prototype._handleKeyDown = function (e) {
    if (!this.enabled) return;
    if (isFormTarget(e.target)) return;
    var key = normKey(e);
    if (!key) return;
    if (GAME_KEYS[key]) {
      if (e.preventDefault) e.preventDefault();
    } else {
      return;
    }
    this.keys[key] = true;
    if (key === 'j' || key === ' ') {
      if (!e.repeat) this._attackQueued = true;
      this.attackHeld = true;
    }
    if (key === 'escape') this._pauseQueued = true;
    if (typeof this.onGesture === 'function') this.onGesture();
  };

  Input.prototype._handleKeyUp = function (e) {
    var key = normKey(e);
    if (!key) return;
    delete this.keys[key];
    if (key === 'j' || key === ' ') {
      this.attackHeld = !!(this.keys.j || this.keys[' ']);
    }
  };

  /** 每帧计算移动向量（键盘 8 方向归一化；摇杆优先） */
  Input.prototype.update = function () {
    var j = this.joystick;
    if (this.enabled && j.active && j.mag > 0.14) {
      var mag = j.mag > 1 ? 1 : j.mag;
      this.move.x = j.dx;
      this.move.y = j.dy;
      this.move.mag = mag;
      return this.move;
    }

    var x = 0;
    var y = 0;
    if (this.enabled) {
      if (this.keys.a || this.keys.arrowleft) x -= 1;
      if (this.keys.d || this.keys.arrowright) x += 1;
      if (this.keys.w || this.keys.arrowup) y -= 1;
      if (this.keys.s || this.keys.arrowdown) y += 1;
    }
    if (x !== 0 && y !== 0) {
      var inv = Math.SQRT1_2;
      x *= inv;
      y *= inv;
    }
    this.move.x = x;
    this.move.y = y;
    this.move.mag = x !== 0 || y !== 0 ? 1 : 0;
    return this.move;
  };

  Input.prototype.getMoveVector = function () {
    return this.move;
  };

  Input.prototype.consumeAttack = function () {
    var queued = this._attackQueued;
    this._attackQueued = false;
    return queued;
  };

  Input.prototype.isAttackHeld = function () {
    return this.attackHeld;
  };

  Input.prototype.consumePause = function () {
    var queued = this._pauseQueued;
    this._pauseQueued = false;
    return queued;
  };

  Input.prototype.getLayout = function () {
    return this.layout;
  };

  TQ.Input = Input;
  TQ.INPUT_LAYOUT = DEFAULT_LAYOUT;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { Input: Input, INPUT_LAYOUT: DEFAULT_LAYOUT };
  }
})(typeof window !== 'undefined' ? window : globalThis);

/**
 * 《寻宝奇兵》程序化音效（WebAudio）
 * 不使用任何外部音频文件：所有声音由振荡器 + 噪声实时合成。
 * 浏览器挂载 window.TQ.Audio；无 WebAudio 环境（如 Node）下所有方法安全空转。
 */
(function (global) {
  'use strict';

  var TQ = global.TQ = global.TQ || {};

  var AudioContextCtor = global.AudioContext || global.webkitAudioContext || null;

  var ctx = null;
  var master = null;
  var noiseBuffer = null;
  var enabled = true;
  var unlocked = false;
  var lastPlayAt = {}; // 同名音效最小间隔，避免叠音爆音
  var THROTTLE_MS = { sword: 90, hit: 70, enemyDie: 70, gem: 60, hurt: 160, step: 220, click: 80 };

  function isSupported() {
    return !!AudioContextCtor;
  }

  function ensureContext() {
    if (ctx || !isSupported()) return ctx;
    try {
      ctx = new AudioContextCtor();
      master = ctx.createGain();
      master.gain.value = enabled ? 0.5 : 0;
      master.connect(ctx.destination);
    } catch (e) {
      ctx = null;
      master = null;
    }
    return ctx;
  }

  function ensureNoise() {
    if (noiseBuffer || !ctx) return noiseBuffer;
    var len = Math.floor(ctx.sampleRate * 0.6);
    noiseBuffer = ctx.createBuffer(1, len, ctx.sampleRate);
    var data = noiseBuffer.getChannelData(0);
    for (var i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    return noiseBuffer;
  }

  function now() {
    return ctx ? ctx.currentTime : 0;
  }

  function unlock() {
    if (!isSupported()) return;
    ensureContext();
    if (!ctx) return;
    unlocked = true;
    if (ctx.state === 'suspended' && ctx.resume) {
      ctx.resume().catch(function () {});
    }
  }

  function init() {
    if (typeof global.addEventListener !== 'function') return;
    var kick = function () {
      unlock();
      global.removeEventListener('pointerdown', kick);
      global.removeEventListener('touchstart', kick);
      global.removeEventListener('keydown', kick);
    };
    global.addEventListener('pointerdown', kick, { passive: true });
    global.addEventListener('touchstart', kick, { passive: true });
    global.addEventListener('keydown', kick);
  }

  /** 基础音符：频率扫描 + 包络 */
  function tone(opt) {
    if (!ctx || !master) return;
    var t0 = now() + (opt.delay || 0);
    var dur = opt.dur || 0.15;
    var osc = ctx.createOscillator();
    var gain = ctx.createGain();
    osc.type = opt.type || 'sine';
    osc.frequency.setValueAtTime(Math.max(20, opt.freq), t0);
    if (opt.freqEnd) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(20, opt.freqEnd), t0 + dur);
    }
    var peak = (opt.gain === undefined ? 0.25 : opt.gain) * 0.6;
    var attack = opt.attack === undefined ? 0.008 : opt.attack;
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.linearRampToValueAtTime(peak, t0 + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(gain);
    gain.connect(master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  /** 噪声爆发：用于打击感 / 脚步 / 呼啸 */
  function noise(opt) {
    if (!ctx || !master) return;
    ensureNoise();
    var t0 = now() + (opt.delay || 0);
    var dur = opt.dur || 0.12;
    var src = ctx.createBufferSource();
    src.buffer = noiseBuffer;
    var filter = ctx.createBiquadFilter();
    filter.type = opt.filter || 'bandpass';
    filter.frequency.setValueAtTime(Math.max(40, opt.freq || 1200), t0);
    if (opt.freqEnd) {
      filter.frequency.exponentialRampToValueAtTime(Math.max(40, opt.freqEnd), t0 + dur);
    }
    filter.Q.value = opt.q === undefined ? 1 : opt.q;
    var gain = ctx.createGain();
    var peak = (opt.gain === undefined ? 0.2 : opt.gain) * 0.5;
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.linearRampToValueAtTime(peak, t0 + 0.006);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(filter);
    filter.connect(gain);
    gain.connect(master);
    src.start(t0);
    src.stop(t0 + dur + 0.02);
  }

  var SOUNDS = {
    sword: function () {
      noise({ dur: 0.16, gain: 0.32, filter: 'highpass', freq: 2200, freqEnd: 700, q: 0.8 });
      tone({ type: 'sawtooth', freq: 640, freqEnd: 220, dur: 0.09, gain: 0.1 });
    },
    hit: function () {
      tone({ type: 'square', freq: 150, freqEnd: 70, dur: 0.09, gain: 0.22 });
      noise({ dur: 0.06, gain: 0.2, filter: 'lowpass', freq: 900, q: 2 });
    },
    enemyDie: function () {
      tone({ type: 'sawtooth', freq: 320, freqEnd: 48, dur: 0.32, gain: 0.2 });
      noise({ dur: 0.28, gain: 0.18, filter: 'lowpass', freq: 1600, freqEnd: 220, q: 1 });
    },
    gem: function () {
      tone({ type: 'sine', freq: 1046.5, dur: 0.1, gain: 0.18 });
      tone({ type: 'sine', freq: 1568, dur: 0.18, gain: 0.16, delay: 0.06 });
      tone({ type: 'triangle', freq: 2093, dur: 0.16, gain: 0.08, delay: 0.1 });
    },
    key: function () {
      tone({ type: 'triangle', freq: 1318.5, dur: 0.09, gain: 0.2 });
      tone({ type: 'triangle', freq: 1760, dur: 0.09, gain: 0.18, delay: 0.07 });
      tone({ type: 'sine', freq: 2637, dur: 0.18, gain: 0.1, delay: 0.13 });
    },
    door: function () {
      tone({ type: 'square', freq: 110, freqEnd: 55, dur: 0.38, gain: 0.2 });
      noise({ dur: 0.36, gain: 0.2, filter: 'lowpass', freq: 620, freqEnd: 160, q: 1.2 });
    },
    hurt: function () {
      tone({ type: 'sawtooth', freq: 330, freqEnd: 90, dur: 0.24, gain: 0.24 });
      noise({ dur: 0.14, gain: 0.16, filter: 'lowpass', freq: 700, q: 1 });
    },
    die: function () {
      tone({ type: 'sawtooth', freq: 440, freqEnd: 42, dur: 0.85, gain: 0.26 });
      tone({ type: 'square', freq: 220, freqEnd: 30, dur: 0.8, gain: 0.12, delay: 0.08 });
    },
    heal: function () {
      tone({ type: 'sine', freq: 523.25, dur: 0.12, gain: 0.18 });
      tone({ type: 'sine', freq: 783.99, dur: 0.14, gain: 0.16, delay: 0.08 });
      tone({ type: 'sine', freq: 1046.5, dur: 0.22, gain: 0.14, delay: 0.16 });
    },
    portal: function () {
      noise({ dur: 0.6, gain: 0.22, filter: 'bandpass', freq: 300, freqEnd: 2800, q: 3 });
      tone({ type: 'sine', freq: 392, freqEnd: 1568, dur: 0.6, gain: 0.14 });
    },
    win: function () {
      var notes = [523.25, 659.25, 783.99, 1046.5];
      for (var i = 0; i < notes.length; i++) {
        tone({ type: 'triangle', freq: notes[i], dur: 0.24, gain: 0.2, delay: i * 0.13 });
      }
      tone({ type: 'sine', freq: 1568, dur: 0.5, gain: 0.14, delay: 0.52 });
    },
    spike: function () {
      noise({ dur: 0.07, gain: 0.18, filter: 'highpass', freq: 2600, q: 1 });
      tone({ type: 'square', freq: 200, freqEnd: 90, dur: 0.08, gain: 0.1 });
    },
    click: function () {
      tone({ type: 'square', freq: 880, freqEnd: 660, dur: 0.05, gain: 0.1 });
    },
    step: function () {
      noise({ dur: 0.045, gain: 0.045, filter: 'lowpass', freq: 520, q: 1.2 });
      tone({ type: 'sine', freq: 190, freqEnd: 140, dur: 0.045, gain: 0.035 });
    },
    spawn: function () {
      tone({ type: 'sine', freq: 300, freqEnd: 900, dur: 0.3, gain: 0.12 });
    }
  };

  function play(name) {
    if (!enabled) return;
    if (!isSupported()) return;
    if (!ctx) {
      // 首次触发通常发生在用户手势内，可直接创建；否则静默跳过
      ensureContext();
      if (!ctx) return;
    }
    if (ctx.state === 'suspended') {
      if (ctx.resume) ctx.resume().catch(function () {});
    }
    var fn = SOUNDS[name];
    if (!fn) return;
    var t = Date.now();
    var gap = THROTTLE_MS[name];
    if (gap && lastPlayAt[name] && t - lastPlayAt[name] < gap) return;
    lastPlayAt[name] = t;
    try {
      fn();
    } catch (e) {
      /* 音频失败不影响游戏 */
    }
  }

  function setEnabled(on) {
    enabled = !!on;
    if (master) {
      master.gain.value = enabled ? 0.5 : 0;
    }
    if (enabled) {
      unlock();
      play('click');
    }
  }

  function isEnabled() {
    return enabled;
  }

  var Audio = {
    init: init,
    unlock: unlock,
    play: play,
    setEnabled: setEnabled,
    isEnabled: isEnabled,
    isSupported: isSupported
  };

  TQ.Audio = Audio;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { Audio: Audio };
  }
})(typeof window !== 'undefined' ? window : globalThis);

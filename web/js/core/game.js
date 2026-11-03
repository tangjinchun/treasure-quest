/**
 * 《寻宝奇兵》游戏核心 TQ.Game
 * 对外接口与事件严格遵循 docs/GAMEDESIGN.md 5.2 节。
 * 逻辑分辨率 960x540，自适应缩放 + letterbox + devicePixelRatio。
 * 不操作 DOM 其他元素，不依赖外壳 API，只通过 opts.onEvent 上报事件。
 */
(function (global) {
  'use strict';

  var TQ = global.TQ = global.TQ || {};

  var VIEW_W = 960;
  var VIEW_H = 540;
  var TILE = 32;

  // ---------------------------------------------------------------------------
  // 玩法数值（见 docs/GAMEDESIGN.md 第 3 节）
  // ---------------------------------------------------------------------------
  var PLAYER_SPEED = 150;
  var PLAYER_RADIUS = 11;
  var PLAYER_HIT_HALF = 9;
  var PLAYER_MAX_HP = 3;
  var PLAYER_INVULN = 1.2;
  var PLAYER_SPAWN_PROTECT = 0.9;
  var PLAYER_KNOCKBACK = 175;

  var SWORD_COOLDOWN = 0.35;
  var SWORD_SWING_TIME = 0.18;
  var SWORD_RANGE = 30;
  var SWORD_HALF_ANGLE = Math.PI / 3;

  var SPIKE_PERIOD = 2.4;
  var SPIKE_UP_TIME = 1.1;
  var SPIKE_DAMAGE = 1;

  var ENEMY_CFG = {
    slime: { hp: 2, speed: 46, radius: 13, damage: 1, knockback: 210, patrolRange: 150, score: 1 },
    bat: { hp: 1, speed: 70, radius: 11, damage: 1, knockback: 120, score: 1 },
    ghost: { hp: 3, speed: 40, radius: 13, damage: 1, knockback: 90, leash: 480, score: 1 }
  };

  var ENEMY_NAMES = { slime: '史莱姆', bat: '蝙蝠', ghost: '幽灵' };

  var LEVEL_SUBTITLES = [
    '收集全部宝石，前往传送门',
    '找到钥匙打开锁门，收集全部宝石',
    '小心尖刺与幽灵，收集全部宝石',
    '穿过云海找到钥匙，打开秘殿之门'
  ];

  // ---------------------------------------------------------------------------
  // 内部状态
  // ---------------------------------------------------------------------------
  var S = {
    initialized: false,
    destroyed: false,
    canvas: null,
    ctx: null,
    onEvent: null,
    input: null,
    autoLoop: true,
    loopId: 0,
    lastTs: 0,
    dpr: 1,
    cssW: VIEW_W,
    cssH: VIEW_H,
    scale: 1,
    offX: 0,
    offY: 0,
    status: 'idle', // idle | playing | paused | dead | complete
    levelIndex: 0,
    level: null,
    player: null,
    enemies: [],
    items: [],
    spikes: [],
    door: null,
    portal: null,
    particles: [],
    cam: { x: 0, y: 0, shake: 0, sx: 0, sy: 0 },
    timeMs: 0,
    elapsed: 0,
    attackCd: 0,
    gemsTotal: 0,
    gemsCollected: 0,
    damageFlash: 0,
    hint: { text: '', alpha: 0, ttl: 0 },
    hintCooldowns: {},
    titleTimer: 0,
    resizeObs: null,
    resizeCheck: 0,
    windowListeners: [],
    docListeners: []
  };

  function now() {
    if (global.performance && typeof global.performance.now === 'function') return global.performance.now();
    return Date.now();
  }

  function warn(msg, err) {
    if (global.console && typeof global.console.warn === 'function') {
      global.console.warn('[TQ.Game] ' + msg, err || '');
    }
  }

  function emit(type, data) {
    var cb = S.onEvent;
    if (typeof cb !== 'function') return;
    var ev = { type: type };
    if (data) {
      for (var k in data) {
        if (Object.prototype.hasOwnProperty.call(data, k)) ev[k] = data[k];
      }
    }
    try {
      cb(ev);
    } catch (e) {
      warn('onEvent handler error for "' + type + '"', e);
    }
  }

  function levelCount() {
    return TQ.Levels && TQ.Levels.length ? TQ.Levels.length : 0;
  }

  function isBlocking(ch) {
    if (TQ.LevelData && TQ.LevelData.isBlockingChar) {
      return TQ.LevelData.isBlockingChar(ch, S.door ? S.door.open : false);
    }
    if (ch === '#' || ch === '~' || ch === 'T') return true;
    if (ch === 'D') return !(S.door && S.door.open);
    return false;
  }

  function hash2(x, y) {
    if (TQ.Util && TQ.Util.hash2) return TQ.Util.hash2(x, y);
    var h = (x | 0) * 374761393 + (y | 0) * 668265263;
    h = (h ^ (h >>> 13)) * 1274126177;
    return ((h ^ (h >>> 16)) >>> 0) % 100000 / 100000;
  }

  function clamp(v, a, b) {
    if (TQ.Util && TQ.Util.clamp) return TQ.Util.clamp(v, a, b);
    return v < a ? a : v > b ? b : v;
  }

  function damp(a, b, lambda, dt) {
    if (TQ.Util && TQ.Util.damp) return TQ.Util.damp(a, b, lambda, dt);
    return a + (b - a) * (1 - Math.exp(-lambda * dt));
  }

  function dist(x1, y1, x2, y2) {
    var dx = x2 - x1;
    var dy = y2 - y1;
    return Math.sqrt(dx * dx + dy * dy);
  }

  function playSound(name) {
    if (TQ.Audio && typeof TQ.Audio.play === 'function') TQ.Audio.play(name);
  }

  function gfx() {
    return TQ.Graphics;
  }

  function formatTime(ms) {
    if (TQ.Util && TQ.Util.formatTime) return TQ.Util.formatTime(ms);
    var total = Math.max(0, Math.floor(ms / 1000));
    return String(Math.floor(total / 60)).padStart(2, '0') + ':' + String(total % 60).padStart(2, '0');
  }

  // ---------------------------------------------------------------------------
  // 关卡构建
  // ---------------------------------------------------------------------------
  function centerOf(tx, ty) {
    return { x: tx * TILE + TILE / 2, y: ty * TILE + TILE / 2 };
  }

  function makeEnemy(kind, tx, ty) {
    var cfg = ENEMY_CFG[kind];
    var c = centerOf(tx, ty);
    var h = hash2(tx * 3 + 1, ty * 5 + 2);
    return {
      kind: kind,
      tx: tx,
      ty: ty,
      x: c.x,
      y: c.y,
      anchorX: c.x,
      anchorY: c.y,
      homeX: c.x,
      homeY: c.y,
      hp: cfg.hp,
      maxHp: cfg.hp,
      r: cfg.radius,
      speed: cfg.speed,
      damage: cfg.damage,
      dir: h > 0.5 ? 1 : -1,
      phase: h * TAU_LOCAL,
      anim: h * 10,
      flash: 0,
      dead: false,
      kx: 0,
      ky: 0,
      hitHalf: cfg.radius * 0.7
    };
  }

  var TAU_LOCAL = Math.PI * 2;

  function buildLevel(index) {
    var defs = TQ.Levels;
    if (!defs || !defs[index]) return false;
    var def = defs[index];
    var rows = def.rows;
    var h = rows.length;
    var w = rows[0].length;
    var grid = [];
    var items = [];
    var enemies = [];
    var spikes = [];
    var spawn = null;
    var portal = null;
    var door = null;
    var gemsTotal = 0;

    for (var y = 0; y < h; y++) {
      var row = rows[y];
      var gridRow = [];
      for (var x = 0; x < w; x++) {
        var ch = row.charAt(x) || '.';
        var tx = x;
        var ty = y;
        var c = centerOf(tx, ty);
        switch (ch) {
          case 'P':
            spawn = c;
            gridRow.push('.');
            break;
          case 'E':
            portal = { tx: tx, ty: ty, x: c.x, y: c.y, activated: false, theme: def.theme };
            gridRow.push('E');
            break;
          case 'D':
            door = { tx: tx, ty: ty, x: c.x, y: c.y, open: false, theme: def.theme };
            gridRow.push('D');
            break;
          case '^':
            spikes.push({ tx: tx, ty: ty, x: c.x, y: c.y, phase: hash2(tx, ty) * SPIKE_PERIOD, theme: def.theme });
            gridRow.push('^');
            break;
          case 'G':
            items.push({ kind: 'gem', id: 'gem-' + index + '-' + tx + '-' + ty, tx: tx, ty: ty, x: c.x, y: c.y, phase: hash2(tx + 3, ty + 11) * TAU_LOCAL });
            gridRow.push('.');
            gemsTotal++;
            break;
          case 'K':
            items.push({ kind: 'key', id: 'key-' + index + '-' + tx + '-' + ty, tx: tx, ty: ty, x: c.x, y: c.y, phase: hash2(tx + 5, ty + 7) * TAU_LOCAL });
            gridRow.push('.');
            break;
          case 'H':
            items.push({ kind: 'heal', id: 'heal-' + index + '-' + tx + '-' + ty, tx: tx, ty: ty, x: c.x, y: c.y, phase: hash2(tx + 9, ty + 2) * TAU_LOCAL });
            gridRow.push('.');
            break;
          case '1':
            enemies.push(makeEnemy('slime', tx, ty));
            gridRow.push('.');
            break;
          case '2':
            enemies.push(makeEnemy('bat', tx, ty));
            gridRow.push('.');
            break;
          case '3':
            enemies.push(makeEnemy('ghost', tx, ty));
            gridRow.push('.');
            break;
          default:
            gridRow.push(ch);
        }
      }
      grid.push(gridRow);
    }

    if (!spawn) return false;
    if (!portal) {
      var lastRow = grid[h - 2] || [];
      portal = { tx: w - 2, ty: h - 2, x: (w - 2) * TILE + TILE / 2, y: (h - 2) * TILE + TILE / 2, activated: false, theme: def.theme };
      if (lastRow.length) lastRow[w - 2] = 'E';
    }

    S.level = {
      index: index,
      def: def,
      name: def.name,
      theme: def.theme,
      width: w,
      height: h,
      tileSize: TILE,
      grid: grid,
      mapW: w * TILE,
      mapH: h * TILE
    };
    S.items = items;
    S.enemies = enemies;
    S.spikes = spikes;
    S.door = door;
    S.portal = portal;
    S.gemsTotal = gemsTotal;
    S.gemsCollected = 0;
    S.particles = [];
    S.timeMs = 0;
    S.elapsed = 0;
    S.attackCd = 0;
    S.damageFlash = 0;
    S.hint = { text: '', alpha: 0, ttl: 0 };
    S.hintCooldowns = {};
    S.titleTimer = 2.6;
    S.status = 'playing';

    S.player = {
      x: spawn.x,
      y: spawn.y,
      r: PLAYER_RADIUS,
      hitHalf: PLAYER_HIT_HALF,
      hp: PLAYER_MAX_HP,
      maxHp: PLAYER_MAX_HP,
      facing: Math.PI / 2,
      walkTime: 0,
      moving: false,
      invuln: PLAYER_SPAWN_PROTECT,
      hasKey: false,
      swing: 0,
      swingTotal: SWORD_SWING_TIME,
      swingDir: Math.PI / 2,
      kx: 0,
      ky: 0
    };

    // 相机初始定位（立即钳制，避免开场漂移）
    positionCamera(0, true);

    if (S.input) {
      S.input.setEnabled(true);
      S.input.consumeAttack();
      S.input.consumePause();
    }

    emit('levelStart', { level: index });
    emit('playerHp', { hp: S.player.hp, maxHp: S.player.maxHp });
    playSound('spawn');
    return true;
  }

  function positionCamera(dt, instant) {
    if (!S.level || !S.player) return;
    var p = S.player;
    var maxX = Math.max(0, S.level.mapW - VIEW_W);
    var maxY = Math.max(0, S.level.mapH - VIEW_H);
    var targetX = p.x - VIEW_W / 2;
    var targetY = p.y - VIEW_H / 2;
    if (S.level.mapW < VIEW_W) targetX = (S.level.mapW - VIEW_W) / 2;
    if (S.level.mapH < VIEW_H) targetY = (S.level.mapH - VIEW_H) / 2;
    targetX = clamp(targetX, 0, maxX);
    targetY = clamp(targetY, 0, maxY);
    if (instant || dt <= 0) {
      S.cam.x = targetX;
      S.cam.y = targetY;
    } else {
      S.cam.x = damp(S.cam.x, targetX, 9, dt);
      S.cam.y = damp(S.cam.y, targetY, 9, dt);
    }
  }

  // ---------------------------------------------------------------------------
  // 碰撞
  // ---------------------------------------------------------------------------
  function findBlockingTile(ent, halfOverride) {
    if (!S.level) return null;
    var level = S.level;
    var half = halfOverride === undefined ? ent.hitHalf || ent.r * 0.8 : halfOverride;
    var x0 = Math.floor((ent.x - half) / TILE);
    var x1 = Math.floor((ent.x + half) / TILE);
    var y0 = Math.floor((ent.y - half) / TILE);
    var y1 = Math.floor((ent.y + half) / TILE);
    for (var ty = y0; ty <= y1; ty++) {
      for (var tx = x0; tx <= x1; tx++) {
        if (tx < 0 || ty < 0 || tx >= level.width || ty >= level.height) {
          return { tx: tx, ty: ty, ch: '#' };
        }
        var ch = level.grid[ty][tx];
        if (isBlocking(ch)) return { tx: tx, ty: ty, ch: ch };
      }
    }
    return null;
  }

  function moveWithCollision(ent, dx, dy) {
    if (dx) {
      ent.x += dx;
      var hitX = findBlockingTile(ent);
      if (hitX) {
        ent.x -= dx;
        if (hitX.ch === 'D') tryOpenDoor();
      }
    }
    if (dy) {
      ent.y += dy;
      var hitY = findBlockingTile(ent);
      if (hitY) {
        ent.y -= dy;
        if (hitY.ch === 'D') tryOpenDoor();
      }
    }
    if (S.level) {
      ent.x = clamp(ent.x, ent.r, S.level.mapW - ent.r);
      ent.y = clamp(ent.y, ent.r, S.level.mapH - ent.r);
    }
  }

  function tryOpenDoor() {
    var door = S.door;
    var p = S.player;
    if (!door || door.open) return;
    if (p && p.hasKey) {
      door.open = true;
      if (S.level) S.level.grid[door.ty][door.tx] = '.';
      emit('door', { opened: true });
      playSound('door');
      showHint('锁门已开启！', 2.2);
      var g = gfx();
      if (g && g.burst) {
        g.burst(S.particles, door.x, door.y, 18, {
          colors: ['#f5c542', '#8a6236', '#d9b96a'],
          speed: [40, 170],
          life: [0.3, 0.7],
          gravity: 160,
          shape: 'rect'
        });
      }
      S.cam.shake = Math.max(S.cam.shake, 6);
    } else {
      hintThrottled('这扇门锁住了，需要钥匙', 'door-locked', 2.0);
    }
  }

  // ---------------------------------------------------------------------------
  // 玩家
  // ---------------------------------------------------------------------------
  function updatePlayer(dt) {
    var p = S.player;
    var input = S.input;
    if (!p || !input) return;

    var mv = input.getMoveVector();
    p.moving = mv.mag > 0.01;
    if (p.moving) {
      p.facing = Math.atan2(mv.y, mv.x);
      p.walkTime += dt;
      moveWithCollision(p, mv.x * PLAYER_SPEED * dt, mv.y * PLAYER_SPEED * dt);
      // 脚步音效（低音量，避免吵）
      if (Math.floor(p.walkTime * 3.2) % 2 === 0) playSound('step');
    }

    // 攻击：边沿触发 + 长按连击（受冷却限制）
    var queued = input.consumeAttack();
    if ((queued || input.isAttackHeld()) && S.attackCd <= 0) {
      startSwing();
    }
    if (S.attackCd > 0) S.attackCd -= dt;
    if (p.swing > 0) {
      p.swing -= dt;
      if (p.swing < 0) p.swing = 0;
      checkSwordHits();
    }
    if (p.invuln > 0) p.invuln = Math.max(0, p.invuln - dt);

    // 受击击退
    if (Math.abs(p.kx) > 2 || Math.abs(p.ky) > 2) {
      moveWithCollision(p, p.kx * dt, p.ky * dt);
      p.kx = damp(p.kx, 0, 9, dt);
      p.ky = damp(p.ky, 0, 9, dt);
    } else {
      p.kx = 0;
      p.ky = 0;
    }
  }

  function startSwing() {
    var p = S.player;
    if (!p || S.status !== 'playing') return;
    p.swing = SWORD_SWING_TIME;
    p.swingTotal = SWORD_SWING_TIME;
    p.swingDir = p.facing;
    S.attackCd = SWORD_COOLDOWN;
    S.swordHitIds = {};
    playSound('sword');
    checkSwordHits();
  }

  function checkSwordHits() {
    var p = S.player;
    if (!p || !S.swordHitIds) return;
    var range = p.r + SWORD_RANGE;
    for (var i = 0; i < S.enemies.length; i++) {
      var e = S.enemies[i];
      if (e.dead) continue;
      var key = e.kind + '-' + e.tx + '-' + e.ty;
      if (S.swordHitIds[key]) continue;
      var dx = e.x - p.x;
      var dy = e.y - p.y;
      var d = Math.sqrt(dx * dx + dy * dy);
      if (d > range + e.r) continue;
      var angle = Math.atan2(dy, dx);
      var diff = angle - p.swingDir;
      while (diff > Math.PI) diff -= TAU_LOCAL;
      while (diff < -Math.PI) diff += TAU_LOCAL;
      if (Math.abs(diff) > SWORD_HALF_ANGLE) continue;
      S.swordHitIds[key] = true;
      hitEnemy(e, Math.atan2(dy, dx));
    }
  }

  function hitEnemy(e, angle) {
    var cfg = ENEMY_CFG[e.kind];
    e.hp -= 1;
    e.flash = 0.14;
    e.kx += Math.cos(angle) * cfg.knockback;
    e.ky += Math.sin(angle) * cfg.knockback;
    playSound('hit');
    S.cam.shake = Math.max(S.cam.shake, 4);
    var g = gfx();
    if (g && g.burst) {
      g.burst(S.particles, e.x, e.y, 8, {
        colors: ['#ffffff', '#ffe9a3', '#ffb35a'],
        speed: [60, 200],
        life: [0.15, 0.35],
        size: [2, 3.6],
        shape: 'spark'
      });
    }
    if (e.hp <= 0) killEnemy(e);
  }

  function killEnemy(e) {
    if (e.dead) return;
    e.dead = true;
    playSound('enemyDie');
    S.cam.shake = Math.max(S.cam.shake, 7);
    var g = gfx();
    var colors = e.kind === 'ghost' ? ['#b9c6e8', '#8f9bd0', '#ffffff'] : e.kind === 'bat' ? ['#5a4a7c', '#8f7ab8', '#ffffff'] : ['#46c96a', '#8bf0a5', '#ffffff'];
    if (g && g.burst) {
      g.burst(S.particles, e.x, e.y, 20, {
        colors: colors,
        speed: [50, 210],
        life: [0.3, 0.8],
        size: [2, 5],
        gravity: 120,
        shape: 'rect'
      });
    }
    emit('enemyKilled', { kind: e.kind });
  }

  function damagePlayer(amount, srcX, srcY) {
    var p = S.player;
    if (!p || S.status !== 'playing') return;
    if (p.invuln > 0) return;
    p.hp -= amount;
    p.invuln = PLAYER_INVULN;
    S.damageFlash = 0.85;
    S.cam.shake = Math.max(S.cam.shake, 10);
    var angle = Math.atan2(p.y - srcY, p.x - srcX);
    p.kx = Math.cos(angle) * PLAYER_KNOCKBACK;
    p.ky = Math.sin(angle) * PLAYER_KNOCKBACK;
    var g = gfx();
    if (g && g.burst) {
      g.burst(S.particles, p.x, p.y, 14, {
        colors: ['#ff6b6b', '#ffd0d0', '#c62b3f'],
        speed: [70, 220],
        life: [0.25, 0.6],
        size: [2, 4],
        shape: 'spark'
      });
    }
    playSound('hurt');
    emit('playerHp', { hp: Math.max(0, p.hp), maxHp: p.maxHp });
    if (p.hp <= 0) playerDie();
  }

  function playerDie() {
    var p = S.player;
    if (!p || S.status !== 'playing') return;
    p.hp = 0;
    S.status = 'dead';
    S.cam.shake = 14;
    S.damageFlash = 1;
    if (S.input) S.input.setEnabled(false);
    var g = gfx();
    if (g && g.burst) {
      g.burst(S.particles, p.x, p.y, 36, {
        colors: ['#d9a441', '#ff6b6b', '#ffffff', '#f5c542'],
        speed: [60, 260],
        life: [0.5, 1.2],
        size: [2, 6],
        gravity: 180,
        shape: 'rect'
      });
    }
    playSound('die');
    emit('playerDied', { level: S.levelIndex });
  }

  function completeLevel() {
    if (S.status !== 'playing') return;
    S.status = 'complete';
    if (S.input) S.input.setEnabled(false);
    playSound('win');
    S.cam.shake = Math.max(S.cam.shake, 6);
    var g = gfx();
    var p = S.player;
    if (g && g.burst) {
      g.burst(S.particles, S.portal ? S.portal.x : p.x, S.portal ? S.portal.y : p.y, 40, {
        colors: ['#f5c542', '#fff4c2', '#61e0c2', '#ffffff'],
        speed: [50, 260],
        life: [0.5, 1.3],
        size: [2, 5],
        gravity: 40,
        shape: 'spark'
      });
    }
    emit('levelComplete', {
      level: S.levelIndex,
      treasures: S.gemsCollected,
      total: S.gemsTotal,
      timeMs: Math.round(S.timeMs),
      hp: Math.max(0, p.hp)
    });
  }

  // ---------------------------------------------------------------------------
  // 敌人 AI
  // ---------------------------------------------------------------------------
  function updateEnemies(dt) {
    var p = S.player;
    if (!p) return;
    for (var i = 0; i < S.enemies.length; i++) {
      var e = S.enemies[i];
      if (e.dead) continue;
      e.anim += dt;
      if (e.flash > 0) e.flash = Math.max(0, e.flash - dt);

      // 击退位移
      if (Math.abs(e.kx) > 1 || Math.abs(e.ky) > 1) {
        var mx = e.kx * dt;
        var my = e.ky * dt;
        if (e.kind === 'slime') {
          e.x += mx;
          if (findBlockingTile(e)) e.x -= mx;
          e.y += my;
          if (findBlockingTile(e)) e.y -= my;
        } else if (e.kind === 'bat') {
          e.homeX = clamp(e.homeX + mx * 0.4, e.anchorX - 100, e.anchorX + 100);
          e.homeY = clamp(e.homeY + my * 0.4, e.anchorY - 80, e.anchorY + 80);
        } else {
          e.x += mx;
          e.y += my;
        }
        e.kx = damp(e.kx, 0, 9, dt);
        e.ky = damp(e.ky, 0, 9, dt);
      } else {
        e.kx = 0;
        e.ky = 0;
      }

      if (e.kind === 'slime') {
        // 地面巡逻：来回移动，周期性停顿
        var idle = Math.sin(e.anim * 1.35) > 0.8;
        if (!idle) {
          var stepX = e.dir * e.speed * dt;
          var nextX = e.x + stepX;
          if (Math.abs(nextX - e.homeX) > ENEMY_CFG.slime.patrolRange / 2) {
            e.dir *= -1;
          } else {
            e.x = nextX;
            if (findBlockingTile(e)) {
              e.x = nextX - stepX;
              e.dir *= -1;
            }
          }
        }
      } else if (e.kind === 'bat') {
        // 正弦轨迹飞行，忽略墙体
        var t = e.anim * 1.15;
        e.x = e.homeX + Math.sin(t + e.phase) * 78;
        e.y = e.homeY + Math.sin(t * 1.62 + e.phase * 1.7) * 42;
        e.x = clamp(e.x, e.r, S.level.mapW - e.r);
        e.y = clamp(e.y, e.r, S.level.mapH - e.r);
      } else if (e.kind === 'ghost') {
        // 缓慢追踪玩家（穿墙，超出巢穴范围则返回）
        var leash = ENEMY_CFG.ghost.leash;
        var fromHome = dist(e.anchorX, e.anchorY, p.x, p.y);
        var tx = fromHome < leash ? p.x : e.anchorX;
        var ty = fromHome < leash ? p.y : e.anchorY;
        var dx = tx - e.x;
        var dy = ty - e.y;
        var len = Math.sqrt(dx * dx + dy * dy);
        if (len > 2) {
          e.x += (dx / len) * e.speed * dt;
          e.y += (dy / len) * e.speed * dt;
        }
        e.x = clamp(e.x, e.r, S.level.mapW - e.r);
        e.y = clamp(e.y, e.r, S.level.mapH - e.r);
      }
    }
  }

  function checkEnemyContact() {
    var p = S.player;
    if (!p) return;
    for (var i = 0; i < S.enemies.length; i++) {
      var e = S.enemies[i];
      if (e.dead) continue;
      var d = dist(p.x, p.y, e.x, e.y);
      if (d < p.r + e.r - 3) {
        if (p.invuln <= 0) {
          damagePlayer(e.damage, e.x, e.y);
        }
        // 轻微推开，避免持续重叠（若会被推进墙里则保持原位）
        if (d > 0.001) {
          var oldX = p.x;
          var oldY = p.y;
          var push = 14 * (1 - d / (p.r + e.r));
          p.x += ((p.x - e.x) / d) * push;
          p.y += ((p.y - e.y) / d) * push;
          if (findBlockingTile(p)) {
            p.x = oldX;
            p.y = oldY;
          }
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 尖刺 / 道具 / 传送门
  // ---------------------------------------------------------------------------
  function spikeIsUp(spike) {
    var cycle = (S.elapsed + spike.phase) % SPIKE_PERIOD;
    if (cycle < 0) cycle += SPIKE_PERIOD;
    return cycle < SPIKE_UP_TIME;
  }

  function checkSpikeDamage() {
    var p = S.player;
    if (!p || p.invuln > 0) return;
    for (var i = 0; i < S.spikes.length; i++) {
      var s = S.spikes[i];
      if (!spikeIsUp(s)) continue;
      var x = s.tx * TILE + 7;
      var y = s.ty * TILE + 7;
      var w = TILE - 14;
      var h = TILE - 14;
      var nx = clamp(p.x, x, x + w);
      var ny = clamp(p.y, y, y + h);
      var dx = p.x - nx;
      var dy = p.y - ny;
      if (dx * dx + dy * dy <= 7 * 7) {
        damagePlayer(SPIKE_DAMAGE, s.x, s.y);
        playSound('spike');
        S.cam.shake = Math.max(S.cam.shake, 5);
        break;
      }
    }
  }

  function removeItem(item) {
    for (var i = 0; i < S.items.length; i++) {
      if (S.items[i] === item) {
        S.items.splice(i, 1);
        return;
      }
    }
  }

  function collectGem(item) {
    if (S.status !== 'playing') return;
    removeItem(item);
    S.gemsCollected++;
    playSound('gem');
    S.cam.shake = Math.max(S.cam.shake, 2.5);
    var g = gfx();
    if (g && g.burst) {
      g.burst(S.particles, item.x, item.y, 16, {
        colors: ['#e6fbff', '#5bd7ff', '#1a6fae', '#ffffff'],
        speed: [40, 190],
        life: [0.3, 0.7],
        size: [2, 4],
        shape: 'spark'
      });
    }
    emit('treasure', {
      collected: S.gemsCollected,
      total: S.gemsTotal,
      treasureId: item.id
    });
    if (S.gemsCollected >= S.gemsTotal && !S.portal.activated) {
      S.portal.activated = true;
      playSound('portal');
      showHint('传送门已激活，前往出口！', 3);
      S.cam.shake = Math.max(S.cam.shake, 5);
      if (g && g.burst) {
        g.burst(S.particles, S.portal.x, S.portal.y, 26, {
          colors: ['#f5c542', '#fff4c2', '#61e0c2'],
          speed: [40, 160],
          life: [0.5, 1.1],
          size: [2, 5],
          shape: 'spark'
        });
      }
    }
  }

  function collectKey(item) {
    removeItem(item);
    S.player.hasKey = true;
    playSound('key');
    showHint('拿到钥匙！去打开锁门', 3);
    var g = gfx();
    if (g && g.burst) {
      g.burst(S.particles, item.x, item.y, 20, {
        colors: ['#f5c542', '#ffe9a3', '#ffffff'],
        speed: [50, 180],
        life: [0.3, 0.8],
        size: [2, 4],
        shape: 'spark'
      });
    }
    emit('key', { collected: true });
  }

  function collectHeal(item) {
    removeItem(item);
    var p = S.player;
    p.hp = Math.min(p.maxHp, p.hp + 1);
    playSound('heal');
    showHint('生命 +1', 1.6);
    var g = gfx();
    if (g && g.burst) {
      g.burst(S.particles, item.x, item.y, 18, {
        colors: ['#ff8a9a', '#ffd0d0', '#8ef06a'],
        speed: [40, 150],
        life: [0.3, 0.7],
        size: [2, 4],
        shape: 'rect',
        gravity: -40
      });
    }
    emit('playerHp', { hp: p.hp, maxHp: p.maxHp });
  }

  function updateItems() {
    var p = S.player;
    if (!p) return;
    var g = gfx();
    for (var i = S.items.length - 1; i >= 0; i--) {
      var item = S.items[i];
      var d = dist(p.x, p.y, item.x, item.y);
      if (item.kind === 'gem') {
        if (d < p.r + 13) collectGem(item);
      } else if (item.kind === 'key') {
        if (d < p.r + 15) collectKey(item);
      } else if (item.kind === 'heal') {
        if (d < p.r + 13) {
          if (p.hp < p.maxHp) collectHeal(item);
          else hintThrottled('生命已满，稍后再来拾取', 'heal-full', 1.8);
        }
      }
    }
    if (g) {
      // 传送门交互
      var portal = S.portal;
      if (portal) {
        var pd = dist(p.x, p.y, portal.x, portal.y);
        if (pd < p.r + 20) {
          if (portal.activated) {
            completeLevel();
          } else {
            hintThrottled('还差 ' + (S.gemsTotal - S.gemsCollected) + ' 颗宝石才能激活传送门', 'portal-locked', 2.2);
          }
        }
      }
    }
    // 靠近锁门时提示 / 有钥匙自动开门
    if (S.door && !S.door.open) {
      var dd = dist(p.x, p.y, S.door.x, S.door.y);
      if (dd < 34) {
        if (p.hasKey) tryOpenDoor();
        else hintThrottled('这扇门锁住了，需要钥匙', 'door-locked', 2.0);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 提示 / 特效
  // ---------------------------------------------------------------------------
  function showHint(text, seconds) {
    S.hint.text = text;
    S.hint.alpha = 1;
    S.hint.ttl = seconds || 2.2;
    emit('hint', { text: text });
  }

  function hintThrottled(text, key, seconds) {
    var cd = S.hintCooldowns[key] || 0;
    if (cd > 0) return;
    showHint(text, seconds);
    S.hintCooldowns[key] = (seconds || 2.2) + 0.8;
  }

  function tickHint(dt) {
    if (S.hint.ttl > 0) {
      S.hint.ttl -= dt;
      S.hint.alpha = clamp(S.hint.ttl / 0.45, 0, 1);
      if (S.hint.ttl <= 0) {
        S.hint.ttl = 0;
        S.hint.alpha = 0;
      }
    }
    var key;
    for (key in S.hintCooldowns) {
      if (Object.prototype.hasOwnProperty.call(S.hintCooldowns, key)) {
        if (S.hintCooldowns[key] > 0) S.hintCooldowns[key] = Math.max(0, S.hintCooldowns[key] - dt);
      }
    }
    if (S.titleTimer > 0) {
      S.titleTimer = Math.max(0, S.titleTimer - dt);
    }
  }

  function updateParticles(dt) {
    var arr = S.particles;
    for (var i = arr.length - 1; i >= 0; i--) {
      var p = arr[i];
      p.life -= dt;
      if (p.life <= 0) {
        arr.splice(i, 1);
        continue;
      }
      var dragFactor = Math.max(0, 1 - p.drag * dt);
      p.vx *= dragFactor;
      p.vy = p.vy * dragFactor + p.gravity * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rot += p.spin * dt;
    }
  }

  function updateCameraShake(dt) {
    var c = S.cam;
    if (c.shake > 0.1) {
      c.sx = (Math.random() * 2 - 1) * c.shake;
      c.sy = (Math.random() * 2 - 1) * c.shake;
      c.shake = damp(c.shake, 0, 9, dt);
    } else {
      c.shake = 0;
      c.sx = 0;
      c.sy = 0;
    }
    if (S.damageFlash > 0) S.damageFlash = Math.max(0, S.damageFlash - dt * 2.2);
  }

  // ---------------------------------------------------------------------------
  // 主更新
  // ---------------------------------------------------------------------------
  function updatePlaying(dt) {
    S.elapsed += dt;
    S.timeMs += dt * 1000;
    S.attackCd = Math.max(0, S.attackCd - dt);

    var input = S.input;
    if (input) {
      input.update(dt);
      if (input.consumePause()) emit('requestPause', {});
    }

    updatePlayer(dt);
    updateEnemies(dt);
    checkEnemyContact();
    checkSpikeDamage();
    updateItems();
    positionCamera(dt, false);
  }

  function step(dt) {
    if (!S.initialized) return;
    tickHint(dt);
    if (S.status === 'playing') {
      updatePlaying(dt);
    }
    if (S.status !== 'paused' && S.status !== 'idle') {
      updateParticles(dt);
      updateCameraShake(dt);
    }
  }

  // ---------------------------------------------------------------------------
  // 渲染
  // ---------------------------------------------------------------------------
  function render() {
    var ctx = S.ctx;
    var canvas = S.canvas;
    if (!ctx || !canvas) return;
    var g = gfx();
    if (!g) return;

    var dpr = S.dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    var s = S.scale * dpr;
    ctx.setTransform(s, 0, 0, s, S.offX * dpr, S.offY * dpr);

    var theme = S.level ? S.level.theme : 'forest';
    g.drawBackground(ctx, theme, VIEW_W, VIEW_H, S.elapsed);

    if (!S.level) return;

    var cam = S.cam;
    ctx.save();
    ctx.translate(-cam.x + cam.sx, -cam.y + cam.sy);
    g.drawTiles(ctx, S.level, cam, S.elapsed);
    g.drawSpikes(ctx, S.spikes, S.elapsed);
    if (S.door) g.drawDoor(ctx, S.door, S.elapsed);
    if (S.portal) g.drawPortal(ctx, S.portal, S.elapsed, S.portal.activated);
    var i;
    for (i = 0; i < S.items.length; i++) g.drawItem(ctx, S.items[i], S.elapsed, theme);
    for (i = 0; i < S.enemies.length; i++) {
      if (!S.enemies[i].dead) g.drawEnemy(ctx, S.enemies[i], S.elapsed);
    }
    if (S.player && S.status !== 'dead') g.drawPlayer(ctx, S.player, S.elapsed);
    g.drawParticles(ctx, S.particles);
    ctx.restore();

    var hpRatio = S.player ? S.player.hp / S.player.maxHp : 1;
    g.drawVignette(ctx, VIEW_W, VIEW_H, hpRatio, S.damageFlash, S.elapsed);

    var layout = S.input ? S.input.getLayout() : null;
    // 场景提示：有外壳监听事件时由外壳 toast 展示，画布内不再重复绘制；无外壳时画布兜底。
    var showCanvasHint = !S.onEvent;
    g.drawHUD(ctx, {
      w: VIEW_W,
      h: VIEW_H,
      theme: theme,
      time: S.elapsed,
      hp: S.player ? S.player.hp : 0,
      maxHp: S.player ? S.player.maxHp : PLAYER_MAX_HP,
      gems: S.gemsCollected,
      totalGems: S.gemsTotal,
      timeMs: S.timeMs,
      levelName: S.level.name,
      levelIndex: S.levelIndex,
      hasKey: S.player ? S.player.hasKey : false,
      pauseRect: layout ? layout.pause : { x: 892, y: 16, w: 44, h: 44 },
      hint: showCanvasHint ? S.hint.text : '',
      hintAlpha: showCanvasHint ? S.hint.alpha : 0
    });

    if (S.status === 'playing' && S.input) {
      g.drawTouchControls(ctx, S.input.getLayout(), S.input, S.elapsed);
    }

    if (S.titleTimer > 0) {
      var alpha = clamp(S.titleTimer / 0.7, 0, 1);
      var subtitle = LEVEL_SUBTITLES[S.levelIndex] || LEVEL_SUBTITLES[0];
      g.drawLevelTitle(ctx, VIEW_W, S.level.name, subtitle, alpha, S.elapsed);
    }

    if (S.status === 'dead') {
      g.drawBanner(ctx, VIEW_W, VIEW_H, '你倒下了…', '按重开按钮再试一次', '#ff8a8a');
    } else if (S.status === 'complete') {
      var sub = '用时 ' + formatTime(S.timeMs) + '　宝物 ' + S.gemsCollected + ' / ' + S.gemsTotal;
      g.drawBanner(ctx, VIEW_W, VIEW_H, '关卡完成！', sub, '#ffe9a3');
    }
  }

  // ---------------------------------------------------------------------------
  // 循环 / 缩放 / 生命周期
  // ---------------------------------------------------------------------------
  function startLoop() {
    if (!S.autoLoop || S.loopId) return;
    S.lastTs = now();
    S.loopId = global.requestAnimationFrame(loop);
  }

  function stopLoop() {
    if (S.loopId && global.cancelAnimationFrame) global.cancelAnimationFrame(S.loopId);
    S.loopId = 0;
  }

  function loop(ts) {
    if (!S.initialized) return;
    S.loopId = global.requestAnimationFrame(loop);
    var t = typeof ts === 'number' ? ts : now();
    var dt = (t - S.lastTs) / 1000;
    S.lastTs = t;
    if (!(dt > 0)) dt = 0;
    if (dt > 0.05) dt = 0.05; // clamp：后台切回不跳帧

    // 尺寸兜底检查（ResizeObserver 不可用或 canvas 被父容器改变时）
    S.resizeCheck++;
    if (S.resizeCheck >= 20) {
      S.resizeCheck = 0;
      if (S.canvas && (S.canvas.clientWidth !== S.cssW || S.canvas.clientHeight !== S.cssH)) resize();
    }

    step(dt);
    render();
  }

  function resize() {
    var canvas = S.canvas;
    if (!canvas) return;
    var cssW = canvas.clientWidth || 0;
    var cssH = canvas.clientHeight || 0;
    if ((!cssW || !cssH) && canvas.parentElement) {
      cssW = canvas.parentElement.clientWidth || 0;
      cssH = canvas.parentElement.clientHeight || 0;
    }
    if (!cssW || !cssH) {
      cssW = VIEW_W;
      cssH = VIEW_H;
    }
    var dpr = global.devicePixelRatio || 1;
    if (dpr < 1) dpr = 1;
    if (dpr > 2) dpr = 2;
    S.dpr = dpr;
    S.cssW = cssW;
    S.cssH = cssH;

    var bw = Math.max(1, Math.round(cssW * dpr));
    var bh = Math.max(1, Math.round(cssH * dpr));
    if (canvas.width !== bw) canvas.width = bw;
    if (canvas.height !== bh) canvas.height = bh;

    S.scale = Math.min(cssW / VIEW_W, cssH / VIEW_H);
    S.offX = (cssW - VIEW_W * S.scale) / 2;
    S.offY = (cssH - VIEW_H * S.scale) / 2;

    if (S.input) {
      S.input.setTransform(S.scale, S.offX, S.offY);
      S.input.refreshRect();
    }
  }

  function addWindowListener(target, type, fn, opts) {
    if (!target || typeof target.addEventListener !== 'function') return;
    target.addEventListener(type, fn, opts);
    S.windowListeners.push({ target: target, type: type, fn: fn, opts: opts });
  }

  function removeWindowListeners() {
    for (var i = 0; i < S.windowListeners.length; i++) {
      var l = S.windowListeners[i];
      try {
        l.target.removeEventListener(l.type, l.fn, l.opts);
      } catch (e) {
        /* ignore */
      }
    }
    S.windowListeners = [];
  }

  function setupResizeHooks() {
    var onResize = function () {
      resize();
    };
    addWindowListener(global, 'resize', onResize);
    addWindowListener(global, 'orientationchange', onResize);

    if (global.document && typeof global.document.addEventListener === 'function') {
      var onVisible = function () {
        S.lastTs = now();
        resize();
      };
      global.document.addEventListener('visibilitychange', onVisible);
      S.docListeners.push({ target: global.document, type: 'visibilitychange', fn: onVisible });
    }

    if (typeof global.ResizeObserver === 'function' && S.canvas) {
      try {
        S.resizeObs = new global.ResizeObserver(function () {
          resize();
        });
        S.resizeObs.observe(S.canvas);
      } catch (e) {
        S.resizeObs = null;
      }
    }
  }

  function teardownResizeHooks() {
    removeWindowListeners();
    for (var i = 0; i < S.docListeners.length; i++) {
      var l = S.docListeners[i];
      try {
        l.target.removeEventListener(l.type, l.fn);
      } catch (e) {
        /* ignore */
      }
    }
    S.docListeners = [];
    if (S.resizeObs && typeof S.resizeObs.disconnect === 'function') {
      try {
        S.resizeObs.disconnect();
      } catch (e) {
        /* ignore */
      }
    }
    S.resizeObs = null;
  }

  // ---------------------------------------------------------------------------
  // 对外接口（docs/GAMEDESIGN.md 5.2）
  // ---------------------------------------------------------------------------
  function init(opts) {
    if (!opts || !opts.canvas) {
      warn('init() 需要 opts.canvas');
      return;
    }
    var canvas = opts.canvas;
    var ctx = null;
    try {
      ctx = canvas.getContext ? canvas.getContext('2d') : null;
    } catch (e) {
      ctx = null;
    }
    if (!ctx) {
      warn('无法获取 canvas 2d 上下文');
      return;
    }

    if (S.initialized) destroy();

    S.initialized = true;
    S.destroyed = false;
    S.canvas = canvas;
    S.ctx = ctx;
    S.onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : null;
    S.autoLoop = opts.autoLoop !== false;
    S.status = 'idle';
    S.level = null;
    S.player = null;
    S.levelIndex = 0;
    S.timeMs = 0;
    S.elapsed = 0;
    S.particles = [];
    S.enemies = [];
    S.items = [];
    S.spikes = [];
    S.door = null;
    S.portal = null;
    S.cam = { x: 0, y: 0, shake: 0, sx: 0, sy: 0 };
    S.hint = { text: '', alpha: 0, ttl: 0 };
    S.hintCooldowns = {};
    S.titleTimer = 0;
    S.lastTs = now();
    S.loopId = 0;

    S.input = new TQ.Input();
    S.input.onGesture = function () {
      if (TQ.Audio) TQ.Audio.unlock();
    };
    S.input.attach(canvas);

    if (TQ.Audio && typeof TQ.Audio.init === 'function') TQ.Audio.init();

    resize();
    setupResizeHooks();
    startLoop();
  }

  function startLevel(index) {
    if (!S.initialized) return;
    var total = levelCount();
    if (!total) {
      warn('关卡数据 TQ.Levels 未加载');
      return;
    }
    var idx = Math.floor(Number(index));
    if (!isFinite(idx) || idx < 0 || idx >= total) idx = 0;
    S.levelIndex = idx;
    buildLevel(idx);
  }

  function restartLevel() {
    if (!S.initialized || !S.level) return;
    buildLevel(S.levelIndex);
  }

  function pause() {
    if (!S.initialized) return;
    if (S.status === 'playing') {
      S.status = 'paused';
      if (S.input) S.input.setEnabled(false);
    }
  }

  function resume() {
    if (!S.initialized) return;
    if (S.status === 'paused') {
      S.status = 'playing';
      if (S.input) {
        S.input.setEnabled(true);
        S.input.consumeAttack();
        S.input.consumePause();
      }
      S.lastTs = now();
      if (TQ.Audio) TQ.Audio.unlock();
    }
  }

  function destroy() {
    stopLoop();
    teardownResizeHooks();
    if (S.input) {
      S.input.detach();
      S.input = null;
    }
    if (S.canvas && S.ctx) {
      try {
        S.ctx.setTransform(1, 0, 0, 1, 0, 0);
        S.ctx.fillStyle = '#000000';
        S.ctx.fillRect(0, 0, S.canvas.width, S.canvas.height);
      } catch (e) {
        /* ignore */
      }
    }
    S.initialized = false;
    S.destroyed = true;
    S.status = 'idle';
    S.canvas = null;
    S.ctx = null;
    S.onEvent = null;
    S.level = null;
    S.player = null;
    S.enemies = [];
    S.items = [];
    S.spikes = [];
    S.particles = [];
    S.door = null;
    S.portal = null;
    S.levelIndex = 0;
    S.timeMs = 0;
    S.elapsed = 0;
    S.cam = { x: 0, y: 0, shake: 0, sx: 0, sy: 0 };
  }

  function isRunning() {
    return S.initialized && S.status === 'playing';
  }

  function getLevelCount() {
    return levelCount();
  }

  function getSnapshot() {
    return {
      status: S.status,
      level: S.levelIndex,
      levelCount: levelCount(),
      hp: S.player ? S.player.hp : 0,
      maxHp: S.player ? S.player.maxHp : PLAYER_MAX_HP,
      gems: S.gemsCollected,
      totalGems: S.gemsTotal,
      hasKey: S.player ? S.player.hasKey : false,
      timeMs: Math.round(S.timeMs),
      enemiesAlive: S.enemies.filter(function (e) { return !e.dead; }).length,
      itemsLeft: S.items.length,
      portalActivated: !!(S.portal && S.portal.activated),
      doorOpen: !!(S.door && S.door.open),
      player: S.player ? { x: S.player.x, y: S.player.y } : null,
      camera: { x: S.cam.x, y: S.cam.y }
    };
  }

  function setSoundEnabled(on) {
    if (TQ.Audio && typeof TQ.Audio.setEnabled === 'function') TQ.Audio.setEnabled(on);
  }

  var Game = {
    init: init,
    startLevel: startLevel,
    restartLevel: restartLevel,
    pause: pause,
    resume: resume,
    destroy: destroy,
    isRunning: isRunning,
    getLevelCount: getLevelCount,
    getSnapshot: getSnapshot,
    setSoundEnabled: setSoundEnabled,
    // 供自动化测试使用（非公开契约，外壳不要依赖）
    __test: {
      step: function (dt) {
        step(dt);
        render();
      },
      state: function () {
        return S;
      }
    }
  };

  TQ.Game = Game;
  TQ.GAME_VIEW = { width: VIEW_W, height: VIEW_H };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { Game: Game };
  }
})(typeof window !== 'undefined' ? window : globalThis);

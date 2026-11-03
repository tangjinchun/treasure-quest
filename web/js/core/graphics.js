/**
 * 《寻宝奇兵》程序化绘制（Canvas 2D）
 * 所有美术资源均由代码绘制：无图片、无外部字体、无 CDN 依赖。
 * 浏览器挂载 window.TQ.Graphics；纯函数式绘制工具，不持有游戏状态。
 */
(function (global) {
  'use strict';

  var TQ = global.TQ = global.TQ || {};
  var U = TQ.Util || {};

  var TAU = Math.PI * 2;
  var FONT = '"Microsoft YaHei", "PingFang SC", "Noto Sans SC", system-ui, sans-serif';

  function clamp(v, a, b) {
    if (U.clamp) return U.clamp(v, a, b);
    return v < a ? a : v > b ? b : v;
  }
  function lerp(a, b, t) {
    if (U.lerp) return U.lerp(a, b, t);
    return a + (b - a) * t;
  }
  function hash2(x, y) {
    if (U.hash2) return U.hash2(x, y);
    var h = (x | 0) * 374761393 + (y | 0) * 668265263;
    h = (h ^ (h >>> 13)) * 1274126177;
    return ((h ^ (h >>> 16)) >>> 0) % 100000 / 100000;
  }

  var SPIKE_PERIOD = 2.4;
  var SPIKE_UP_TIME = 1.1;

  // ---------------------------------------------------------------------------
  // 主题调色板
  // ---------------------------------------------------------------------------
  var PALETTES = {
    forest: {
      bg: '#0b1a10',
      bgGlow: '#16301f',
      floorA: '#2f6b3f',
      floorB: '#2a6138',
      floorC: '#255832',
      floorDetail: '#3f814f',
      floorShadow: '#1d4a2a',
      wall: '#1a3322',
      wallTop: '#2c5235',
      wallEdge: '#0d1d13',
      brick: 'rgba(10, 28, 16, 0.45)',
      tree: '#1e4d2b',
      treeLight: '#3a8a4d',
      treeDark: '#122f1b',
      trunk: '#4a3320',
      water: '#164757',
      waterDeep: '#0e2f3c',
      waterLight: '#3d9bb8',
      spike: '#b9c4cd',
      spikeDark: '#63707c',
      glow: '#f5c542'
    },
    cave: {
      bg: '#09070e',
      bgGlow: '#1b1526',
      floorA: '#3a3142',
      floorB: '#352d3c',
      floorC: '#2f2937',
      floorDetail: '#4a3f56',
      floorShadow: '#211b2a',
      wall: '#1c1724',
      wallTop: '#342b40',
      wallEdge: '#0e0b14',
      brick: 'rgba(8, 5, 14, 0.5)',
      tree: '#3c3247',
      treeLight: '#544565',
      treeDark: '#241d2e',
      trunk: '#3a2f45',
      water: '#123640',
      waterDeep: '#0a232b',
      waterLight: '#2d7180',
      spike: '#c3ccd8',
      spikeDark: '#6a7480',
      glow: '#9b7bff'
    },
    temple: {
      bg: '#120c05',
      bgGlow: '#2a1d0a',
      floorA: '#5b4a30',
      floorB: '#544329',
      floorC: '#4c3d25',
      floorDetail: '#6e5a38',
      floorShadow: '#2f2514',
      wall: '#634c2c',
      wallTop: '#85693b',
      wallEdge: '#372810',
      brick: 'rgba(30, 20, 6, 0.4)',
      tree: '#6b5433',
      treeLight: '#8f7446',
      treeDark: '#463622',
      trunk: '#4a3820',
      water: '#23565f',
      waterDeep: '#153a40',
      waterLight: '#4b9aa5',
      spike: '#d8c08a',
      spikeDark: '#8e7748',
      glow: '#f5c542'
    },
    cloud: {
      bg: '#0a1730',
      bgGlow: '#2b4d7d',
      floorA: '#7d99bd',
      floorB: '#7691b4',
      floorC: '#6f89ab',
      floorDetail: '#a7c1dd',
      floorShadow: '#4d6685',
      wall: '#55698c',
      wallTop: '#d6e6f7',
      wallEdge: '#33445f',
      brick: 'rgba(20, 32, 52, 0.35)',
      tree: '#7c93b3',
      treeLight: '#a9bdd8',
      treeDark: '#54688a',
      trunk: '#4e6180',
      water: '#8fc4e8',
      waterDeep: '#5f91bb',
      waterLight: '#ffffff',
      spike: '#eef6ff',
      spikeDark: '#93adc9',
      glow: '#7fe0ff'
    }
  };

  function getPalette(theme) {
    return PALETTES[theme] || PALETTES.forest;
  }

  // ---------------------------------------------------------------------------
  // 基础绘制工具
  // ---------------------------------------------------------------------------
  function roundRect(ctx, x, y, w, h, r) {
    var rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.lineTo(x + w - rr, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
    ctx.lineTo(x + w, y + h - rr);
    ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
    ctx.lineTo(x + rr, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
    ctx.lineTo(x, y + rr);
    ctx.quadraticCurveTo(x, y, x + rr, y);
    ctx.closePath();
  }

  function heartPath(ctx, cx, cy, size) {
    var s = size / 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy + s * 0.9);
    ctx.bezierCurveTo(cx - s * 1.5, cy - s * 0.25, cx - s * 0.65, cy - s * 1.15, cx, cy - s * 0.35);
    ctx.bezierCurveTo(cx + s * 0.65, cy - s * 1.15, cx + s * 1.5, cy - s * 0.25, cx, cy + s * 0.9);
    ctx.closePath();
  }

  function shadowEllipse(ctx, x, y, rx, ry, alpha) {
    ctx.save();
    ctx.globalAlpha = alpha === undefined ? 0.28 : alpha;
    ctx.fillStyle = '#000000';
    ctx.beginPath();
    ctx.ellipse(x, y, rx, ry, 0, 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  function setFont(ctx, size, weight) {
    ctx.font = (weight || '700') + ' ' + size + 'px ' + FONT;
  }

  function text(ctx, str, x, y, size, color, align, weight, shadow) {
    setFont(ctx, size, weight);
    ctx.textAlign = align || 'left';
    ctx.textBaseline = 'middle';
    if (shadow !== false) {
      ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
      ctx.fillText(str, x + 2, y + 2);
    }
    ctx.fillStyle = color || '#ffffff';
    ctx.fillText(str, x, y);
  }

  function drawGemIcon(ctx, x, y, size, time) {
    var s = size / 2;
    var wobble = Math.sin((time || 0) * 2 + x * 0.05) * 0.12;
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(Math.max(0.35, Math.abs(Math.cos(wobble))), 1);
    ctx.shadowColor = 'rgba(90, 220, 255, 0.9)';
    ctx.shadowBlur = 10;
    ctx.beginPath();
    ctx.moveTo(0, -s);
    ctx.lineTo(s * 0.8, -s * 0.1);
    ctx.lineTo(0, s);
    ctx.lineTo(-s * 0.8, -s * 0.1);
    ctx.closePath();
    var g = ctx.createLinearGradient(-s, -s, s, s);
    g.addColorStop(0, '#d9f7ff');
    g.addColorStop(0.45, '#5bd7ff');
    g.addColorStop(1, '#1b7fc4');
    ctx.fillStyle = g;
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = 'rgba(255,255,255,0.75)';
    ctx.lineWidth = 1.2;
    ctx.stroke();
    ctx.restore();
  }

  function drawKeyIcon(ctx, x, y, size, color) {
    var s = size / 2;
    ctx.save();
    ctx.translate(x, y);
    ctx.strokeStyle = color || '#f5c542';
    ctx.fillStyle = color || '#f5c542';
    ctx.lineWidth = Math.max(2, s * 0.32);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.arc(0, -s * 0.35, s * 0.5, 0, TAU);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, s * 0.1);
    ctx.lineTo(0, s * 0.85);
    ctx.moveTo(0, s * 0.55);
    ctx.lineTo(s * 0.45, s * 0.55);
    ctx.stroke();
    ctx.restore();
  }

  function drawHeartIcon(ctx, x, y, size, filled) {
    ctx.save();
    heartPath(ctx, x, y, size);
    if (filled) {
      var g = ctx.createLinearGradient(x, y - size, x, y + size);
      g.addColorStop(0, '#ff7a7a');
      g.addColorStop(1, '#d62b3f');
      ctx.fillStyle = g;
      ctx.shadowColor = 'rgba(255, 60, 80, 0.6)';
      ctx.shadowBlur = 8;
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.strokeStyle = 'rgba(255, 220, 220, 0.5)';
      ctx.lineWidth = 1;
      ctx.stroke();
    } else {
      ctx.fillStyle = 'rgba(30, 20, 24, 0.55)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(255, 150, 160, 0.45)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    ctx.restore();
  }

  // ---------------------------------------------------------------------------
  // 背景 / 瓦片
  // ---------------------------------------------------------------------------
  function drawBackground(ctx, theme, w, h, time) {
    var pal = getPalette(theme);
    var g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, pal.bgGlow);
    g.addColorStop(0.55, pal.bg);
    g.addColorStop(1, '#000000');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    // 主题氛围点缀
    ctx.save();
    if (theme === 'cave') {
      for (var i = 0; i < 14; i++) {
        var hx = hash2(i, 7);
        var hy = hash2(i, 13);
        var px = hx * w;
        var py = hy * h * 0.9;
        var a = 0.1 + 0.18 * (0.5 + 0.5 * Math.sin(time * 1.3 + i));
        ctx.fillStyle = 'rgba(155, 123, 255, ' + a.toFixed(3) + ')';
        ctx.beginPath();
        ctx.arc(px, py, 1.5 + hx * 2, 0, TAU);
        ctx.fill();
      }
    } else if (theme === 'temple') {
      ctx.globalAlpha = 0.08;
      ctx.fillStyle = pal.glow;
      for (var j = 0; j < 6; j++) {
        var bx = ((j * 173 + time * 8) % (w + 160)) - 80;
        ctx.fillRect(bx, 0, 42, h);
      }
    } else {
      ctx.globalAlpha = 0.12;
      ctx.fillStyle = '#7fd39a';
      for (var k = 0; k < 10; k++) {
        var fx = hash2(k, 3) * w;
        var fy = hash2(k, 9) * h;
        var off = Math.sin(time * 0.6 + k) * 8;
        ctx.beginPath();
        ctx.arc(fx + off, fy, 1.6, 0, TAU);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  function drawFloorTile(ctx, pal, x, y, tx, ty, tile) {
    var h = hash2(tx, ty);
    ctx.fillStyle = h < 0.34 ? pal.floorA : h < 0.68 ? pal.floorB : pal.floorC;
    ctx.fillRect(x, y, tile, tile);
    ctx.fillStyle = pal.floorShadow;
    ctx.fillRect(x, y + tile - 2, tile, 2);
    // 地面细节
    if (h < 0.16) {
      ctx.fillStyle = pal.floorDetail;
      ctx.fillRect(x + 6 + h * 60, y + 9, 2, 7);
      ctx.fillRect(x + 10 + h * 60, y + 13, 2, 5);
      ctx.fillRect(x + 20 + h * 40, y + 6, 2, 6);
    } else if (h > 0.86) {
      ctx.fillStyle = pal.floorDetail;
      ctx.beginPath();
      ctx.arc(x + tile * 0.62, y + tile * 0.68, 2.2, 0, TAU);
      ctx.fill();
      ctx.fillStyle = pal.floorShadow;
      ctx.beginPath();
      ctx.arc(x + tile * 0.62, y + tile * 0.68, 1.1, 0, TAU);
      ctx.fill();
    }
  }

  function drawWallTile(ctx, pal, x, y, tile, isTopExposed) {
    ctx.fillStyle = pal.wall;
    ctx.fillRect(x, y, tile, tile);
    ctx.fillStyle = pal.wallEdge;
    ctx.fillRect(x, y, tile, 3);
    ctx.fillRect(x, y, 3, tile);
    ctx.fillStyle = pal.wallTop;
    ctx.fillRect(x + 3, y + 3, tile - 6, 4);
    ctx.fillStyle = pal.brick;
    ctx.fillRect(x + 2, y + 14, tile - 4, 3);
    ctx.fillRect(x + tile * 0.5 - 2, y + 5, 3, 9);
    if (isTopExposed) {
      ctx.fillStyle = pal.wallTop;
      ctx.fillRect(x, y, tile, 5);
      ctx.fillStyle = 'rgba(255,255,255,0.10)';
      ctx.fillRect(x + 2, y + 1, tile - 4, 2);
    }
  }

  function drawTreeTile(ctx, pal, x, y, tile) {
    drawFloorTile(ctx, pal, x, y, 0, 0, tile);
    var cx = x + tile / 2;
    var cy = y + tile * 0.56;
    shadowEllipse(ctx, cx, y + tile * 0.86, 13, 5, 0.3);
    ctx.fillStyle = pal.trunk;
    ctx.fillRect(cx - 3, cy + 2, 6, 11);
    var blobs = [
      [-8, -6, 10],
      [8, -5, 9.5],
      [0, -12, 11]
    ];
    for (var i = 0; i < blobs.length; i++) {
      var b = blobs[i];
      ctx.fillStyle = pal.treeDark;
      ctx.beginPath();
      ctx.arc(cx + b[0], cy + b[1] + 2, b[2], 0, TAU);
      ctx.fill();
      ctx.fillStyle = i === 2 ? pal.tree : pal.treeLight;
      ctx.beginPath();
      ctx.arc(cx + b[0], cy + b[1], b[2] * 0.86, 0, TAU);
      ctx.fill();
    }
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.beginPath();
    ctx.arc(cx - 3, cy - 14, 4, 0, TAU);
    ctx.fill();
  }

  function drawWaterTile(ctx, pal, x, y, tx, ty, tile, time) {
    ctx.fillStyle = pal.waterDeep;
    ctx.fillRect(x, y, tile, tile);
    var g = ctx.createLinearGradient(x, y, x, y + tile);
    g.addColorStop(0, pal.water);
    g.addColorStop(1, pal.waterDeep);
    ctx.fillStyle = g;
    ctx.fillRect(x, y, tile, tile);
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, tile, tile);
    ctx.clip();
    ctx.strokeStyle = pal.waterLight;
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = 2;
    for (var i = 0; i < 2; i++) {
      var ly = y + 9 + i * 13 + Math.sin(time * 1.6 + tx * 0.7 + ty * 0.4 + i * 2) * 2.4;
      ctx.beginPath();
      ctx.moveTo(x + 3, ly);
      ctx.quadraticCurveTo(x + tile * 0.3, ly - 3, x + tile * 0.55, ly);
      ctx.quadraticCurveTo(x + tile * 0.8, ly + 3, x + tile - 3, ly);
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawSpikeBase(ctx, pal, x, y, tile) {
    ctx.fillStyle = pal.floorShadow;
    ctx.fillRect(x, y, tile, tile);
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(x + 3, y + 3, tile - 6, tile - 6);
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, tile - 1, tile - 1);
  }

  /** 绘制地图瓦片；返回可见范围信息供调试 */
  function drawTiles(ctx, level, cam, time) {
    var pal = getPalette(level.theme);
    var tile = level.tileSize || 32;
    var grid = level.grid;
    var mapW = level.width * tile;
    var mapH = level.height * tile;
    var viewW = 960;
    var viewH = 540;
    var x0 = Math.max(0, Math.floor(cam.x / tile));
    var y0 = Math.max(0, Math.floor(cam.y / tile));
    var x1 = Math.min(level.width - 1, Math.ceil((cam.x + viewW) / tile));
    var y1 = Math.min(level.height - 1, Math.ceil((cam.y + viewH) / tile));

    for (var ty = y0; ty <= y1; ty++) {
      for (var tx = x0; tx <= x1; tx++) {
        var ch = grid[ty][tx];
        var px = tx * tile;
        var py = ty * tile;
        if (ch === '#') {
          var topExposed = ty > 0 && grid[ty - 1][tx] !== '#';
          drawWallTile(ctx, pal, px, py, tile, topExposed);
        } else if (ch === 'T') {
          drawTreeTile(ctx, pal, px, py, tile);
        } else if (ch === '~') {
          drawWaterTile(ctx, pal, px, py, tx, ty, tile, time);
        } else if (ch === '^') {
          drawSpikeBase(ctx, pal, px, py, tile);
        } else {
          drawFloorTile(ctx, pal, px, py, tx, ty, tile);
          // 边缘阴影：与墙体相邻时加深，增强立体感
          if (ty > 0 && grid[ty - 1][tx] === '#') {
            ctx.fillStyle = 'rgba(0,0,0,0.18)';
            ctx.fillRect(px, py, tile, 5);
          }
        }
        // 地图边界外的暗色（确保相机边缘不出戏）
        if (px < 0 || py < 0 || px > mapW || py > mapH) {
          ctx.fillStyle = pal.bg;
          ctx.fillRect(px, py, tile, tile);
        }
      }
    }
    return { x0: x0, y0: y0, x1: x1, y1: y1 };
  }

  // ---------------------------------------------------------------------------
  // 机关：尖刺 / 门 / 传送门
  // ---------------------------------------------------------------------------
  function spikeExtendFactor(spike, time) {
    var cycle = (time + spike.phase) % SPIKE_PERIOD;
    if (cycle < 0) cycle += SPIKE_PERIOD;
    if (cycle < SPIKE_UP_TIME) {
      // 伸出：0.12s 快速弹出
      var t = cycle / 0.12;
      if (t >= 1) return 1;
      return U.easeOutBack ? U.easeOutBack(t) : t;
    }
    // 缩回：0.18s
    var back = (cycle - SPIKE_UP_TIME) / 0.2;
    if (back >= 1) return 0;
    return 1 - back;
  }

  function isSpikeUp(spike, time) {
    var cycle = (time + spike.phase) % SPIKE_PERIOD;
    if (cycle < 0) cycle += SPIKE_PERIOD;
    return cycle < SPIKE_UP_TIME;
  }

  function drawSpikes(ctx, spikes, time) {
    var tile = 32;
    for (var i = 0; i < spikes.length; i++) {
      var s = spikes[i];
      var ext = spikeExtendFactor(s, time);
      if (ext <= 0.02) continue;
      var x = s.tx * tile;
      var y = s.ty * tile;
      var pal = getPalette(s.theme);
      var hgt = 6 + 16 * ext;
      ctx.save();
      ctx.beginPath();
      ctx.rect(x + 1, y + 1, tile - 2, tile - 2);
      ctx.clip();
      for (var row = 0; row < 2; row++) {
        for (var col = 0; col < 4; col++) {
          var bx = x + 4 + col * 7.2;
          var by = y + 16 + row * 8;
          ctx.beginPath();
          ctx.moveTo(bx, by);
          ctx.lineTo(bx + 3.4, by - hgt);
          ctx.lineTo(bx + 6.8, by);
          ctx.closePath();
          var g = ctx.createLinearGradient(bx, by - hgt, bx, by);
          g.addColorStop(0, pal.spike);
          g.addColorStop(1, pal.spikeDark);
          ctx.fillStyle = g;
          ctx.fill();
          ctx.fillStyle = 'rgba(255,255,255,0.35)';
          ctx.fillRect(bx + 3, by - hgt + 1, 1, Math.max(2, hgt * 0.4));
        }
      }
      ctx.restore();
      // 弹出时的地面警示
      if (ext > 0.5) {
        ctx.save();
        ctx.globalAlpha = (ext - 0.5) * 0.5;
        ctx.strokeStyle = '#ff5a5a';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(x + 2.5, y + 2.5, tile - 5, tile - 5);
        ctx.restore();
      }
    }
  }

  function drawDoor(ctx, door, time) {
    var tile = 32;
    var x = door.tx * tile;
    var y = door.ty * tile;
    var cx = x + tile / 2;
    var cy = y + tile / 2;
    if (door.open) {
      ctx.fillStyle = 'rgba(0,0,0,0.75)';
      ctx.fillRect(x + 2, y + 2, tile - 4, tile - 4);
      ctx.fillStyle = '#6b4a2a';
      ctx.fillRect(x, y + 2, 4, tile - 4);
      ctx.fillRect(x + tile - 4, y + 2, 4, tile - 4);
      ctx.fillStyle = '#3d2a16';
      ctx.fillRect(x + 4, y + 3, tile - 8, 3);
      return;
    }
    // 门框
    ctx.fillStyle = '#3a2714';
    ctx.fillRect(x + 1, y, tile - 2, tile);
    ctx.fillStyle = '#6b4a2a';
    ctx.fillRect(x + 3, y + 2, tile - 6, tile - 4);
    // 木纹
    ctx.strokeStyle = 'rgba(40, 24, 10, 0.55)';
    ctx.lineWidth = 1.5;
    for (var i = 0; i < 3; i++) {
      ctx.beginPath();
      ctx.moveTo(x + 6 + i * 7, y + 4);
      ctx.lineTo(x + 6 + i * 7, y + tile - 4);
      ctx.stroke();
    }
    // 金属横条
    ctx.fillStyle = '#8d8d96';
    ctx.fillRect(x + 3, y + 7, tile - 6, 3);
    ctx.fillRect(x + 3, y + tile - 12, tile - 6, 3);
    // 锁
    var pulse = 0.5 + 0.5 * Math.sin(time * 3);
    ctx.save();
    ctx.shadowColor = 'rgba(245, 197, 66, 0.85)';
    ctx.shadowBlur = 6 + pulse * 6;
    ctx.fillStyle = '#f5c542';
    ctx.beginPath();
    ctx.arc(cx, cy + 1, 4.5, 0, TAU);
    ctx.fill();
    ctx.fillStyle = '#2b1d08';
    ctx.fillRect(cx - 1, cy, 2, 4);
    ctx.restore();
  }

  function drawPortal(ctx, portal, time, activated) {
    var tile = 32;
    var cx = portal.tx * tile + tile / 2;
    var cy = portal.ty * tile + tile / 2;
    var pal = getPalette(portal.theme);
    var r = 20;
    // 基座
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.beginPath();
    ctx.ellipse(cx, cy + 10, 20, 8, 0, 0, TAU);
    ctx.fill();
    // 外环
    ctx.lineWidth = 4;
    ctx.strokeStyle = activated ? pal.glow : '#4a4f63';
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, TAU);
    ctx.stroke();
    if (activated) {
      ctx.shadowColor = pal.glow;
      ctx.shadowBlur = 18;
      var spin = time * 2.2;
      for (var i = 0; i < 3; i++) {
        ctx.strokeStyle = i === 0 ? '#fff4c2' : i === 1 ? '#f5c542' : '#61e0c2';
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.arc(cx, cy, r - 4 - i * 4.5, spin + (i * TAU) / 3, spin + (i * TAU) / 3 + 1.7);
        ctx.stroke();
      }
      ctx.fillStyle = 'rgba(255, 245, 200, 0.32)';
      ctx.beginPath();
      ctx.arc(cx, cy, r - 6, 0, TAU);
      ctx.fill();
      ctx.shadowBlur = 0;
      // 上升的光点
      for (var k = 0; k < 3; k++) {
        var ph = (time * 0.9 + k / 3) % 1;
        var px = cx + Math.sin(time * 2 + k * 2.1) * 9;
        var py = cy + 12 - ph * 34;
        ctx.globalAlpha = (1 - ph) * 0.7;
        ctx.fillStyle = pal.glow;
        ctx.beginPath();
        ctx.arc(px, py, 2, 0, TAU);
        ctx.fill();
      }
    } else {
      ctx.fillStyle = 'rgba(20, 24, 40, 0.85)';
      ctx.beginPath();
      ctx.arc(cx, cy, r - 4, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = 'rgba(160, 170, 200, 0.25)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(cx, cy, r - 9, time * 0.8, time * 0.8 + 1.2);
      ctx.stroke();
    }
    ctx.restore();
  }

  // ---------------------------------------------------------------------------
  // 道具
  // ---------------------------------------------------------------------------
  function drawItem(ctx, item, time, theme) {
    var pal = getPalette(theme);
    var bob = Math.sin(time * 2.6 + item.phase) * 3;
    var x = item.x;
    var y = item.y + bob;
    shadowEllipse(ctx, item.x, item.y + 11, 10, 3.6, 0.25);
    ctx.save();
    if (item.kind === 'gem') {
      var s = 11;
      var spin = Math.cos(time * 2 + item.phase) * 0.35;
      ctx.translate(x, y);
      ctx.scale(0.75 + Math.abs(spin) * 0.5, 1);
      ctx.shadowColor = 'rgba(91, 215, 255, 0.9)';
      ctx.shadowBlur = 14;
      ctx.beginPath();
      ctx.moveTo(0, -s);
      ctx.lineTo(s * 0.78, -s * 0.12);
      ctx.lineTo(0, s);
      ctx.lineTo(-s * 0.78, -s * 0.12);
      ctx.closePath();
      var g = ctx.createLinearGradient(-s, -s, s, s);
      g.addColorStop(0, '#e6fbff');
      g.addColorStop(0.45, '#5bd7ff');
      g.addColorStop(1, '#1a6fae');
      ctx.fillStyle = g;
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.strokeStyle = 'rgba(255,255,255,0.8)';
      ctx.lineWidth = 1.2;
      ctx.stroke();
      // 高光
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.beginPath();
      ctx.moveTo(-2, -s * 0.5);
      ctx.lineTo(2, -s * 0.55);
      ctx.lineTo(-1, -s * 0.1);
      ctx.closePath();
      ctx.fill();
    } else if (item.kind === 'key') {
      drawKeyIcon(ctx, x, y, 26, pal.glow);
      ctx.shadowColor = 'rgba(245, 197, 66, 0.8)';
      ctx.shadowBlur = 10;
      drawKeyIcon(ctx, x, y, 26, '#ffe9a3');
    } else if (item.kind === 'heal') {
      var pulse = 1 + Math.sin(time * 4 + item.phase) * 0.08;
      ctx.translate(x, y);
      ctx.scale(pulse, pulse);
      ctx.shadowColor = 'rgba(255, 90, 110, 0.8)';
      ctx.shadowBlur = 12;
      drawHeartIcon(ctx, 0, 0, 24, true);
    }
    ctx.restore();
  }

  // ---------------------------------------------------------------------------
  // 角色
  // ---------------------------------------------------------------------------
  var PLAYER_COLORS = {
    hat: '#8a5a2b',
    hatDark: '#5c3a1a',
    skin: '#f2c79b',
    coat: '#d9a441',
    coatDark: '#b07f2b',
    pants: '#4a3b2a',
    scarf: '#d94f4f',
    pack: '#7a5230',
    packDark: '#5c3c20',
    boot: '#3b2c1d',
    sword: '#d9e2ee',
    swordDark: '#8fa0b5'
  };

  function drawPlayer(ctx, player, time) {
    var c = PLAYER_COLORS;
    var x = player.x;
    var y = player.y;
    var moving = player.moving;
    var bob = moving ? Math.sin(player.walkTime * 13) * 1.6 : Math.sin(time * 2 + 1) * 0.8;
    var blink = player.invuln > 0 && Math.floor(time * 18) % 2 === 0;

    shadowEllipse(ctx, x, y + 12, 12, 4.5, 0.3);

    ctx.save();
    ctx.translate(x, y + bob);
    if (blink) ctx.globalAlpha = 0.35;

    var fx = Math.cos(player.facing);
    var fy = Math.sin(player.facing);
    var step = moving ? Math.sin(player.walkTime * 13) * 3 : 0;

    // 腿
    ctx.fillStyle = c.pants;
    roundRect(ctx, -7, 5 + step * 0.4, 5, 9, 2);
    ctx.fill();
    roundRect(ctx, 2, 5 - step * 0.4, 5, 9, 2);
    ctx.fill();
    ctx.fillStyle = c.boot;
    ctx.fillRect(-7.5, 11 + step * 0.4, 6, 3);
    ctx.fillRect(1.5, 11 - step * 0.4, 6, 3);

    // 背包（根据朝向画在身后）
    ctx.fillStyle = c.packDark;
    roundRect(ctx, -6 - fx * 4, -8 - fy * 3, 13, 14, 4);
    ctx.fill();
    ctx.fillStyle = c.pack;
    roundRect(ctx, -5 - fx * 4, -7 - fy * 3, 11, 11, 3);
    ctx.fill();

    // 身体
    ctx.fillStyle = c.coatDark;
    roundRect(ctx, -9, -8, 18, 18, 7);
    ctx.fill();
    ctx.fillStyle = c.coat;
    roundRect(ctx, -8, -8, 16, 15, 6);
    ctx.fill();
    // 拉链/口袋
    ctx.strokeStyle = 'rgba(90, 60, 20, 0.6)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, -5);
    ctx.lineTo(0, 4);
    ctx.stroke();

    // 手臂
    ctx.fillStyle = c.coatDark;
    ctx.beginPath();
    ctx.arc(-9 + fx * 2, 0 + fy * 1, 3.4, 0, TAU);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(9 + fx * 2, 0 + fy * 1, 3.4, 0, TAU);
    ctx.fill();

    // 围巾
    ctx.fillStyle = c.scarf;
    roundRect(ctx, -7, -12, 14, 4.5, 2);
    ctx.fill();
    ctx.fillStyle = '#b53a3a';
    ctx.beginPath();
    ctx.moveTo(-6, -10);
    ctx.lineTo(-10 - fx * 2, -5 + fy * 2);
    ctx.lineTo(-4, -8);
    ctx.closePath();
    ctx.fill();

    // 头
    ctx.fillStyle = c.skin;
    ctx.beginPath();
    ctx.arc(fx * 1.5, -15 + fy * 1, 7.6, 0, TAU);
    ctx.fill();
    ctx.fillStyle = 'rgba(0,0,0,0.12)';
    ctx.beginPath();
    ctx.arc(fx * 1.5, -13 + fy * 1, 7.6, 0.2, Math.PI - 0.2);
    ctx.fill();

    // 眼睛（朝向感）
    ctx.fillStyle = '#2a1c10';
    var ex = fx * 2.4;
    var ey = fy * 1.4;
    ctx.beginPath();
    ctx.arc(-2.6 + ex, -15 + ey, 1.25, 0, TAU);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(2.6 + ex, -15 + ey, 1.25, 0, TAU);
    ctx.fill();

    // 探险帽
    ctx.fillStyle = c.hatDark;
    ctx.beginPath();
    ctx.ellipse(0, -20.5, 13, 4.6, 0, 0, TAU);
    ctx.fill();
    ctx.fillStyle = c.hat;
    ctx.beginPath();
    ctx.ellipse(0, -21, 12.2, 3.8, 0, 0, TAU);
    ctx.fill();
    ctx.fillStyle = c.hat;
    roundRect(ctx, -8, -28, 16, 9, 4);
    ctx.fill();
    ctx.fillStyle = c.hatDark;
    ctx.fillRect(-8.5, -23, 17, 3);
    ctx.fillStyle = 'rgba(255,255,255,0.22)';
    roundRect(ctx, -6, -27, 8, 2.4, 1.2);
    ctx.fill();

    ctx.restore();

    // 剑（挥砍动画 / 待机）
    drawSword(ctx, player, time);
  }

  function drawSword(ctx, player, time) {
    var c = PLAYER_COLORS;
    var x = player.x;
    var y = player.y;
    if (player.swing > 0) {
      var total = player.swingTotal || 0.18;
      var t = clamp(1 - player.swing / total, 0, 1);
      var angle = player.swingDir;
      var sweep = U.easeOutCubic ? U.easeOutCubic(t) : t;
      var a0 = angle - 1.05;
      var a1 = angle - 1.05 + 2.1 * sweep;
      ctx.save();
      ctx.translate(x, y - 2);
      // 弧形残影
      var grad = ctx.createRadialGradient(0, 0, 8, 0, 0, 44);
      grad.addColorStop(0, 'rgba(255, 250, 210, 0.05)');
      grad.addColorStop(0.7, 'rgba(255, 248, 200, 0.5)');
      grad.addColorStop(1, 'rgba(255, 248, 200, 0)');
      ctx.strokeStyle = grad;
      ctx.lineWidth = 7;
      ctx.beginPath();
      ctx.arc(0, 0, 33, a1 - 0.75, a1);
      ctx.stroke();
      // 剑刃
      ctx.rotate(a1);
      ctx.strokeStyle = c.sword;
      ctx.lineWidth = 3;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(12, 0);
      ctx.lineTo(44, 0);
      ctx.stroke();
      ctx.strokeStyle = c.swordDark;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(14, 2.2);
      ctx.lineTo(40, 2.2);
      ctx.stroke();
      // 剑格
      ctx.fillStyle = '#c9a227';
      ctx.fillRect(9, -5, 4, 10);
      ctx.restore();
    } else {
      var idleAngle = player.facing + Math.PI * 0.68;
      ctx.save();
      ctx.translate(x + Math.cos(idleAngle) * 8, y + Math.sin(idleAngle) * 6 - 2);
      ctx.rotate(idleAngle + Math.sin(time * 1.5) * 0.02);
      ctx.strokeStyle = c.swordDark;
      ctx.lineWidth = 2.6;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(-6, 0);
      ctx.lineTo(13, 0);
      ctx.stroke();
      ctx.fillStyle = '#c9a227';
      ctx.fillRect(-7, -3, 3, 6);
      ctx.restore();
    }
  }

  function drawEnemyHpBar(ctx, e, width) {
    if (e.hp >= e.maxHp) return;
    var w = width || 24;
    var x = e.x - w / 2;
    var y = e.y - e.r - 12;
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    roundRect(ctx, x - 1, y - 1, w + 2, 5, 2);
    ctx.fill();
    ctx.fillStyle = '#8ef06a';
    roundRect(ctx, x, y, w * Math.max(0, e.hp / e.maxHp), 3, 1.5);
    ctx.fill();
  }

  var ENEMY_COLORS = {
    slime: { body: '#46c96a', dark: '#2a8a45', light: '#8bf0a5', eye: '#173a1f' },
    bat: { body: '#5a4a7c', dark: '#3a2f54', light: '#8f7ab8', eye: '#ff5a5a' },
    ghost: { body: '#b9c6e8', dark: '#7d8ab0', light: '#e8f0ff', eye: '#242a44' }
  };

  function drawEnemy(ctx, e, time) {
    var col = ENEMY_COLORS[e.kind] || ENEMY_COLORS.slime;
    var flash = e.flash > 0;
    shadowEllipse(ctx, e.x, e.y + (e.kind === 'ghost' ? 4 : e.r * 0.9), e.r * 0.9, e.r * 0.34, e.kind === 'ghost' ? 0.12 : 0.26);
    ctx.save();
    if (e.kind === 'ghost') {
      var hover = Math.sin(time * 2 + e.phase) * 2.5;
      ctx.translate(e.x, e.y + hover);
      ctx.globalAlpha = 0.82;
      var wob = Math.sin(time * 3 + e.phase) * 1.6;
      ctx.fillStyle = flash ? '#ffffff' : col.dark;
      ctx.beginPath();
      ctx.moveTo(-e.r, e.r * 0.9);
      ctx.quadraticCurveTo(-e.r * 1.15, -e.r * 1.05, 0, -e.r * 1.15);
      ctx.quadraticCurveTo(e.r * 1.15, -e.r * 1.05, e.r, e.r * 0.9);
      ctx.quadraticCurveTo(e.r * 0.5, e.r * 0.5 + wob, 0, e.r * 0.95);
      ctx.quadraticCurveTo(-e.r * 0.5, e.r * 0.5 - wob, -e.r, e.r * 0.9);
      ctx.closePath();
      ctx.fill();
      if (!flash) {
        var gg = ctx.createRadialGradient(0, -e.r * 0.3, 2, 0, 0, e.r * 1.4);
        gg.addColorStop(0, col.light);
        gg.addColorStop(0.6, col.body);
        gg.addColorStop(1, 'rgba(120, 135, 180, 0.15)');
        ctx.fillStyle = gg;
        ctx.fill();
      }
      // 眼睛
      ctx.fillStyle = col.eye;
      ctx.beginPath();
      ctx.ellipse(-4.2, -3, 2.2, 3, 0, 0, TAU);
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(4.2, -3, 2.2, 3, 0, 0, TAU);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.65)';
      ctx.beginPath();
      ctx.arc(-4.8, -4, 0.9, 0, TAU);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(3.6, -4, 0.9, 0, TAU);
      ctx.fill();
    } else if (e.kind === 'bat') {
      var flap = Math.sin(time * 16 + e.phase);
      ctx.translate(e.x, e.y);
      ctx.fillStyle = flash ? '#ffffff' : col.dark;
      // 翅膀
      ctx.beginPath();
      ctx.moveTo(-3, -2);
      ctx.quadraticCurveTo(-18, -10 - flap * 6, -20, 3 + flap * 3);
      ctx.quadraticCurveTo(-12, 4 + flap * 2, -3, 5);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(3, -2);
      ctx.quadraticCurveTo(18, -10 - flap * 6, 20, 3 + flap * 3);
      ctx.quadraticCurveTo(12, 4 + flap * 2, 3, 5);
      ctx.closePath();
      ctx.fill();
      // 身体
      ctx.fillStyle = flash ? '#ffffff' : col.body;
      ctx.beginPath();
      ctx.ellipse(0, 1, 7, 9, 0, 0, TAU);
      ctx.fill();
      // 耳朵
      ctx.beginPath();
      ctx.moveTo(-5, -6);
      ctx.lineTo(-7, -13);
      ctx.lineTo(-1, -8);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(5, -6);
      ctx.lineTo(7, -13);
      ctx.lineTo(1, -8);
      ctx.closePath();
      ctx.fill();
      // 眼睛
      ctx.fillStyle = col.eye;
      ctx.beginPath();
      ctx.arc(-2.6, 0, 1.7, 0, TAU);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(2.6, 0, 1.7, 0, TAU);
      ctx.fill();
      ctx.fillStyle = '#ffd0d0';
      ctx.beginPath();
      ctx.arc(-3, -0.4, 0.6, 0, TAU);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(2.2, -0.4, 0.6, 0, TAU);
      ctx.fill();
    } else {
      // 史莱姆
      var squish = Math.sin(time * 4.5 + e.phase) * 0.12;
      var rx = e.r * (1.05 + squish);
      var ry = e.r * (0.9 - squish);
      ctx.translate(e.x, e.y);
      ctx.fillStyle = flash ? '#ffffff' : col.dark;
      ctx.beginPath();
      ctx.ellipse(0, 3, rx, ry, 0, 0, TAU);
      ctx.fill();
      if (!flash) {
        var sg = ctx.createRadialGradient(-rx * 0.3, -ry * 0.5, 1, 0, 0, rx * 1.3);
        sg.addColorStop(0, col.light);
        sg.addColorStop(0.55, col.body);
        sg.addColorStop(1, col.dark);
        ctx.fillStyle = sg;
        ctx.beginPath();
        ctx.ellipse(0, 1, rx * 0.92, ry * 0.9, 0, 0, TAU);
        ctx.fill();
      }
      // 高光
      ctx.fillStyle = 'rgba(255,255,255,0.4)';
      ctx.beginPath();
      ctx.ellipse(-rx * 0.32, -ry * 0.42, rx * 0.22, ry * 0.16, -0.4, 0, TAU);
      ctx.fill();
      // 眼睛
      ctx.fillStyle = col.eye;
      ctx.beginPath();
      ctx.arc(-4.2, 0, 1.8, 0, TAU);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(4.2, 0, 1.8, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
    drawEnemyHpBar(ctx, e, e.kind === 'ghost' ? 28 : 24);
  }

  // ---------------------------------------------------------------------------
  // 粒子
  // ---------------------------------------------------------------------------
  function burst(particles, x, y, count, opt) {
    var o = opt || {};
    var colors = o.colors || ['#ffffff'];
    var speed = o.speed || [40, 160];
    var life = o.life || [0.3, 0.7];
    var size = o.size || [2, 4];
    var gravity = o.gravity === undefined ? 0 : o.gravity;
    var angle = o.angle === undefined ? 0 : o.angle;
    var spread = o.spread === undefined ? TAU : o.spread;
    for (var i = 0; i < count; i++) {
      var a = angle + (Math.random() - 0.5) * spread;
      var sp = speed[0] + Math.random() * (speed[1] - speed[0]);
      var lf = life[0] + Math.random() * (life[1] - life[0]);
      particles.push({
        x: x + (Math.random() - 0.5) * (o.jitter || 6),
        y: y + (Math.random() - 0.5) * (o.jitter || 6),
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp,
        life: lf,
        maxLife: lf,
        size: size[0] + Math.random() * (size[1] - size[0]),
        color: colors[Math.floor(Math.random() * colors.length)],
        gravity: gravity,
        drag: o.drag === undefined ? 2.2 : o.drag,
        shape: o.shape || 'rect',
        rot: Math.random() * TAU,
        spin: (Math.random() - 0.5) * 12
      });
    }
  }

  function drawParticles(ctx, particles) {
    for (var i = 0; i < particles.length; i++) {
      var p = particles[i];
      var a = clamp(p.life / p.maxLife, 0, 1);
      ctx.save();
      ctx.globalAlpha = a;
      ctx.fillStyle = p.color;
      if (p.shape === 'circle') {
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * (0.4 + a * 0.6), 0, TAU);
        ctx.fill();
      } else if (p.shape === 'spark') {
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillRect(-p.size * 1.6, -p.size * 0.25, p.size * 3.2, p.size * 0.5);
      } else {
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size);
      }
      ctx.restore();
    }
  }

  // ---------------------------------------------------------------------------
  // 屏幕效果 / HUD / 触屏控件
  // ---------------------------------------------------------------------------
  function drawVignette(ctx, w, h, hpRatio, flash, time) {
    var g = ctx.createRadialGradient(w / 2, h / 2, h * 0.42, w / 2, h / 2, h * 0.95);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(0,0,0,0.55)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);

    if (hpRatio <= 0.34) {
      var pulse = 0.22 + 0.16 * Math.sin(time * 4);
      var rg = ctx.createRadialGradient(w / 2, h / 2, h * 0.3, w / 2, h / 2, h * 0.9);
      rg.addColorStop(0, 'rgba(180, 20, 30, 0)');
      rg.addColorStop(1, 'rgba(200, 25, 40, ' + pulse.toFixed(3) + ')');
      ctx.fillStyle = rg;
      ctx.fillRect(0, 0, w, h);
    }

    if (flash > 0) {
      ctx.fillStyle = 'rgba(220, 30, 40, ' + (flash * 0.35).toFixed(3) + ')';
      ctx.fillRect(0, 0, w, h);
    }
  }

  function drawHUD(ctx, hud) {
    var w = hud.w || 960;
    var h = hud.h || 540;
    var pal = getPalette(hud.theme);
    var i;

    // 关卡标题（左上第二行小字）
    text(ctx, '第 ' + (hud.levelIndex + 1) + ' 关 · ' + hud.levelName, 22, 78, 15, 'rgba(220, 230, 255, 0.72)', 'left', '600');

    // 心
    var heartSize = 24;
    var startX = 34;
    var hy = 34;
    for (i = 0; i < hud.maxHp; i++) {
      drawHeartIcon(ctx, startX + i * 32, hy, heartSize, i < hud.hp);
    }

    // 宝石进度
    var gx = startX + hud.maxHp * 32 + 22;
    drawGemIcon(ctx, gx, hy, 20, hud.time);
    text(ctx, hud.gems + ' / ' + hud.totalGems, gx + 18, hy + 1, 20, '#e8f8ff', 'left', '700');

    // 钥匙
    if (hud.hasKey) {
      drawKeyIcon(ctx, gx + 110, hy, 20, pal.glow);
      text(ctx, '钥匙', gx + 126, hy + 1, 16, '#ffe9a3', 'left', '600');
    }

    // 计时 + 暂停按钮
    var pr = hud.pauseRect || { x: 892, y: 16, w: 44, h: 44 };
    text(ctx, U.formatTime ? U.formatTime(hud.timeMs) : String(hud.timeMs), pr.x - 16, hy, 22, '#eef3ff', 'right', '700');
    drawPauseButton(ctx, pr);

    // 场景提示（画布内底部，外壳 toast 之外的兜底）
    if (hud.hint && hud.hintAlpha > 0.01) {
      ctx.save();
      ctx.globalAlpha = clamp(hud.hintAlpha, 0, 1);
      setFont(ctx, 19, '600');
      var tw = ctx.measureText(hud.hint).width;
      var bx = w / 2 - tw / 2 - 18;
      var by = h - 74;
      ctx.fillStyle = 'rgba(8, 12, 22, 0.72)';
      roundRect(ctx, bx, by - 18, tw + 36, 36, 12);
      ctx.fill();
      ctx.strokeStyle = 'rgba(245, 197, 66, 0.4)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#ffe9a3';
      ctx.fillText(hud.hint, w / 2, by);
      ctx.restore();
    }
  }

  function drawPauseButton(ctx, rect) {
    ctx.save();
    ctx.fillStyle = 'rgba(8, 12, 22, 0.55)';
    roundRect(ctx, rect.x, rect.y, rect.w, rect.h, 10);
    ctx.fill();
    ctx.strokeStyle = 'rgba(220, 230, 255, 0.35)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = '#eef3ff';
    var bw = 5;
    var bh = 18;
    var cx = rect.x + rect.w / 2;
    var cy = rect.y + rect.h / 2;
    roundRect(ctx, cx - 10, cy - bh / 2, bw, bh, 2);
    ctx.fill();
    roundRect(ctx, cx + 5, cy - bh / 2, bw, bh, 2);
    ctx.fill();
    ctx.restore();
  }

  function drawTouchControls(ctx, layout, input, time) {
    var L = layout;
    // 摇杆基座
    var j = L.joystick;
    ctx.save();
    ctx.globalAlpha = input && input.joystick && input.joystick.active ? 0.55 : 0.32;
    ctx.fillStyle = 'rgba(12, 18, 30, 0.8)';
    ctx.beginPath();
    ctx.arc(j.cx, j.cy, j.r, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = 'rgba(220, 230, 255, 0.5)';
    ctx.lineWidth = 2;
    ctx.stroke();
    var mag = input && input.joystick ? input.joystick.mag : 0;
    var dx = input && input.joystick ? input.joystick.dx : 0;
    var dy = input && input.joystick ? input.joystick.dy : 0;
    var kx = j.cx + (mag > 0.14 ? dx : 0) * j.r * 0.62;
    var ky = j.cy + (mag > 0.14 ? dy : 0) * j.r * 0.62;
    ctx.globalAlpha = 0.75;
    var kg = ctx.createRadialGradient(kx, ky - 6, 2, kx, ky, j.knob);
    kg.addColorStop(0, 'rgba(245, 197, 66, 0.95)');
    kg.addColorStop(1, 'rgba(180, 130, 30, 0.85)');
    ctx.fillStyle = kg;
    ctx.beginPath();
    ctx.arc(kx, ky, j.knob, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 240, 200, 0.6)';
    ctx.lineWidth = 2;
    ctx.stroke();
    // 方向小箭头
    ctx.globalAlpha = 0.45;
    ctx.strokeStyle = 'rgba(230, 240, 255, 0.9)';
    ctx.lineWidth = 2;
    for (var d = 0; d < 4; d++) {
      var a = (d * Math.PI) / 2;
      var r0 = j.r * 0.68;
      var r1 = j.r * 0.82;
      ctx.beginPath();
      ctx.moveTo(j.cx + Math.cos(a) * r0, j.cy + Math.sin(a) * r0);
      ctx.lineTo(j.cx + Math.cos(a) * r1, j.cy + Math.sin(a) * r1);
      ctx.stroke();
    }
    ctx.restore();

    // 攻击按钮
    var b = L.attack;
    var pressed = input && input.attackHeld;
    ctx.save();
    ctx.globalAlpha = pressed ? 0.85 : 0.42;
    var bg = ctx.createRadialGradient(b.cx, b.cy - 8, 4, b.cx, b.cy, b.r);
    bg.addColorStop(0, 'rgba(255, 210, 120, 0.9)');
    bg.addColorStop(1, 'rgba(150, 60, 40, 0.85)');
    ctx.fillStyle = bg;
    ctx.beginPath();
    ctx.arc(b.cx, b.cy, pressed ? b.r * 0.94 : b.r, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 235, 190, 0.7)';
    ctx.lineWidth = 2.5;
    ctx.stroke();
    ctx.globalAlpha = 0.95;
    // 剑图标
    ctx.save();
    ctx.translate(b.cx, b.cy);
    ctx.rotate(-Math.PI / 4);
    ctx.strokeStyle = '#fff7e0';
    ctx.lineCap = 'round';
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(-12, 0);
    ctx.lineTo(16, 0);
    ctx.stroke();
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(-14, -9);
    ctx.lineTo(-14, 9);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(-20, 0);
    ctx.lineTo(-13, 0);
    ctx.stroke();
    ctx.restore();
    ctx.restore();
  }

  function drawLevelTitle(ctx, w, levelName, subtitle, alpha, time) {
    if (alpha <= 0.01) return;
    ctx.save();
    ctx.globalAlpha = clamp(alpha, 0, 1);
    var y = 150;
    text(ctx, levelName, w / 2, y, 44, '#ffe9a3', 'center', '800');
    text(ctx, subtitle, w / 2, y + 44, 18, 'rgba(235, 240, 255, 0.85)', 'center', '600');
    ctx.restore();
  }

  function drawBanner(ctx, w, h, title, subtitle, color) {
    ctx.save();
    ctx.fillStyle = 'rgba(5, 8, 16, 0.55)';
    ctx.fillRect(0, 0, w, h);
    text(ctx, title, w / 2, h / 2 - 26, 46, color || '#ffe9a3', 'center', '800');
    if (subtitle) text(ctx, subtitle, w / 2, h / 2 + 24, 20, 'rgba(235, 240, 255, 0.9)', 'center', '600');
    ctx.restore();
  }

  var Graphics = {
    FONT: FONT,
    PALETTES: PALETTES,
    getPalette: getPalette,
    roundRect: roundRect,
    shadowEllipse: shadowEllipse,
    drawBackground: drawBackground,
    drawTiles: drawTiles,
    drawSpikes: drawSpikes,
    drawDoor: drawDoor,
    drawPortal: drawPortal,
    drawItem: drawItem,
    drawPlayer: drawPlayer,
    drawEnemy: drawEnemy,
    drawParticles: drawParticles,
    burst: burst,
    drawVignette: drawVignette,
    drawHUD: drawHUD,
    drawPauseButton: drawPauseButton,
    drawTouchControls: drawTouchControls,
    drawLevelTitle: drawLevelTitle,
    drawBanner: drawBanner,
    spikeExtendFactor: spikeExtendFactor,
    isSpikeUp: isSpikeUp,
    heartPath: heartPath,
    drawHeartIcon: drawHeartIcon,
    text: text
  };

  TQ.Graphics = Graphics;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { Graphics: Graphics };
  }
})(typeof window !== 'undefined' ? window : globalThis);

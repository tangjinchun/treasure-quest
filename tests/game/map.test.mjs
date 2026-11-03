/**
 * 关卡地图自动测试（node:test）
 * 运行：在项目根目录执行 `node --test tests/game/`
 * 校验：矩形地图、唯一出生点/传送门、宝石数量、BFS 可达性、锁门门槛、字符合法性。
 * 与游戏共用 TQ.LevelData 的字符语义，确保测试结论与真实碰撞一致。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import levelModule from '../../web/js/core/level_data.js';

const { Levels, LevelData } = levelModule;

const DESIGN = [
  {
    name: '迷雾森林',
    theme: 'forest',
    width: 40,
    height: 23,
    gems: 5,
    keys: 0,
    doors: 0,
    slimes: 4,
    bats: 0,
    ghosts: 0,
    minSpikes: 0,
    minHeals: 1
  },
  {
    name: '幽暗洞窟',
    theme: 'cave',
    width: 44,
    height: 25,
    gems: 6,
    keys: 1,
    doors: 1,
    slimes: 3,
    bats: 3,
    ghosts: 0,
    minSpikes: 5,
    minHeals: 1
  },
  {
    name: '失落神殿',
    theme: 'temple',
    width: 48,
    height: 27,
    gems: 7,
    keys: 0,
    doors: 0,
    slimes: 0,
    bats: 3,
    ghosts: 3,
    minSpikes: 10,
    minHeals: 1
  },
  {
    name: '云端秘殿',
    theme: 'cloud',
    width: 52,
    height: 29,
    gems: 8,
    keys: 1,
    doors: 1,
    slimes: 3,
    bats: 2,
    ghosts: 4,
    minSpikes: 12,
    minHeals: 2
  }
];

const NEIGHBORS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1]
];

function findChar(level, ch) {
  const out = [];
  for (let y = 0; y < level.rows.length; y++) {
    const row = level.rows[y];
    for (let x = 0; x < row.length; x++) {
      if (row[x] === ch) out.push({ x, y });
    }
  }
  return out;
}

function countChars(level) {
  const counts = {};
  for (const row of level.rows) {
    for (const ch of row) counts[ch] = (counts[ch] || 0) + 1;
  }
  return counts;
}

/** 从出生点 BFS；doorOpen 控制锁门是否可通行 */
function bfsFromSpawn(level, doorOpen) {
  const spawn = findChar(level, 'P')[0];
  const visited = [];
  for (let y = 0; y < level.height; y++) visited.push(new Array(level.width).fill(false));
  const queue = [{ x: spawn.x, y: spawn.y }];
  visited[spawn.y][spawn.x] = true;
  while (queue.length) {
    const cur = queue.shift();
    for (const [dx, dy] of NEIGHBORS) {
      const nx = cur.x + dx;
      const ny = cur.y + dy;
      if (nx < 0 || ny < 0 || nx >= level.width || ny >= level.height) continue;
      if (visited[ny][nx]) continue;
      const ch = level.rows[ny][nx];
      if (LevelData.isBlockingChar(ch, doorOpen)) continue;
      visited[ny][nx] = true;
      queue.push({ x: nx, y: ny });
    }
  }
  return visited;
}

function assertReachable(visited, positions, label) {
  for (const pos of positions) {
    assert.ok(visited[pos.y][pos.x], `${label} 不可达：(${pos.x}, ${pos.y})`);
  }
}

test('关卡数量与设计表一致（4 关）', () => {
  assert.equal(Levels.length, DESIGN.length);
  Levels.forEach((level, i) => {
    const design = DESIGN[i];
    assert.equal(level.id, i);
    assert.equal(level.name, design.name, `第 ${i + 1} 关名称`);
    assert.equal(level.theme, design.theme, `第 ${i + 1} 关主题`);
    assert.equal(level.width, design.width, `第 ${i + 1} 关宽度`);
    assert.equal(level.height, design.height, `第 ${i + 1} 关高度`);
    assert.equal(level.tileSize, 32, `第 ${i + 1} 关瓦片尺寸`);
  });
});

test('四张地图均为严格矩形且只含合法字符', () => {
  for (const [i, level] of Levels.entries()) {
    assert.equal(level.rows.length, level.height, `第 ${i + 1} 关行数`);
    for (let y = 0; y < level.rows.length; y++) {
      const row = level.rows[y];
      assert.equal(row.length, level.width, `第 ${i + 1} 关第 ${y} 行长度`);
      for (let x = 0; x < row.length; x++) {
        assert.ok(
          LevelData.isKnownChar(row[x]),
          `第 ${i + 1} 关 (${x}, ${y}) 出现非法字符 "${row[x]}"`
        );
      }
    }
    // LevelData 中登记的合法字符必须覆盖每一行的实际字符
    const allowed = new Set(Object.values(LevelData.CHARS));
    for (const row of level.rows) {
      for (const ch of row) assert.ok(allowed.has(ch), `未登记字符: ${ch}`);
    }
  }
});

test('四张地图四周均有墙（不会越界）', () => {
  for (const [i, level] of Levels.entries()) {
    const { rows, width, height } = level;
    for (let x = 0; x < width; x++) {
      assert.equal(rows[0][x], '#', `第 ${i + 1} 关顶部边界 x=${x}`);
      assert.equal(rows[height - 1][x], '#', `第 ${i + 1} 关底部边界 x=${x}`);
    }
    for (let y = 0; y < height; y++) {
      assert.equal(rows[y][0], '#', `第 ${i + 1} 关左侧边界 y=${y}`);
      assert.equal(rows[y][width - 1], '#', `第 ${i + 1} 关右侧边界 y=${y}`);
    }
  }
});

test('出生点与传送门各恰好 1 个，且不在边界上', () => {
  for (const [i, level] of Levels.entries()) {
    const spawns = findChar(level, 'P');
    const portals = findChar(level, 'E');
    assert.equal(spawns.length, 1, `第 ${i + 1} 关出生点数量`);
    assert.equal(portals.length, 1, `第 ${i + 1} 关传送门数量`);
    for (const p of spawns.concat(portals)) {
      assert.ok(p.x > 0 && p.x < level.width - 1, `第 ${i + 1} 关出生点/传送门不在边界（x）`);
      assert.ok(p.y > 0 && p.y < level.height - 1, `第 ${i + 1} 关出生点/传送门不在边界（y）`);
    }
    // 出生点与传送门不能重合
    assert.notDeepEqual(spawns[0], portals[0], `第 ${i + 1} 关出生点与传送门重合`);
  }
});

test('宝石数量与设计表一致（5 / 6 / 7 / 8）', () => {
  for (const [i, level] of Levels.entries()) {
    const counts = countChars(level);
    assert.equal(counts.G || 0, DESIGN[i].gems, `第 ${i + 1} 关宝石数量`);
  }
});

test('钥匙/锁门数量与设计一致（第 2、4 关各 1 钥匙 + 1 锁门，其余关无）', () => {
  Levels.forEach((level, i) => {
    const counts = countChars(level);
    assert.equal(counts.K || 0, DESIGN[i].keys, `第 ${i + 1} 关钥匙数量`);
    assert.equal(counts.D || 0, DESIGN[i].doors, `第 ${i + 1} 关锁门数量`);
  });
  // 有钥匙的关卡必须同时有锁门
  for (const [i, level] of Levels.entries()) {
    const counts = countChars(level);
    if ((counts.K || 0) > 0) assert.ok((counts.D || 0) > 0, `第 ${i + 1} 关有钥匙却没有锁门`);
  }
});

test('敌人与机关数量满足设计（史莱姆/蝙蝠/幽灵/尖刺）', () => {
  for (const [i, level] of Levels.entries()) {
    const counts = countChars(level);
    const design = DESIGN[i];
    assert.equal(counts['1'] || 0, design.slimes, `第 ${i + 1} 关史莱姆数量`);
    assert.equal(counts['2'] || 0, design.bats, `第 ${i + 1} 关蝙蝠数量`);
    assert.equal(counts['3'] || 0, design.ghosts, `第 ${i + 1} 关幽灵数量`);
    assert.ok((counts['^'] || 0) >= design.minSpikes, `第 ${i + 1} 关尖刺数量不足`);
    assert.ok((counts.H || 0) >= design.minHeals, `第 ${i + 1} 关缺少回血道具`);
  }
});

test('BFS 可达性：门开启时，宝石/钥匙/回血/传送门全部可达', () => {
  for (const [i, level] of Levels.entries()) {
    const visited = bfsFromSpawn(level, true);
    const targets = []
      .concat(findChar(level, 'G'))
      .concat(findChar(level, 'K'))
      .concat(findChar(level, 'H'))
      .concat(findChar(level, 'E'));
    assertReachable(visited, targets, `第 ${i + 1} 关（门开启）`);
  }
});

test('含锁门关卡的门槛：无钥匙时钥匙可达、传送门不可达、部分宝石不可达、门为唯一通道', () => {
  let doorLevels = 0;
  for (const [i, level] of Levels.entries()) {
    const door = findChar(level, 'D');
    if (door.length === 0) continue;
    doorLevels++;
    const label = `第 ${i + 1} 关（无钥匙）`;
    const closed = bfsFromSpawn(level, false);
    const key = findChar(level, 'K');
    assert.ok(key.length === 1, `${label} 缺少钥匙`);
    assertReachable(closed, key, `${label} 钥匙`);

    const gems = findChar(level, 'G');
    const blockedGems = gems.filter((g) => !closed[g.y][g.x]);
    assert.ok(blockedGems.length > 0, `${label}锁门未起到门槛作用：所有宝石在无钥匙时都可达`);

    const portal = findChar(level, 'E');
    assert.ok(!closed[portal[0].y][portal[0].x], `${label} 无钥匙时传送门不应可达`);

    // 无钥匙时仍应能收集到部分宝石，保证不是全部被锁
    const reachableGems = gems.length - blockedGems.length;
    assert.ok(reachableGems >= 1, `${label} 无钥匙时应至少有一颗宝石可达`);

    // 门的两侧：入口侧可达、锁定侧不可达（证明门是唯一通道）
    const d = door[0];
    const neighbors = [
      { x: d.x - 1, y: d.y },
      { x: d.x + 1, y: d.y },
      { x: d.x, y: d.y - 1 },
      { x: d.x, y: d.y + 1 }
    ].filter((n) => n.x > 0 && n.y > 0 && n.x < level.width - 1 && n.y < level.height - 1);
    const reachableSides = neighbors.filter((n) => closed[n.y][n.x]);
    const lockedSides = neighbors.filter((n) => !closed[n.y][n.x]);
    assert.ok(reachableSides.length >= 1, `${label} 锁门入口侧应可达`);
    assert.ok(lockedSides.length >= 1, `${label} 锁门锁定侧应不可达（门不是唯一通道？）`);
  }
  assert.equal(doorLevels, 2, '设计上应有 2 个含锁门的关卡（第 2、4 关）');
});

test('第 4 关「云端秘殿」设计校验（52x29 / 8 宝石 / 4 幽灵 2 蝙蝠 3 史莱姆 / 尖刺≥12）', () => {
  const level = Levels[3];
  assert.ok(level, '缺少第 4 关');
  assert.equal(level.name, '云端秘殿');
  assert.equal(level.theme, 'cloud');
  assert.equal(level.width, 52);
  assert.equal(level.height, 29);
  assert.equal(level.rows.length, 29);
  assert.ok(level.rows.every((r) => r.length === 52), '第 4 关存在非 52 列的行');

  const counts = countChars(level);
  assert.equal(counts.G, 8, '第 4 关宝石数量');
  assert.equal(counts.K, 1, '第 4 关钥匙数量');
  assert.equal(counts.D, 1, '第 4 关锁门数量');
  assert.equal(counts['1'], 3, '第 4 关史莱姆数量');
  assert.equal(counts['2'], 2, '第 4 关蝙蝠数量');
  assert.equal(counts['3'], 4, '第 4 关幽灵数量');
  assert.ok(counts['^'] >= 12, '第 4 关尖刺数量不足');
  assert.ok(counts.H >= 2, '第 4 关缺少回血道具');

  // 传送门在右下区域
  const portal = findChar(level, 'E')[0];
  assert.ok(portal.x >= level.width - 6, `第 4 关传送门应在右侧，实际 x=${portal.x}`);
  assert.ok(portal.y >= level.height - 6, `第 4 关传送门应在下方，实际 y=${portal.y}`);

  // 出生点在左上区域，且不在边界
  const spawn = findChar(level, 'P')[0];
  assert.ok(spawn.x < level.width / 2 && spawn.y < level.height / 2, '第 4 关出生点应在左上区域');

  // 门开启后：全部宝石、钥匙、回血、传送门可达
  const open = bfsFromSpawn(level, true);
  assertReachable(
    open,
    [].concat(findChar(level, 'G'), findChar(level, 'K'), findChar(level, 'H'), findChar(level, 'E')),
    '第 4 关（门开启）'
  );

  // 无钥匙时：钥匙可达，传送门不可达
  const closed = bfsFromSpawn(level, false);
  assertReachable(closed, findChar(level, 'K'), '第 4 关（无钥匙）钥匙');
  assert.equal(closed[portal.y][portal.x], false, '第 4 关无钥匙时传送门不应可达');
});

test('出生点周围没有紧贴的敌人（至少 4 格曼哈顿距离）', () => {
  for (const [i, level] of Levels.entries()) {
    const spawn = findChar(level, 'P')[0];
    for (const ch of ['1', '2', '3']) {
      for (const e of findChar(level, ch)) {
        const d = Math.abs(e.x - spawn.x) + Math.abs(e.y - spawn.y);
        assert.ok(d >= 4, `第 ${i + 1} 关敌人(${ch}) (${e.x},${e.y}) 距离出生点过近: ${d}`);
      }
    }
  }
});

test('LevelData 字符语义：阻挡/可通行与门开关一致', () => {
  assert.equal(LevelData.isKnownChar('#'), true);
  assert.equal(LevelData.isKnownChar('x'), false);
  assert.equal(LevelData.isBlockingChar('#', true), true);
  assert.equal(LevelData.isBlockingChar('~', true), true);
  assert.equal(LevelData.isBlockingChar('T', true), true);
  assert.equal(LevelData.isBlockingChar('D', false), true, '未开门时锁门阻挡');
  assert.equal(LevelData.isBlockingChar('D', true), false, '开门后锁门可通行');
  assert.equal(LevelData.isBlockingChar('^', true), false, '尖刺可通行（由陷阱逻辑伤害）');
  assert.equal(LevelData.isBlockingChar('G', true), false);
  assert.equal(LevelData.isWalkableChar('.', true), true);
  assert.equal(LevelData.isWalkableChar('0', true), true);
  assert.equal(LevelData.isWalkableChar('#', true), false);
});

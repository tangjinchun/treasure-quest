# 《寻宝奇兵》游戏设计与模块接口（v1 + v2 内容更新）

## 1. 游戏概念

- 类型：2D 俯视角闯关探险 + 收集宝藏
- 平台：Android（横屏，内置横屏锁定）+ 桌面浏览器（调试）
- 目标玩家：v1 只有测试账号，单机玩法为主，登录仅用于验证后端链路
- 单局时长：每关 2–5 分钟；4 关通关约 15–20 分钟
- 画风：程序化绘制的扁平/像素风（不引入外部美术资源，避免版权问题）；WebAudio 程序化音效
- 叙事：小探险家「阿寻」进入四处遗迹，收集「星辰碎片」，修复传送门寻找失落的宝藏

## 2. 核心循环

```
登录/游客 → 主菜单 → 选关（按进度解锁） → 探索地图
   ├─ 收集全部宝石（必须）
   ├─ 拾取钥匙 → 打开锁住的门（第 2 关）
   ├─ 躲避/攻击敌人与陷阱，血量归零则重开本关
   └─ 全部宝石收集后传送门激活 → 进入 → 结算（用时/宝物数）→ 解锁下一关
```

- 失败：血量归零 → 本关重开（不扣进度）。
- 暂停：ESC/触屏暂停按钮 → 暂停菜单（继续/重开/返回主菜单）。
- 存档：过关时保存（解锁进度、最佳用时、累计宝物数、音效开关）。

## 3. 系统与数值

| 系统 | 规则 |
|---|---|
| 移动 | 8 方向（键盘）／虚拟摇杆（触屏）；速度 150px/s（逻辑分辨率 960×540）；对角线归一化 |
| 玩家 | 3 颗心；受击后 1.2s 无敌闪烁；出生点重生；死亡动画/粒子 |
| 攻击 | 剑击扇形/矩形判定，冷却 0.35s；可击杀史莱姆、蝙蝠、幽灵；击退 |
| 收集 | 宝石必须全部收集才激活出口；钥匙为可选机制（第 2、4 关必需）；宝物分 5/6/7/8 个 |
| 敌人 1 史莱姆 | 地面巡逻，来回移动，接触伤害 1，血量 2 |
| 敌人 2 蝙蝠 | 正弦轨迹飞行，接触伤害 1，血量 1，不撞墙 |
| 敌人 3 幽灵（第 3 关） | 缓慢追踪玩家，接触伤害 1，血量 3，穿墙（限制范围） |
| 机关 | 尖刺（周期伸缩，伤害 1）、锁门（需钥匙）、传送门（收集齐后激活） |
| 相机 | 跟随玩家，带边界钳制；地图尺寸大于视口 |
| 手感 | 屏幕震动（受击/击杀）、粒子（击中/收集/传送）、收集音效、低血量红边暗角 |
| 计时 | 每关计时；结算显示用时；最佳用时存档 |

## 4. 关卡设计

| 关卡 | 主题 | 地图尺寸(tile 32px) | 内容 | 通关条件 |
|---|---|---|---|---|
| 1 迷雾森林 | 森林绿地 | 40×23 | 5 颗宝石、4 只史莱姆、树/水障碍 | 收集 5 宝石 → 传送门 |
| 2 幽暗洞窟 | 洞穴暗色调 | 44×25 | 6 颗宝石、1 把钥匙、锁门、史莱姆+蝙蝠、尖刺 | 钥匙开门 → 收集 6 宝石 → 传送门 |
| 3 失落神殿 | 遗迹金色 | 48×27 | 7 颗宝石、蝙蝠+幽灵、尖刺阵、需绕路 | 收集 7 宝石 → 传送门 |
| 4 云端秘殿（v2 新增） | 云海大理石 | 52×29 | 8 颗宝石、1 把钥匙 + 锁门（横贯云墙的唯一通道）、3 史莱姆+2 蝙蝠+4 幽灵、尖刺 18 | 钥匙开门 → 收集 8 宝石 → 传送门 |

地图用字符数组描述（便于编辑与自动测试）：

```
# 墙/障碍   . 地面   ~ 水(阻挡)   T 树(阻挡)   ^ 尖刺   P 玩家出生点
G 宝石     K 钥匙   D 锁门      E 传送门     H 回血道具
1 史莱姆   2 蝙蝠   3 幽灵      0 空地(可走)
```

要求：
- 每张图必须恰好 1 个 `P`、1 个 `E`；宝石数量与设计表一致。
- 从出生点出发，宝石/钥匙/传送门必须可达（用 BFS 自动测试验证；锁门在获得钥匙前视为不可通行）。

### 4.1 v2 内容更新：第 4 关「云端秘殿」

v0.1.0 通过内容 OTA 发布了第 4 关（contentVersion=2），用于验证内容热更新链路。

| 项 | 设计 |
|---|---|
| 主题 | `cloud` 云海大理石（新调色板，与前 3 关视觉区分） |
| 尺寸 | 52×29 tile，四周封闭 |
| 宝石 / 钥匙 / 锁门 | 8 颗（上层 3 / 下层 5）；1 钥匙在左上；1 锁门位于横贯全图的云墙唯一通道 |
| 敌人 | 幽灵 4、蝙蝠 2、史莱姆 3 |
| 机关 | 尖刺 18 处（含 3 段尖刺阵）、回血道具 2 |
| 出生 / 传送门 | 出生 (3,6) 左上；传送门 (48,26) 右下 |
| 兼容 | 公开 API 不变；选关页动态渲染 4 张卡片；v1 老存档若已通关第 3 关，加载时自动迁移 `unlockedLevel` 解锁第 4 关 |
- 地图四周必须有墙，防止越界。

## 5. 模块接口契约

### 5.1 目录与加载顺序

`web/index.html` 中脚本顺序固定：

```html
<script src="js/core/util.js"></script>
<script src="js/core/audio.js"></script>
<script src="js/core/input.js"></script>
<script src="js/core/graphics.js"></script>
<script src="js/core/level_data.js"></script>
<script src="js/core/game.js"></script>
<script src="js/shell/save.js"></script>
<script src="js/shell/net.js"></script>
<script src="js/shell/ui.js"></script>
<script src="js/shell/boot.js"></script>
```

所有文件用 IIFE 挂到全局 `window.TQ`；**不引入 ES Module、不引入打包工具、不引入外部依赖**。
核心文件（util/level_data）必须同时兼容 Node 测试：

```js
(function (global) {
  'use strict';
  var TQ = global.TQ = global.TQ || {};
  // ...
  TQ.Levels = LEVELS;
  TQ.Util = Util;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { Levels: LEVELS, Util: Util };
  }
})(typeof window !== 'undefined' ? window : globalThis);
```

### 5.2 核心（游戏核心）对外接口 `TQ.Game`

```js
TQ.Game = {
  init: function (opts) {},          // opts: {canvas: HTMLCanvasElement, onEvent: function(event)}
  startLevel: function (index) {},   // index: 0..N-1
  restartLevel: function () {},
  pause: function () {},
  resume: function () {},
  destroy: function () {},
  isRunning: function () {},         // -> boolean
  getLevelCount: function () {}      // -> number
};
```

事件（通过 `opts.onEvent` 上报给外壳）：

| 事件 type | 字段 | 说明 |
|---|---|---|
| `levelStart` | `level` | 关卡开始 |
| `treasure` | `collected, total, treasureId` | 收集一颗宝石 |
| `key` | `collected: true` | 拾取钥匙 |
| `door` | `opened: true` | 开门 |
| `playerHp` | `hp, maxHp` | 血量变化 |
| `enemyKilled` | `kind` | 击杀敌人（给外壳做成就提示预留） |
| `levelComplete` | `level, treasures, total, timeMs, hp` | 通关；外壳负责解锁与存档 |
| `playerDied` | `level` | 死亡；外壳展示重开 |
| `requestPause` | — | ESC/触屏暂停/安卓返回键触发 |
| `hint` | `text` | 场景提示（如「需要钥匙」「传送门已激活」） |

实现要求：
- 内部固定逻辑分辨率 960×540，根据容器缩放（保持 16:9，letterbox），处理 devicePixelRatio。
- 用 `requestAnimationFrame`，带 delta clamp（避免后台切回大跳）。
- 仅 游戏核心 可接触 canvas / 绘制游戏画面与 HUD；不操作 DOM 其他元素。
- 触屏：左下虚拟摇杆 + 右下攻击按钮，按钮位置随画布缩放；触摸事件阻止页面滚动。
- HUD 画在 canvas：心、宝石进度、计时、暂停按钮。
- 无外部资源文件；字用 canvas 字体（系统字体，中文可用）。

### 5.3 外壳（游戏外壳）对外接口

```js
TQ.Save = {
  load(): SaveData,          // 缺省/损坏时返回默认存档
  save(data),                // 整体覆盖
  patch(partial),            // 合并更新
  reset(),
  DEFAULT: {...}
};

TQ.Net = {
  getApiBase(): string,
  login(username, password): Promise<{ok, token, displayName}>,
  checkVersion(): Promise<manifest>,      // 浏览器直接 fetch；APP 内走 TQNative
  checkUpdateViaNative(): boolean,        // 是否可用原生桥
  onNativeEvent(type, payload),           // 处理 TQNativeEvent
  isOnline(): boolean
};

TQ.UI = {
  init(),                    // 绑定 DOM，渲染登录页
  showScreen(name),          // 'boot' | 'login' | 'menu' | 'levels' | 'settings' | 'game'
  toast(text, type),         // 轻提示
  setUpdateBadge(show)
};

TQ.Boot = { start() };       // DOMContentLoaded 后调用；负责组装 Game/UI/Net/Save
```

外壳职责：登录页（含「游客试玩」）、主菜单、关卡选择（锁定态）、设置页（音效/版本/检查更新/更新弹窗/进度）、通关/死亡/暂停覆盖层、存档读写、更新事件处理、安卓返回键处理入口 `TQ.Shell.onAndroidBack()`。

### 5.4 UI 视觉规范（游戏外壳）

- 背景：深色渐变 + 星点/雾气（CSS/canvas 均可），游戏画面 16:9 居中，页面其余留黑。
- 主色：`#f5c542`（金）、`#3ddc97`（翡翠）、`#5b8cff`（蓝）、`#1b2233`（深底）。
- 字体：`"Microsoft YaHei", "PingFang SC", system-ui, sans-serif`；标题金色、正文浅灰。
- 按钮：圆角 12px、主按钮金色填充/深色文字，次按钮描边；hover/active 有反馈；触屏尺寸 ≥ 48px。
- 覆盖层背景半透明加模糊；版本号、更新状态用小号灰字。
- 中文文案统一简体；文案集中写在 `ui.js` 的字符串表，便于后续国际化。

## 6. 存档数据结构（localStorage `tq.save.v1`）

```json
{
  "schema": 1,
  "unlockedLevel": 2,
  "bestTimes": {"0": 52310, "1": 81230},
  "totalTreasures": 11,
  "sound": true,
  "updatedAt": "2026-11-03T14:00:00+08:00"
}
```

- `unlockedLevel`：已解锁的最高关卡 index（0 起）；初始 0（只开第 1 关）。
- 兼容策略：读取时校验 `schema`，未知字段忽略，缺字段补默认值。
- 登录态单独存 `tq.session.v1`：`{token, username, displayName, expiresAt}`。

## 7. 验收标准（v1）

1. 浏览器 `http://127.0.0.1:5173` 可完成：登录（或游客）→ 通关 4 关 → 刷新后进度保留。
2. 键盘 WASD/方向键移动、J/空格攻击、ESC 暂停；触屏摇杆与攻击按钮在桌面模拟/手机可用。
3. 3 张地图通过 BFS 可达性自动测试；宝石数量/出生点/传送门数量符合设计表。
4. 无控制台报错；帧率在桌面浏览器 ≥ 55fps（Chrome/Edge）；无外部网络资源依赖。
5. 设置页可显示内容版本；浏览器模式可演示「检查更新」请求（安装按钮禁用）。
6. 文件总大小（压缩前）≤ 400KB，便于 OTA。

## 8. 交付给其他模块的约定

- 游戏核心 不直接调用 `TQ.Net`/`TQ.Save`/`TQ.UI`；只通过 `onEvent` 上报、通过入参接收。
- 游戏外壳 不直接读写 canvas 内部状态；只调用 `TQ.Game.*`（可读 `TQ.Game.getSnapshot()` 以便调试，可选实现）。
- 双方都不得修改对方文件；接口变更先改 `docs/ARCH.md`/本文件并通知 维护者。

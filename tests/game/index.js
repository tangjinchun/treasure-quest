'use strict';
/**
 * tests/game 目录入口聚合文件。
 *
 * Node 24 的测试运行器不再把目录参数自动展开为测试文件（`node --test tests/game/`
 * 会把 tests/game 当作单个模块加载）。此 index.js 作为目录入口，依次加载各测试文件，
 * 保证契约中的命令 `node --test tests/game/` 在项目根目录可直接运行。
 *
 * 也可以单独运行某个文件：
 *   node --test tests/game/map.test.mjs
 *   node --test "tests/game/*.test.mjs"
 */
require('./map.test.mjs');
require('./util.test.mjs');
require('./game.test.mjs');

/**
 * settings.mjs —— CLI 默认文件解析。
 *
 * 优先级必须是：DSH_HOME 显式设置 > 已存在的候选 > ~/.dsh 默认。
 * 「DSH_HOME 设了但目录还是空的」是最容易写错的分支：DSH_HOME 是显式
 * 覆盖，此时哪怕 ~/.dsh/settings.yaml 真实存在，也不能选它 —— 否则
 * add --apply 会把配置写进一个用户根本没指定的文件。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSettingsFile, settingsPath, candidateFiles } from '../src/settings.mjs';

const homes = [];
const sandbox = () => { const h = mkdtempSync(join(tmpdir(), 'dsh-mac-home-')); homes.push(h); return h; };

test.after(() => { for (const h of homes) rmSync(h, { recursive: true, force: true }); });

/** 固定 HOME 与 DSH_HOME 后跑 fn，跑完恢复。 */
const withEnv = (home, dshHome, fn) => {
  const prevHome = process.env.HOME, prevDsh = process.env.DSH_HOME;
  process.env.HOME = home;
  if (dshHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = dshHome;
  try { return fn(); } finally {
    process.env.HOME = prevHome;
    if (prevDsh === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prevDsh;
  }
};

test('DSH_HOME 显式设置 → 无条件优先（即使它下面还没有文件）', () => {
  const home = sandbox();               // 真实 ~/.dsh 也存在，必须被显式覆盖压住
  withEnv(home, join(home, 'dsh-home'), () => {
    assert.equal(defaultSettingsFile(), join(home, 'dsh-home', 'settings.yaml'));
  });
});

test('DSH_HOME 里有 settings.yaml → 同样选它', () => {
  const home = sandbox();
  const dsh = join(home, 'dsh-home');
  mkdirSync(dsh); writeFileSync(join(dsh, 'settings.yaml'), 'llm-pi-ai:\n  providers: {}\n');
  withEnv(home, dsh, () => {
    assert.equal(defaultSettingsFile(), join(dsh, 'settings.yaml'));
    assert.ok(candidateFiles().some((c) => c.file === join(dsh, 'settings.yaml') && c.exists));
  });
});

test('未设 DSH_HOME → 取已存在的 ~/.dsh/settings.yaml', () => {
  const home = sandbox();
  mkdirSync(join(home, '.dsh'));
  writeFileSync(join(home, '.dsh', 'settings.yaml'), 'llm-pi-ai:\n  providers: {}\n');
  withEnv(home, undefined, () => {
    assert.equal(defaultSettingsFile(), join(home, '.dsh', 'settings.yaml'));
  });
});

test('未设 DSH_HOME 且 ~/.dsh 没有 → 取 ~/.config/dsh（dsh 的第二落点）', () => {
  const home = sandbox();
  mkdirSync(join(home, '.config', 'dsh'), { recursive: true });
  writeFileSync(join(home, '.config', 'dsh', 'settings.yaml'), 'llm-pi-ai:\n  providers: {}\n');
  withEnv(home, undefined, () => {
    assert.equal(defaultSettingsFile(), join(home, '.config', 'dsh', 'settings.yaml'),
      'dsh 实际用 ~/.config/dsh 时，默认写 ~/.dsh 会写一个 dsh 不读的文件');
  });
});

test('未设 DSH_HOME、~/.dsh 只有 settings.yml → 也认（yaml 优先于 yml）', () => {
  const home = sandbox();
  mkdirSync(join(home, '.dsh'));
  writeFileSync(join(home, '.dsh', 'settings.yml'), 'llm-pi-ai:\n  providers: {}\n');
  withEnv(home, undefined, () => {
    assert.equal(defaultSettingsFile(), join(home, '.dsh', 'settings.yml'));
  });
});

test('一个候选都不存在 → 新建走 settingsPath()（DSH_HOME 或 ~/.dsh）', () => {
  const home = sandbox();
  withEnv(home, undefined, () => {
    assert.equal(defaultSettingsFile(), settingsPath());
    assert.equal(defaultSettingsFile(), join(home, '.dsh', 'settings.yaml'));
  });
});

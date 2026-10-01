import assert from 'node:assert';
import { createPinia, setActivePinia } from 'pinia';
import { useLiftStore } from '../src/store';
import { clone } from '../src/collab/diff';
import { mergePlans, computeMerged } from '../src/collab/merge';
import { readServer, writeServer, SERVER_KEY } from '../src/collab/server';
import { upgradeLegacyIfNeeded, LEGACY_DRAFT_KEY, LEGACY_BACKUP_KEY } from '../src/collab/upgrade';
import type { PlanState } from '../src/collab/types';

// ---- 浏览器环境 mock ----
const memory = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (key: string) => (memory.has(key) ? memory.get(key)! : null),
  setItem: (key: string, value: string) => void memory.set(key, String(value)),
  removeItem: (key: string) => void memory.delete(key)
};
(globalThis as any).BroadcastChannel = class {
  postMessage() {}
  close() {}
  set onmessage(_v: any) {}
};

let passed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

function freshStore() {
  memory.clear();
  setActivePinia(createPinia());
  const store = useLiftStore();
  store.resetWorking(readServer());
  return store;
}

console.log('\n== 1. 基线与取批次号 ==');

test('服务端初始基线带版本号、会签和冲突项', () => {
  const server = readServer();
  assert.equal(server.revision, 4);
  assert.ok(server.steps.every((s) => s.version === 1));
  assert.equal(server.signoffs.length, 4);
  assert.ok(server.findings.length > 0);
  assert.equal(server.lock.locked, false);
});

test('取批次号后基线为服务端快照，批次号递增', () => {
  const store = freshStore();
  store.acquireBatch();
  assert.equal(store.batch!.batchId, 1);
  assert.equal(store.batch!.baseline.revision, 4);
  store.updateStep({ clearance: 1.9 });
  assert.equal(store.hasUnsavedChanges, true);
  store.acquireBatch();
  assert.equal(store.batch!.batchId, 2);
});

console.log('\n== 2. 保存与三路合并 ==');

test('单标签保存：提交后版本+1，工作副本换新基线', () => {
  const store = freshStore();
  store.acquireBatch();
  store.updateStep({ clearance: 1.9 });
  store.saveBatch();
  const server = readServer();
  assert.equal(server.revision, 5);
  assert.equal(server.steps.find((s) => s.id === 'S-02')!.clearance, 1.9);
  assert.equal(store.revision, 5);
  assert.equal(store.hasUnsavedChanges, false);
});

test('双方改同一对象的不同字段：按字段自动合并，不进冲突清单', () => {
  memory.clear();
  const server0 = readServer();
  // 双方都在提交前取批次号（基线均为 rev4）
  setActivePinia(createPinia());
  const tabA = useLiftStore();
  tabA.resetWorking(server0);
  tabA.acquireBatch();
  setActivePinia(createPinia());
  const tabB = useLiftStore();
  tabB.resetWorking(server0);
  tabB.acquireBatch();
  tabA.updateStep({ clearance: 1.7 });
  tabA.saveBatch();
  tabB.updateStep({ wind: 6.2 });
  tabB.saveBatch();
  const server = readServer();
  const s2 = server.steps.find((s) => s.id === 'S-02')!;
  assert.equal(s2.clearance, 1.7, '甲方净空修改保留');
  assert.equal(s2.wind, 6.2, '乙方风速修改保留');
});

test('双方改同一字段：整批退回冲突清单，按字段合并保留选择', () => {
  memory.clear();
  const server0 = readServer();
  setActivePinia(createPinia());
  const tabA = useLiftStore();
  tabA.resetWorking(server0);
  tabA.acquireBatch();
  setActivePinia(createPinia());
  const tabB = useLiftStore();
  tabB.resetWorking(server0);
  tabB.acquireBatch();
  tabA.updateStep({ loadRate: 40 });
  tabA.saveBatch();
  tabB.updateStep({ loadRate: 55 });
  tabB.saveBatch();
  assert.equal(tabB.conflictDialogOpen, true, '冲突对话框打开');
  assert.equal(tabB.conflicts.length, 1);
  assert.equal(tabB.conflicts[0].objectType, 'step');
  assert.ok(tabB.conflicts[0].fieldConflicts.some((f) => f.field === 'loadRate'));
  // 选择保留对方
  const rec = tabB.conflicts[0];
  rec.resolution = 'keep-remote';
  computeMerged(rec);
  tabB.applyResolutions();
  const server = readServer();
  assert.equal(server.steps.find((s) => s.id === 'S-02')!.loadRate, 40, '保留对方（甲方）的值');
  assert.equal(tabB.conflictDialogOpen, false);
});

test('评论冲突：保留双方后两条评论都在', () => {
  memory.clear();
  const server0 = readServer();
  setActivePinia(createPinia());
  const tabA = useLiftStore();
  tabA.resetWorking(server0);
  tabA.acquireBatch();
  setActivePinia(createPinia());
  const tabB = useLiftStore();
  tabB.resetWorking(server0);
  tabB.acquireBatch();
  tabA.addComment('甲方补充意见：注意吊点');
  tabA.saveBatch();
  tabB.addComment('乙方补充意见：注意地基');
  // 双方新增不同 id 评论，不冲突
  tabB.saveBatch();
  assert.equal(tabB.conflicts.length, 0);
  assert.ok(readServer().comments.length === server0.comments.length + 2);
});

test('同一评论双方修改：保留双方', () => {
  memory.clear();
  const server0 = readServer();
  setActivePinia(createPinia());
  const tabA = useLiftStore();
  tabA.resetWorking(server0);
  tabA.acquireBatch();
  setActivePinia(createPinia());
  const tabB = useLiftStore();
  tabB.resetWorking(server0);
  tabB.acquireBatch();
  tabA.comments[0].content = '甲方修改后的内容';
  tabA.saveBatch();
  tabB.comments[0].content = '乙方修改后的内容';
  tabB.saveBatch();
  assert.equal(tabB.conflicts.length, 1);
  const rec = tabB.conflicts[0];
  rec.resolution = 'keep-both';
  computeMerged(rec);
  tabB.applyResolutions();
  const server = readServer();
  const contents = server.comments.map((c) => c.content);
  assert.ok(contents.some((c) => c.includes('甲方')));
  assert.ok(contents.some((c) => c.includes('乙方')));
});

console.log('\n== 3. 会签与发布锁失效 ==');

test('步骤参数变更后，覆盖该步骤的已接受会签立即失效', () => {
  const store = freshStore();
  store.acquireBatch();
  const signoff = store.signoffs.find((s) => s.id === 'SIGN-01')!;
  assert.equal(signoff.valid, true);
  store.updateStep({ loadRate: 45 });
  assert.equal(signoff.valid, false, '会签失效');
  assert.equal(signoff.state, 'pending');
});

test('保存后服务端会签失效、发布锁释放', () => {
  const store = freshStore();
  // 先锁定
  store.acquireBatch();
  store.lock = { locked: true, revision: 5, lockedBy: '王工', lockedAt: new Date().toISOString(), version: 2 };
  store.saveBatch();
  let server = readServer();
  assert.equal(server.lock.locked, true);
  // 再改参数
  store.updateStep({ wind: 7.5 });
  store.saveBatch();
  server = readServer();
  assert.equal(server.lock.locked, false, '发布锁释放');
  assert.equal(server.signoffs.find((s) => s.id === 'SIGN-01')!.valid, false);
});

test('会签失效后重新签署可恢复', () => {
  const store = freshStore();
  store.acquireBatch();
  store.updateStep({ loadRate: 45 });
  const signoff = store.signoffs.find((s) => s.id === 'SIGN-01')!;
  assert.equal(signoff.valid, false);
  store.signoff(signoff.id);
  assert.equal(signoff.valid, true);
  assert.equal(signoff.state, 'accepted');
});

console.log('\n== 4. 离线暂存与恢复 ==');

test('离线时保存只暂存本机，联网后补保存', () => {
  const store = freshStore();
  store.acquireBatch();
  store.updateStep({ note: '离线修改的说明' });
  store.online = false;
  store.saveBatch();
  assert.ok(store.toast.includes('离线'));
  assert.ok(memory.has('yy58-lift-plan-batch'));
  // 模拟联网
  store.online = true;
  store.saveBatch();
  const server = readServer();
  assert.equal(server.steps.find((s) => s.id === 'S-02')!.note, '离线修改的说明');
});

test('关闭页面重开：恢复未完成批次', () => {
  const store = freshStore();
  store.acquireBatch();
  store.updateStep({ note: '未完成的修改' });
  store.persistBatch();
  // 模拟重开：新 store 实例
  setActivePinia(createPinia());
  const reopened = useLiftStore();
  reopened.resetWorking(readServer());
  reopened.recoverBatch();
  assert.equal(reopened.showRecovery, false);
  assert.equal(reopened.steps.find((s) => s.id === 'S-02')!.note, '未完成的修改');
  assert.equal(reopened.hasUnsavedChanges, true);
});

console.log('\n== 5. 旧稿升级 ==');

test('无版本号旧稿：升级保留原数据并备份', () => {
  memory.clear();
  const legacy = {
    steps: [
      { id: 'S-01', title: '旧步骤', time: '07:30', loadRate: 10, clearance: 3, wind: 2, radius: 18, boom: 42, status: 'passed', note: '旧数据' }
    ],
    comments: [],
    revision: 3,
    locked: true,
    viewBookmarks: ['主吊全景'],
    activeBookmark: '主吊全景'
  };
  memory.set(LEGACY_DRAFT_KEY, JSON.stringify(legacy));
  const result = upgradeLegacyIfNeeded();
  assert.equal(result.upgraded, true);
  const server = readServer();
  assert.equal(server.revision, 3);
  assert.equal(server.steps[0].note, '旧数据', '原数据保留');
  assert.equal(server.steps[0].version, 1, '补版本号');
  assert.equal(server.lock.locked, true, '锁定状态迁移');
  assert.ok(memory.has(LEGACY_BACKUP_KEY), '旧稿已备份');
  assert.ok(!memory.has(LEGACY_DRAFT_KEY), '旧稿已清除');
});

test('无旧稿无服务端：直接播种基线', () => {
  memory.clear();
  const result = upgradeLegacyIfNeeded();
  assert.equal(result.upgraded, false);
  const server = readServer();
  assert.equal(server.revision, 4);
});

console.log(`\n结果：${passed} 项测试通过\n`);

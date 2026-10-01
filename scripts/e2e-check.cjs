// 端到端验证脚本：node 下模拟浏览器环境，编译 TS 后驱动复核批次核心流程。
const esbuild = require('esbuild');
const path = require('path');
const assert = require('assert');

// ---- 浏览器环境桩 ----
const storage = new Map();
const storageListeners = new Set();
globalThis.localStorage = {
  getItem: (k) => (storage.has(k) ? storage.get(k) : null),
  setItem: (k, v) => {
    const old = storage.has(k) ? storage.get(k) : null;
    storage.set(k, String(v));
    if (old !== String(v)) {
      const event = { key: k, oldValue: old, newValue: String(v) };
      storageListeners.forEach((fn) => fn(event));
    }
  },
  removeItem: (k) => storage.delete(k),
  clear: () => storage.clear()
};
globalThis.window = {
  addEventListener: (type, fn) => {
    if (type === 'storage') storageListeners.add(fn);
  },
  removeEventListener: (type, fn) => storageListeners.delete(fn)
};
globalThis.console = console;

async function loadModule(rel) {
  const entry = path.join(__dirname, '..', rel);
  const result = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    logLevel: 'silent',
    external: []
  });
  const code = result.outputFiles[0].text;
  const module = { exports: {} };
  const fn = new Function('module', 'exports', 'require', '__dirname', code);
  fn(module, module.exports, require, __dirname);
  return module.exports;
}

(async () => {
  const server = await loadModule('src/review/server.ts');
  const rules = await loadModule('src/review/rules.ts');
  const merge = await loadModule('src/review/merge.ts');
  let passed = 0;
  const ok = (name, cond) => {
    assert.ok(cond, name);
    console.log(`  ✓ ${name}`);
    passed += 1;
  };

  // 场景 0：干净初始化
  storage.clear();
  let init = server.initServer();
  assert.strictEqual(storage.has('yy58-lift-plan-draft'), false);
  ok('初始化后所有步骤带版本号 V1', init.state.steps.every((s) => s.version === 1));
  ok('初始状态未锁定', init.state.plan.locked === false);
  ok('初始存在总包会签且有效', init.state.signoffs.find((s) => s.role === '总包').valid === true);

  // 场景 1：旧稿无版本号 → 升级并保留原数据
  storage.clear();
  const legacy = {
    steps: [
      { id: 'S-01', title: '旧稿步骤', time: '07:30', loadRate: 95, clearance: 1.0, wind: 3, radius: 18, boom: 42, status: 'blocked', note: '旧数据' },
      { id: 'S-02', title: '旧稿步骤2', time: '08:00', loadRate: 10, clearance: 3, wind: 3, radius: 18, boom: 42, status: 'passed', note: '' }
    ],
    comments: [{ id: 'C-9', author: '张三', role: '安全', content: '旧评论', status: 'open', stepId: 'S-01' }],
    selectedStepId: 'S-01',
    revision: 7,
    locked: false,
    viewBookmarks: ['主吊全景'],
    activeBookmark: '主吊全景'
  };
  storage.set('yy58-lift-plan-draft', JSON.stringify(legacy));
  init = server.initServer();
  ok('旧稿升级 revision 保留为 7', init.state.plan.revision === 7);
  ok('旧稿步骤数据完整保留', init.state.steps.find((s) => s.id === 'S-01').note === '旧数据');
  ok('旧稿对象全部标记 V1', init.state.steps.every((s) => s.version === 1));
  ok('旧稿评论保留', init.state.comments.find((c) => c.id === 'C-9').content === '旧评论');
  ok('旧稿冲突项自动建 V1 复核记录', init.state.conflictReviews.some((c) => c.id === 'S-01:loadRate' && c.decision === 'pending'));
  ok('旧稿原件已备份', storage.has('yy58-lift-plan-draft-migrated-backup'));
  ok('迁移通知已生成', init.migrated && init.migrated.objectCount >= 3);
  assert.deepStrictEqual(JSON.parse(storage.get('yy58-lift-plan-draft-migrated-backup')), legacy);
  ok('备份与旧稿原件逐字节一致', true);

  // 回到干净环境做并发场景
  storage.clear();
  server.initServer();
  const site = { name: '王工', role: '现场' };
  const equip = { name: '刘明', role: '设备' };
  const safety = { name: '周工', role: '安全' };

  // 场景 2：现场先取批次号
  const b1 = server.startBatch(site);
  const stateAtStart = server.getState();
  const baseline = server.captureBaseline(stateAtStart);
  const s02Base = baseline['step:S-02'];
  ok('取到批次号', /^RB-\d+$/.test(b1.id));
  ok('基线记录版本号', s02Base.version === 1);

  // 场景 3：设备方在另一标签页先保存了 S-02 净空参数
  const bEquip = server.startBatch(equip);
  const equipState = server.getState();
  const equipChange = {
    type: 'step',
    id: 'S-02',
    baseVersion: equipState.steps.find((s) => s.id === 'S-02').version,
    insert: false,
    payload: { ...equipState.steps.find((s) => s.id === 'S-02'), clearance: 2.0, note: '设备已迁移配电箱，净空恢复' }
  };
  const equipRes = server.commitBatch(bEquip.id, [equipChange], {}, equip);
  ok('设备批次提交成功', equipRes.ok === true);
  ok('提交后版本号递增 V2', server.getState().steps.find((s) => s.id === 'S-02').version === 2);
  server.closeBatch(bEquip.id);

  // 安全会签在设备改参数前签署（模拟已有安全会签）
  const bSafety = server.startBatch(safety);
  const safetySign = {
    type: 'signoff',
    id: 'SO-安全',
    baseVersion: 0,
    insert: true,
    payload: { id: 'SO-安全', role: '安全', name: '周工', signedAt: new Date().toISOString(), covers: '', valid: true, invalidReason: '' }
  };
  let safetyRes = server.commitBatch(bSafety.id, [safetySign], {}, safety);
  ok('安全会签提交成功', safetyRes.ok === true);
  server.closeBatch(bSafety.id);

  // 场景 4：现场批次（基线 V1）再提交 → 整批退回，不产生部分写入
  const siteChange = {
    type: 'step',
    id: 'S-02',
    baseVersion: 1,
    insert: false,
    payload: { ...s02Base.snapshot, status: 'passed', note: '现场确认通过' }
  };
  // 再加一条无冲突的评论，验证整批原子退回
  const commentChange = {
    type: 'comment',
    id: 'C-99',
    baseVersion: 0,
    insert: true,
    payload: { id: 'C-99', author: '王工', role: '现场', content: '现场补充意见', status: 'open', stepId: 'S-02' }
  };
  const rejected = server.commitBatch(b1.id, [siteChange, commentChange], {}, site);
  ok('基线过期 → 整批退回', rejected.ok === false);
  ok('退回清单含过期对象', rejected.conflicts.length === 1 && rejected.conflicts[0].id === 'S-02');
  ok('退回时无部分写入（评论未插入）', !server.getState().comments.some((c) => c.id === 'C-99'));

  // 场景 5a：保留本方
  let res = server.commitBatch(b1.id, [siteChange, commentChange], { 'step:S-02': { strategy: 'mine' } }, site);
  ok('保留本方后提交成功', res.ok === true);
  let s02 = server.getState().steps.find((s) => s.id === 'S-02');
  ok('保留本方：现场说明覆盖设备说明', s02.note === '现场确认通过');
  ok('保留本方：设备净空被本方值覆盖 (1.2)', s02.clearance === 1.2);
  ok('保留本方：版本在 V2 基础上递增 V3', s02.version === 3);

  // 重置到退回点，重测 5b：保留对方（用新批次模拟：把 S-02 改回 V2 值，再让设备方改一次）
  storage.delete('yy58-server-state-v2');
  server.initServer();
  let st = server.getState();
  // 复现：设备 V2
  let be = server.startBatch(equip);
  st = server.getState();
  const equipPayload = { ...st.steps.find((s) => s.id === 'S-02'), clearance: 2.0, note: '设备已迁移配电箱' };
  server.commitBatch(be.id, [{ type: 'step', id: 'S-02', baseVersion: 1, insert: false, payload: equipPayload }], {}, equip);
  server.closeBatch(be.id);
  // 现场 V1 批次退回后选择 theirs
  let bs = server.startBatch(site);
  const sitePayload = { ...server.captureBaseline(server.getState())['step:S-02'].snapshot, status: 'passed', note: '现场确认' };
  // 用旧基线 1 构造冲突
  const rej2 = server.commitBatch(bs.id, [{ type: 'step', id: 'S-02', baseVersion: 1, insert: false, payload: sitePayload }], {}, site);
  ok('场景重置后仍能退回', rej2.ok === false);
  res = server.commitBatch(bs.id, [{ type: 'step', id: 'S-02', baseVersion: 1, insert: false, payload: sitePayload }], { 'step:S-02': { strategy: 'theirs' } }, site);
  ok('保留对方后提交成功', res.ok === true);
  s02 = server.getState().steps.find((s) => s.id === 'S-02');
  ok('保留对方：净空取设备值 2.0', s02.clearance === 2.0);
  ok('保留对方：说明取设备值', s02.note === '设备已迁移配电箱');
  server.closeBatch(bs.id);

  // 场景 5c：保留双方（安全保守合并）
  storage.delete('yy58-server-state-v2');
  server.initServer();
  be = server.startBatch(equip);
  st = server.getState();
  const eqPayload = { ...st.steps.find((s) => s.id === 'S-05'), clearance: 1.4, note: '设备补路基板' };
  server.commitBatch(be.id, [{ type: 'step', id: 'S-05', baseVersion: 1, insert: false, payload: eqPayload }], {}, equip);
  server.closeBatch(be.id);
  bs = server.startBatch(site);
  const sitePayload5 = { ...server.captureBaseline(server.getState())['step:S-05'].snapshot, loadRate: 95, note: '现场观察沉降' };
  res = server.commitBatch(bs.id, [{ type: 'step', id: 'S-05', baseVersion: 1, insert: false, payload: sitePayload5 }], { 'step:S-05': { strategy: 'both' } }, site);
  ok('保留双方提交成功', res.ok === true);
  s02 = server.getState().steps.find((s) => s.id === 'S-05');
  ok('保留双方：双方修改的字段都保留（荷载率取本方 95）', s02.loadRate === 95);
  ok('保留双方：设备净空修改也保留 1.4', s02.clearance === 1.4);
  ok('保留双方：文本双稿拼接且署名', s02.note.includes('设备') && s02.note.includes('现场'));

  // 场景 5d：按字段合并
  const merged = merge.mergeByFields(
    'step',
    { loadRate: 50, clearance: 1.0, note: 'A' },
    { loadRate: 80, clearance: 2.0, note: 'B' },
    { loadRate: 'mine', clearance: 'theirs', note: 'mine' }
  );
  ok('按字段合并：荷载率取本方 50', merged.loadRate === 50);
  ok('按字段合并：净空取对方 2.0', merged.clearance === 2.0);
  ok('按字段合并：说明取本方 A', merged.note === 'A');

  // 场景 6：参数/评论更新后相关会签立即失效；发布锁立即失效
  storage.delete('yy58-server-state-v2');
  server.initServer();
  st = server.getState();
  // 先处理掉冲突与开放意见
  const bx0 = server.startBatch({ name: '赵磊', role: '方案' });
  st = server.getState();
  const changes0 = [];
  for (const review of st.conflictReviews) {
    changes0.push({ type: 'conflict', id: review.id, baseVersion: review.version, insert: false, payload: { ...review, decision: 'mitigated', conclusion: '已采取缓解措施', decidedBy: '赵磊' } });
  }
  for (const comment of st.comments.filter((c) => c.status === 'open')) {
    changes0.push({ type: 'comment', id: comment.id, baseVersion: comment.version, insert: false, payload: { ...comment, status: 'resolved' } });
  }
  const resolvedAll0 = server.commitBatch(bx0.id, changes0, {}, { name: '赵磊', role: '方案' });
  ok('集中处理冲突/评论提交成功', resolvedAll0.ok === true);
  server.closeBatch(bx0.id);
  // 四方在最终数据上全部有效会签
  for (const actor of [
    { name: '陈晓', role: '总包' },
    { name: '刘明', role: '设备' },
    { name: '周工', role: '安全' },
    { name: '赵磊', role: '方案' }
  ]) {
    st = server.getState();
    const bx = server.startBatch(actor);
    const role = actor.role;
    const existing = st.signoffs.find((s) => s.role === role);
    const payload = { id: `SO-${role}`, role, name: actor.name, signedAt: new Date().toISOString(), covers: '', valid: true, invalidReason: '' };
    server.commitBatch(
      bx.id,
      [{ type: 'signoff', id: `SO-${role}`, baseVersion: existing ? existing.version : 0, insert: !existing, payload }],
      {},
      actor
    );
    server.closeBatch(bx.id);
  }
  let blockers = rules.releaseBlockers(server.getState());
  ok('门禁条件全满足', blockers.length === 0);
  const lockRes = server.lockPlan({ name: '赵磊', role: '方案' });
  ok('锁定发布成功', lockRes.ok === true);
  ok('发布锁状态为锁定', server.getState().plan.locked === true);

  // 设备改一个参数
  const b2 = server.startBatch(equip);
  st = server.getState();
  const changedStep = { ...st.steps.find((s) => s.id === 'S-03'), loadRate: 88, radius: 25 };
  const commit2 = server.commitBatch(b2.id, [{ type: 'step', id: 'S-03', baseVersion: st.steps.find((s) => s.id === 'S-03').version, insert: false, payload: changedStep }], {}, equip);
  ok('锁定后新修改提交成功', commit2.ok === true);
  ok('发布锁立即失效', commit2.lockInvalidated === true);
  ok('plan.locked 已翻回 false', server.getState().plan.locked === false);
  const invalidRoles = (commit2.invalidated || []).map((i) => i.role);
  ok('设备/方案会签因荷载率+半径更新失效', invalidRoles.includes('设备') && invalidRoles.includes('方案'));
  ok('安全会签不受设备参数影响（净空/风速未动）', !invalidRoles.includes('安全'));
  ok('总包会签不受影响（工序字段未动）', !invalidRoles.includes('总包'));
  const deviceSign = server.getState().signoffs.find((s) => s.role === '设备');
  ok('失效会签标记 valid=false', deviceSign.valid === false);
  blockers = rules.releaseBlockers(server.getState());
  ok('失效会签阻止门禁放行', blockers.some((b) => b.includes('设备角色会签已失效')));
  const lockFail = server.lockPlan(equip);
  ok('失效会签存在时锁定被拒绝', lockFail.ok === false);

  // 重新会签后又可以放行
  st = server.getState();
  const b3 = server.startBatch(equip);
  const reSign = { id: 'SO-设备', role: '设备', name: '刘明', signedAt: new Date().toISOString(), covers: '', valid: true, invalidReason: '' };
  const b3state = server.getState();
  const baseSign = b3state.signoffs.find((s) => s.role === '设备');
  const c3 = server.commitBatch(b3.id, [{ type: 'signoff', id: 'SO-设备', baseVersion: baseSign.version, insert: false, payload: reSign }], {}, equip);
  ok('重新会签提交成功', c3.ok === true);
  ok('重新会签恢复 valid=true', server.getState().signoffs.find((s) => s.role === '设备').valid === true);
  const fang = { name: '赵磊', role: '方案' };
  const b4 = server.startBatch(fang);
  const st4 = server.getState();
  const baseFang = st4.signoffs.find((s) => s.role === '方案');
  server.commitBatch(b4.id, [{ type: 'signoff', id: 'SO-方案', baseVersion: baseFang.version, insert: false, payload: { id: 'SO-方案', role: '方案', name: '赵磊', signedAt: new Date().toISOString(), covers: '', valid: true, invalidReason: '' } }], {}, fang);
  server.closeBatch(b4.id);
  blockers = rules.releaseBlockers(server.getState());
  ok('重签后门禁恢复可通过', blockers.length === 0);

  // 场景 7：断网取号失败、离线提交暂存、恢复后可重提
  storage.delete('yy58-server-state-v2');
  server.initServer();
  server.setOffline(true);
  let threw = false;
  try {
    server.startBatch(site);
  } catch (e) {
    threw = e instanceof server.NetworkError;
  }
  ok('断网时取批次号报 NetworkError', threw);
  server.setOffline(false);
  const bo = server.startBatch(site);
  ok('联网后取号成功', bo.id.startsWith('RB-'));
  server.setOffline(true);
  threw = false;
  try {
    server.commitBatch(bo.id, [], {}, site);
  } catch (e) {
    threw = e instanceof server.NetworkError;
  }
  ok('断网提交抛 NetworkError（客户端据此本地暂存批次）', threw);
  server.setOffline(false);
  const offlineRecovered = server.commitBatch(bo.id, [], {}, site);
  ok('恢复网络后同批次可提交', offlineRecovered.ok === true);

  // 场景 8：评论更新级联失效安全/总包，不影响设备
  storage.delete('yy58-server-state-v2');
  server.initServer();
  st = server.getState();
  let bx2 = server.startBatch(safety);
  server.commitBatch(bx2.id, [{ type: 'signoff', id: 'SO-安全', baseVersion: 0, insert: true, payload: { id: 'SO-安全', role: '安全', name: '周工', signedAt: new Date().toISOString(), covers: '', valid: true, invalidReason: '' } }], {}, safety);
  server.closeBatch(bx2.id);
  const be2 = server.startBatch(equip);
  const st2 = server.getState();
  const comment = st2.comments.find((c) => c.id === 'C-13');
  const commentCommit = server.commitBatch(be2.id, [{ type: 'comment', id: 'C-13', baseVersion: comment.version, insert: false, payload: { ...comment, status: 'open', content: comment.content + '（重新打开讨论）' } }], {}, equip);
  ok('评论更新提交成功', commentCommit.ok === true);
  ok('评论更新使安全会签失效', (commentCommit.invalidated || []).some((i) => i.role === '安全'));
  ok('评论更新不影响（无会签的）设备角色', !(commentCommit.invalidated || []).some((i) => i.role === '设备'));

  // 场景 9：冲突结论按版本化对象参与并发（同一冲突两人给结论 → 退回）
  storage.delete('yy58-server-state-v2');
  server.initServer();
  const a1 = server.startBatch(safety);
  const a2 = server.startBatch(equip);
  const stA = server.getState();
  const review = stA.conflictReviews.find((r) => r.id === 'S-02:clearance');
  const safetyDecision = server.commitBatch(a1.id, [{ type: 'conflict', id: review.id, baseVersion: 1, insert: false, payload: { ...review, decision: 'mitigated', conclusion: '安全要求迁移配电箱', decidedBy: '周工' } }], {}, safety);
  ok('安全先提交冲突结论成功', safetyDecision.ok === true);
  const equipDecision = server.commitBatch(a2.id, [{ type: 'conflict', id: review.id, baseVersion: 1, insert: false, payload: { ...review, decision: 'false-alarm', conclusion: '设备认为净空计算有误', decidedBy: '刘明' } }], {}, equip);
  ok('设备同基线再提交冲突结论被整批退回', equipDecision.ok === false && equipDecision.conflicts[0].type === 'conflict');

  console.log(`\n全部 ${passed} 项断言通过。`);
})().catch((error) => {
  console.error('验证失败：', error);
  process.exit(1);
});

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import * as THREE from 'three';
import { useLiftStore } from './store';
import { FIELD_LABELS, STEP_STATUS_LABELS, CONFLICT_DECISION_LABELS } from './review/types';
import type { LiftStep, MergeStrategy, SignRole, StepStatus, ConflictDecision, ServerConflictReview } from './review/types';

const route = useRoute();
const router = useRouter();
const store = useLiftStore();
const canvasRef = ref<HTMLCanvasElement | null>(null);
const sceneContainer = ref<HTMLElement | null>(null);
const commentText = ref('');
let renderer: THREE.WebGLRenderer | null = null;
let frame = 0;
let resizeObserver: ResizeObserver | null = null;
let theta = 0.8;
let phi = 0.9;
let dragging = false;
let previousX = 0;

const nav = [
  { path: '/', label: '三维复核', icon: 'view_in_ar' },
  { path: '/models', label: '模型与参数', icon: 'tune' },
  { path: '/checks', label: '冲突与评论', icon: 'rule' },
  { path: '/review', label: '多角色会签', icon: 'fact_check' }
];

const pageTitle = computed(() => nav.find((item) => item.path === route.path)?.label ?? '吊装工作台');
const inBatch = computed(() => store.inBatch);
const batchRejected = computed(() => store.batchRejected);
const canEdit = computed(() => store.inBatch && !store.batchRejected);
const selectedStep = computed(() => store.selectedStep);

type StepView = LiftStep & { version: number; updatedBy: string; staged: boolean };
/** 步骤参数的批次代理：表单改动写入本批暂存，不直接覆盖服务端对象 */
const stepProxy = computed<StepView>(() => (selectedStep.value as StepView) ?? ({} as StepView));

function patchStep(field: keyof LiftStep, value: unknown) {
  if (!selectedStep.value) return;
  store.stageStepPatch(selectedStep.value.id, { [field]: value } as Partial<LiftStep>);
}

function setStepStatus(value: StepStatus) {
  if (selectedStep.value) store.setStepStatus(selectedStep.value.id, value);
}

function conflictReview(conflictId: string): ServerConflictReview | undefined {
  return store.conflicts.find((item) => item.id === conflictId)?.review;
}

function patchConflict(conflictId: string, patch: Partial<Pick<ServerConflictReview, 'decision' | 'conclusion'>>) {
  const review = conflictReview(conflictId);
  if (!review) return;
  const nextDecision: ConflictDecision = patch.decision ?? review.decision;
  const nextConclusion = patch.conclusion ?? review.conclusion;
  if (nextDecision === 'pending' && !nextConclusion.trim()) {
    store.pushToast('请先填写冲突复核结论再保存到批次。', 'warning');
    return;
  }
  store.setConflictDecision(conflictId, nextDecision, nextConclusion, store.actor.name);
}

function submitComment() {
  if (!commentText.value.trim() || !selectedStep.value) return;
  if (store.addComment(commentText.value, selectedStep.value.id)) commentText.value = '';
}

function go(path: string) {
  router.push(path);
}

function severityLabel(severity: string) {
  return severity === 'high' ? '阻断' : '预警';
}

function decisionColor(decision: ConflictDecision | undefined) {
  if (decision === 'mitigated') return 'positive';
  if (decision === 'false-alarm') return 'info';
  return 'warning';
}

const strategyOptions: Array<{ value: MergeStrategy; label: string; hint: string }> = [
  { value: 'mine', label: '保留本方', hint: '以我的批次修改为准' },
  { value: 'theirs', label: '保留对方', hint: '采用他人已保存版本' },
  { value: 'both', label: '保留双方', hint: '参数取安全保守侧，文本双稿合并' },
  { value: 'fields', label: '按字段合并', hint: '每个差异字段单独选择' }
];

function conflictTypeLabel(type: string) {
  return type === 'step' ? '三维步骤' : type === 'comment' ? '评论' : type === 'conflict' ? '冲突项' : '会签';
}

function theirsUpdater(conflict: { theirs?: unknown; theirsUpdatedBy?: string }): string {
  const explicit = conflict.theirsUpdatedBy;
  if (explicit) return explicit;
  return ((conflict.theirs as { updatedBy?: string } | null)?.updatedBy) ?? '他人';
}

const selectedComments = computed(() =>
  store.comments.filter((comment) => comment.stepId === store.selectedStepId)
);

function fieldLabel(field: string) {
  return FIELD_LABELS[field] ?? field;
}

function displayValue(type: string, record: unknown, field: string): string {
  const obj = (record ?? {}) as Record<string, unknown>;
  const value = obj[field];
  if (value === undefined || value === null || value === '') return '—';
  if (field === 'status') return STEP_STATUS_LABELS[value as StepStatus] ?? String(value);
  if (field === 'decision') return CONFLICT_DECISION_LABELS[value as ConflictDecision] ?? String(value);
  return String(value);
}

function getStrategy(key: string): MergeStrategy | null {
  const conflict = store.batch?.conflicts.find((item) => item.key === key);
  return conflict?.resolution?.strategy ?? null;
}

function getFieldChoice(key: string, field: string): 'mine' | 'theirs' {
  const conflict = store.batch?.conflicts.find((item) => item.key === key);
  return conflict?.resolution?.fields?.[field] ?? 'mine';
}

function signCard(role: SignRole) {
  const meta = {
    总包: { name: '陈晓', team: '总包项目部', scope: store.scopeLabel('总包') },
    设备: { name: '刘明', team: '设备管理', scope: store.scopeLabel('设备') },
    安全: { name: '周工', team: '安全监督', scope: store.scopeLabel('安全') },
    方案: { name: '赵磊', team: '方案工程', scope: store.scopeLabel('方案') }
  }[role];
  const sign = store.signoffs.find((item) => item.role === role);
  const staged = store.stagedSignoffRoles.has(role);
  return { ...meta, role, sign, staged };
}

const signCards = computed(() => (['总包', '设备', '安全', '方案'] as SignRole[]).map(signCard));

function signState(card: ReturnType<typeof signCard>) {
  if (card.staged) return { label: '本批待提交', color: 'primary' };
  if (!card.sign) return { label: '待确认', color: 'grey' };
  if (card.sign.validNow) return { label: '会签有效', color: 'positive' };
  return { label: '已失效', color: 'negative' };
}

function doSign(role: SignRole, name: string) {
  if (!store.inBatch) {
    store.pushToast('请先取得复核批次号再会签；会签随批次提交后生效。', 'warning');
    return;
  }
  store.signAndMaybeLock(role, name);
}

const blockers = computed(() => store.releaseBlockers);
const drifted = computed(() => store.driftedObjects);

function initializeScene() {
  if (!canvasRef.value || !sceneContainer.value) return;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#dce6e1');
  scene.fog = new THREE.Fog('#dce6e1', 34, 78);

  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 160);
  renderer = new THREE.WebGLRenderer({ canvas: canvasRef.value, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  scene.add(new THREE.HemisphereLight('#eefaf5', '#273b34', 2.3));
  const sun = new THREE.DirectionalLight('#fff4d6', 3.2);
  sun.position.set(14, 28, 18);
  scene.add(sun);

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(60, 44),
    new THREE.MeshStandardMaterial({ color: '#b8c7bf', roughness: 0.95 })
  );
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);

  const grid = new THREE.GridHelper(60, 30, '#80948a', '#a8b8b0');
  grid.position.y = 0.02;
  scene.add(grid);

  const steel = new THREE.MeshStandardMaterial({ color: '#ec7a3c', roughness: 0.48, metalness: 0.35 });
  const darkSteel = new THREE.MeshStandardMaterial({ color: '#2d5c4f', roughness: 0.58, metalness: 0.42 });
  const truss = new THREE.Group();
  const chordGeometry = new THREE.BoxGeometry(18, 1.1, 1.1);
  for (const z of [-3.5, 3.5]) {
    for (const y of [4.2, 8.4]) {
      const chord = new THREE.Mesh(chordGeometry, steel);
      chord.position.set(0, y, z);
      truss.add(chord);
    }
  }
  for (let x = -8; x <= 8; x += 2) {
    const brace = new THREE.Mesh(new THREE.BoxGeometry(0.34, 4.8, 0.34), steel);
    brace.position.set(x, 6.2, -3.5);
    brace.rotation.z = x % 4 === 0 ? 0.36 : -0.36;
    truss.add(brace);
    const cross = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.3, 7), darkSteel);
    cross.position.set(x, 4.2, 0);
    truss.add(cross);
  }
  truss.position.set(0, 6.5, 2);
  scene.add(truss);

  const crane = new THREE.Group();
  const base = new THREE.Mesh(new THREE.BoxGeometry(7, 1.2, 5), darkSteel);
  base.position.y = 0.6;
  crane.add(base);
  const cabin = new THREE.Mesh(new THREE.BoxGeometry(3, 2.7, 3), new THREE.MeshStandardMaterial({ color: '#d8a733' }));
  cabin.position.set(-1, 2.5, 0);
  crane.add(cabin);
  const mast = new THREE.Mesh(new THREE.BoxGeometry(1.2, 24, 1.2), darkSteel);
  mast.position.y = 12;
  crane.add(mast);
  const boom = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 36), steel);
  boom.position.set(-8.5, 20.5, 9.5);
  boom.rotation.set(-0.38, 0.7, 0.14);
  crane.add(boom);
  crane.position.set(-15, 0, -12);
  scene.add(crane);

  const obstacleMat = new THREE.MeshStandardMaterial({ color: '#d34c45', transparent: true, opacity: 0.38 });
  const obstacle = new THREE.Mesh(new THREE.BoxGeometry(5, 5, 4), obstacleMat);
  obstacle.position.set(10, 2.5, 8);
  scene.add(obstacle);
  scene.add(new THREE.BoxHelper(obstacle, '#a92d2a'));

  const updateCamera = () => {
    const radius = 48;
    camera.position.set(
      Math.sin(theta) * Math.sin(phi) * radius,
      Math.cos(phi) * radius + 12,
      Math.cos(theta) * Math.sin(phi) * radius
    );
    camera.lookAt(0, 7, 0);
  };

  const render = () => {
    frame = requestAnimationFrame(render);
    truss.position.y = 6.5 + Math.sin(Date.now() / 900) * 0.08;
    updateCamera();
    renderer?.render(scene, camera);
  };
  render();

  const resize = () => {
    if (!sceneContainer.value || !renderer) return;
    const { width, height } = sceneContainer.value.getBoundingClientRect();
    renderer.setSize(width, height, false);
    camera.aspect = width / Math.max(height, 1);
    camera.updateProjectionMatrix();
  };
  resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(sceneContainer.value);
  resize();

  canvasRef.value.onpointerdown = (event) => {
    dragging = true;
    previousX = event.clientX;
    canvasRef.value?.setPointerCapture(event.pointerId);
  };
  canvasRef.value.onpointermove = (event) => {
    if (!dragging) return;
    theta += (event.clientX - previousX) * 0.006;
    previousX = event.clientX;
  };
  canvasRef.value.onpointerup = () => {
    dragging = false;
  };
}

onMounted(() => {
  store.initRealtime();
  nextTick(initializeScene);
});

onBeforeUnmount(() => {
  cancelAnimationFrame(frame);
  resizeObserver?.disconnect();
  renderer?.dispose();
});
</script>

<template>
  <q-layout view="hHh Lpr lFf" class="app-shell">
    <q-header elevated class="topbar">
      <q-toolbar>
        <div class="brand-mark">LIFT</div>
        <div class="brand-copy">
          <strong>大型构件吊装三维校核</strong>
          <span>东塔转换桁架 · 方案版本 V{{ store.revision }}</span>
        </div>
        <q-space />
        <q-btn-toggle
          :model-value="store.actor.role"
          spread
          flat
          dense
          no-caps
          toggle-color="primary"
          color="white"
          class="actor-switch"
          :options="store.actors.map((a) => ({ label: `${a.role}·${a.name}`, value: a.role }))"
          @update:model-value="(role: string) => { const a = store.actors.find((x) => x.role === role); if (a) store.setActor(a.name, a.role); }"
        />
        <q-btn
          flat
          dense
          no-caps
          :color="store.online ? 'light-green-3' : 'deep-orange-3'"
          :icon="store.online ? 'wifi' : 'cloud_off'"
          :label="store.online ? '在线' : '离线模拟'"
          @click="store.setOnlineMode(!store.online)"
        >
          <q-tooltip>点击模拟断网 / 恢复网络（跨标签页生效）</q-tooltip>
        </q-btn>
        <q-badge :color="store.locked ? 'teal' : 'orange'" outline class="status-badge">
          {{ store.locked ? '已锁定发布' : '会签中' }}
        </q-badge>
        <q-btn dense flat round icon="notifications" aria-label="通知">
          <q-badge floating color="red">{{ store.openComments.length }}</q-badge>
        </q-btn>
      </q-toolbar>
    </q-header>

    <q-drawer show-if-above side="left" :width="232" bordered class="left-nav">
      <div class="drawer-section-label">方案工作区</div>
      <q-list padding>
        <q-item
          v-for="item in nav"
          :key="item.path"
          clickable
          :active="route.path === item.path"
          active-class="nav-active"
          @click="go(item.path)"
        >
          <q-item-section avatar><q-icon :name="item.icon" /></q-item-section>
          <q-item-section>{{ item.label }}</q-item-section>
          <q-item-section v-if="item.path === '/checks'" side>
            <q-badge color="negative">{{ store.conflicts.length }}</q-badge>
          </q-item-section>
        </q-item>
      </q-list>
      <div class="draft-state">
        <q-icon :name="store.queued ? 'cloud_off' : inBatch ? 'edit_note' : 'cloud_done'" :color="store.queued ? 'deep-orange' : inBatch ? 'primary' : 'teal'" />
        <span v-if="store.queued">批次离线暂存<br /><small>联网后重新提交即可恢复</small></span>
        <span v-else-if="inBatch">复核批次 {{ store.batch?.id }}<br /><small>{{ batchRejected ? '已退回，待冲突处理' : '编辑中，提交前不落库' }}</small></span>
        <span v-else>当前查看服务端版本<br /><small>修改前请先取得批次号</small></span>
      </div>
    </q-drawer>

    <q-page-container>
      <q-page class="workspace-page">
        <!-- 旧稿升级提示 -->
        <q-banner v-if="store.migrationNotice" class="migration-banner" rounded>
          <template #avatar><q-icon name="upgrade" color="primary" /></template>
          旧稿（无版本号，原 V{{ store.migrationNotice.legacyRevision }}）已完成升级：{{ store.migrationNotice.objectCount }} 个对象统一标记为 V1，原始数据完整保留并备份在
          <code>{{ store.migrationNotice.backupKey }}</code>。
          <template #action>
            <q-btn flat dense no-caps label="知道了" @click="store.dismissMigration" />
          </template>
        </q-banner>

        <!-- 断网恢复提示 -->
        <q-banner v-if="store.restoredNotice" class="restore-banner" rounded>
          <template #avatar><q-icon name="restore" color="deep-orange" /></template>
          {{ store.restoredNotice }}
          <template #action>
            <q-btn flat dense no-caps label="继续复核" @click="store.dismissRestored" />
          </template>
        </q-banner>

        <!-- 发布锁被新提交冲掉 -->
        <q-banner v-if="store.server.plan.unlockNote" class="unlock-banner" rounded>
          <template #avatar><q-icon name="lock_open" color="negative" /></template>
          {{ store.server.plan.unlockNote }}
        </q-banner>

        <!-- 复核批次操作条 -->
        <section class="batch-bar content-panel">
          <div class="batch-main">
            <q-icon :name="inBatch ? 'fact_check' : 'queue'" :color="batchRejected ? 'negative' : 'primary'" size="26px" />
            <div>
              <strong>{{ inBatch ? `复核批次 ${store.batch?.id}` : '尚未取批次号' }}</strong>
              <span v-if="inBatch">
                {{ store.batch?.actor.role }} · {{ store.batch?.actor.name }} 发起 ·
                步骤 {{ store.batchSummary.steps }} / 评论 {{ store.batchSummary.comments }} / 冲突 {{ store.batchSummary.conflicts }} / 会签 {{ store.batchSummary.signoffs }}
                <q-badge v-if="store.queued" color="deep-orange" class="batch-flag">离线暂存</q-badge>
                <q-badge v-else-if="batchRejected" color="negative" class="batch-flag">已退回 {{ store.batch?.conflicts.length }} 项冲突</q-badge>
              </span>
              <span v-else>现场、设备、安全三方轮流复核时，修改前先取批次号，保存按基线版本整批校验。</span>
            </div>
          </div>
          <div class="batch-actions">
            <template v-if="!inBatch">
              <q-btn color="primary" no-caps icon="start" label="取得批次号并开始复核" @click="store.beginBatch" />
            </template>
            <template v-else>
              <q-btn
                :color="batchRejected ? 'negative' : 'primary'"
                no-caps
                :icon="store.queued ? 'cloud_sync' : 'upload_file'"
                :label="batchRejected ? `处理完冲突并重提（${store.resolvedCount()}/${store.batch?.conflicts.length}）` : '提交整批复核'"
                @click="store.submitBatch"
              />
              <q-btn outline no-caps icon="cancel" label="放弃批次" @click="store.cancelBatch" />
            </template>
          </div>
        </section>

        <!-- 基线漂移预警：取号后别人已改，提前可见 -->
        <q-banner v-if="inBatch && !batchRejected && drifted.length" class="drift-banner" rounded>
          <template #avatar><q-icon name="warning" color="warning" /></template>
          取号后已有 {{ drifted.length }} 个对象被他人修改，现在提交将整批退回：
          <strong v-for="item in drifted" :key="item.key" class="drift-chip">{{ item.id }}（{{ item.updatedBy }}）</strong>
        </q-banner>

        <!-- 整批退回的冲突清单与三种处理 -->
        <section v-if="batchRejected" class="conflict-board content-panel">
          <div class="conflict-board-head">
            <div>
              <span class="panel-kicker">BATCH REJECTED</span>
              <h2>整批退回 · 冲突处理清单</h2>
            </div>
            <q-badge color="negative">{{ store.batch?.conflicts.length }} 个对象需处理</q-badge>
          </div>
          <div v-for="conflict in store.batch?.conflicts" :key="conflict.key" class="reject-row">
            <div class="reject-title">
              <q-badge color="grey-7">{{ conflictTypeLabel(conflict.type) }}</q-badge>
              <strong>{{ conflict.id }}</strong>
              <small>对方最后保存：{{ theirsUpdater(conflict) }}</small>
            </div>
            <div class="field-diff">
              <div class="diff-col">
                <span>本方修改</span>
                <p v-for="field in conflict.changedFields" :key="field">
                  <em>{{ fieldLabel(field) }}</em>：{{ displayValue(conflict.type, conflict.mine, field) }}
                </p>
              </div>
              <q-icon name="compare_arrows" color="grey" size="22px" />
              <div class="diff-col theirs">
                <span>他人已保存版本</span>
                <p v-for="field in conflict.changedFields" :key="field">
                  <em>{{ fieldLabel(field) }}</em>：{{ displayValue(conflict.type, conflict.theirs, field) }}
                </p>
              </div>
            </div>
            <div class="resolve-options">
              <q-btn-toggle
                :model-value="getStrategy(conflict.key)"
                spread
                no-caps
                toggle-color="primary"
                :options="strategyOptions.map((s) => ({ label: s.label, value: s.value }))"
                @update:model-value="(value: MergeStrategy) => store.setConflictStrategy(conflict.key, value)"
              />
              <small>{{ strategyOptions.find((s) => s.value === getStrategy(conflict.key))?.hint ?? '请选择处理方式' }}</small>
              <div v-if="getStrategy(conflict.key) === 'fields'" class="field-merge">
                <div v-for="field in conflict.changedFields" :key="field" class="field-merge-row">
                  <em>{{ fieldLabel(field) }}</em>
                  <q-btn-toggle
                    :model-value="getFieldChoice(conflict.key, field)"
                    dense
                    no-caps
                    toggle-color="primary"
                    :options="[
                      { label: `本方：${displayValue(conflict.type, conflict.mine, field)}`, value: 'mine' },
                      { label: `对方：${displayValue(conflict.type, conflict.theirs, field)}`, value: 'theirs' }
                    ]"
                    @update:model-value="(side: 'mine' | 'theirs') => store.setFieldChoice(conflict.key, field, side)"
                  />
                </div>
              </div>
            </div>
          </div>
        </section>

        <header class="page-heading">
          <div>
            <div class="eyebrow">LP-2026-0918 / {{ pageTitle }}</div>
            <h1>{{ pageTitle }}</h1>
          </div>
          <div class="heading-actions">
            <q-btn outline no-caps icon="ios_share" label="导出吊装指令" />
            <q-btn
              color="primary"
              no-caps
              icon="lock"
              :label="store.locked ? '版本已锁定' : '确认并锁定'"
              :disable="store.locked || blockers.length > 0"
              @click="store.lockPlan"
            />
          </div>
        </header>

        <section v-if="route.path === '/' || route.path === '/models'" class="work-grid">
          <article class="scene-panel content-panel">
            <div class="panel-heading">
              <div>
                <span class="panel-kicker">THREE.JS SCENE</span>
                <h2>吊装姿态与空间冲突</h2>
              </div>
              <div class="view-bookmarks">
                <button
                  v-for="bookmark in store.viewBookmarks"
                  :key="bookmark"
                  :class="{ active: store.activeBookmark === bookmark }"
                  @click="store.setBookmark(bookmark)"
                >
                  {{ bookmark }}
                </button>
              </div>
            </div>
            <div ref="sceneContainer" class="scene-container">
              <canvas ref="canvasRef" aria-label="吊装三维场景" />
              <div class="scene-legend">
                <span><i class="legend-dot crane" />主吊</span>
                <span><i class="legend-dot load" />构件</span>
                <span><i class="legend-dot risk" />障碍物</span>
              </div>
              <div class="scene-hint">拖动旋转视角 · 滚轮缩放由设备手势控制</div>
            </div>
            <div class="timeline">
              <button
                v-for="step in store.steps"
                :key="step.id"
                class="timeline-step"
                :class="[step.status, { selected: store.selectedStepId === step.id, staged: step.staged }]"
                @click="store.selectStep(step.id)"
              >
                <span>{{ step.time }} · V{{ step.version }}</span>
                <strong>{{ step.title }}</strong>
                <small>{{ step.loadRate }}% 荷载 · {{ step.clearance }}m 净空<span v-if="step.staged" class="staged-tag">本批已改</span></small>
              </button>
            </div>
          </article>

          <aside class="inspector-panel content-panel">
            <div class="panel-heading compact">
              <div>
                <span class="panel-kicker">STEP INSPECTOR</span>
                <h2>{{ stepProxy.id }} · {{ stepProxy.title }}</h2>
                <small class="version-line">基线 V{{ stepProxy.version }} · 最近保存 {{ stepProxy.updatedBy }}</small>
              </div>
              <q-badge v-if="!canEdit" :color="canEdit ? 'primary' : 'grey'" outline>{{ canEdit ? '批次编辑中' : '只读：先取批次号' }}</q-badge>
            </div>
            <div class="metric-grid">
              <div><span>荷载率</span><strong :class="{ danger: stepProxy.loadRate > 90 }">{{ stepProxy.loadRate }}%</strong></div>
              <div><span>最小净空</span><strong :class="{ danger: stepProxy.clearance < 1.5 }">{{ stepProxy.clearance }}m</strong></div>
              <div><span>作业半径</span><strong>{{ stepProxy.radius }}m</strong></div>
              <div><span>风速限制</span><strong>{{ stepProxy.wind }}m/s</strong></div>
            </div>
            <label class="field-label">荷载率</label>
            <q-slider
              :model-value="stepProxy.loadRate"
              :min="0"
              :max="120"
              color="primary"
              :disable="!canEdit"
              @update:model-value="(v: number | null) => patchStep('loadRate', v ?? 0)"
            />
            <div class="form-row">
              <q-input :model-value="stepProxy.clearance" type="number" label="最小净空 / m" outlined dense :disable="!canEdit" @update:model-value="(v) => patchStep('clearance', Number(v))" />
              <q-input :model-value="stepProxy.wind" type="number" label="风速 / m/s" outlined dense :disable="!canEdit" @update:model-value="(v) => patchStep('wind', Number(v))" />
            </div>
            <label class="field-label">步骤结论</label>
            <q-btn-toggle
              :model-value="stepProxy.status"
              spread
              no-caps
              toggle-color="primary"
              :disable="!canEdit"
              :options="[
                { label: '待复核', value: 'pending' },
                { label: '通过', value: 'passed' },
                { label: '阻断', value: 'blocked' }
              ]"
              @update:model-value="(v: StepStatus) => setStepStatus(v)"
            />
            <q-input
              :model-value="stepProxy.note"
              type="textarea"
              autogrow
              outlined
              label="现场控制说明"
              class="note-input"
              :disable="!canEdit"
              @update:model-value="(v) => patchStep('note', String(v ?? ''))"
            />
            <q-btn class="save-step" :color="canEdit ? 'primary' : 'grey'" no-caps icon="save" :label="selectedStep?.staged ? '已收入本批，提交时统一保存' : '收入复核批次'" :disable="!canEdit || !selectedStep?.staged" @click="store.pushToast('该步骤的改动已在批次暂存中，提交整批时统一保存。', 'info')" />
          </aside>
        </section>

        <section v-if="route.path === '/checks'" class="content-panel full-panel">
          <div class="panel-heading">
            <div>
              <span class="panel-kicker">RULE ENGINE</span>
              <h2>冲突定位与条件清单</h2>
            </div>
            <q-badge color="negative">{{ store.conflicts.length }} 项规则冲突</q-badge>
          </div>
          <div class="check-layout">
            <div class="conflict-list">
              <div v-for="item in store.conflicts" :key="item.id" class="conflict-block">
                <button class="conflict-item" @click="store.selectStep(item.stepId)">
                  <span class="severity" :class="item.severity">{{ severityLabel(item.severity) }}</span>
                  <div><strong>{{ item.stepId }} · {{ item.title }}</strong><small>{{ item.message }}</small></div>
                  <q-icon name="arrow_forward" />
                </button>
                <div class="conflict-review" :class="{ staged: item.staged }">
                  <div class="conflict-review-head">
                    <q-badge :color="decisionColor(item.review?.decision)" dense>
                      {{ item.review ? CONFLICT_DECISION_LABELS[item.review.decision] : '待处理' }}
                    </q-badge>
                    <q-badge v-if="item.staged" color="primary" dense outline>本批修改</q-badge>
                    <span v-if="item.review?.version" class="review-version">V{{ item.review.version }} · {{ item.review.updatedBy }}</span>
                  </div>
                  <q-input
                    :model-value="item.review?.conclusion ?? ''"
                    type="textarea"
                    autogrow
                    outlined
                    dense
                    label="冲突复核结论（缓解措施 / 误报依据）"
                    :disable="!canEdit"
                    @update:model-value="(v) => patchConflict(item.id, { conclusion: String(v ?? '') })"
                  />
                  <q-btn-toggle
                    :model-value="item.review?.decision ?? 'pending'"
                    spread
                    dense
                    no-caps
                    toggle-color="primary"
                    :disable="!canEdit"
                    :options="[
                      { label: '待处理', value: 'pending' },
                      { label: '已缓解', value: 'mitigated' },
                      { label: '误报排除', value: 'false-alarm' }
                    ]"
                    @update:model-value="(v: ConflictDecision) => patchConflict(item.id, { decision: v })"
                  />
                </div>
              </div>
              <div v-if="store.conflicts.length === 0" class="empty-state">当前版本未发现规则冲突。</div>
            </div>
            <div class="comments-panel">
              <h3>条件与评论 · {{ store.selectedStepId }}</h3>
              <div v-for="comment in selectedComments" :key="comment.clientId ?? comment.id" class="comment-row" :class="{ staged: comment.staged }">
                <div class="comment-avatar">{{ comment.author.slice(0, 1) }}</div>
                <div>
                  <strong>{{ comment.author }} <small>{{ comment.role }}</small>
                    <q-badge v-if="comment.isNew" color="primary" dense outline>本批新增</q-badge>
                    <q-badge v-else-if="comment.staged" color="primary" dense outline>本批修改</q-badge>
                    <q-badge v-else color="grey" dense outline>V{{ comment.version }}</q-badge>
                  </strong>
                  <p>{{ comment.content }}</p>
                  <button v-if="comment.status === 'open' && canEdit" @click="store.resolveComment(comment.id)">标记已解决（收入批次）</button>
                  <span v-else-if="comment.status === 'resolved'" class="resolved">已解决</span>
                </div>
              </div>
              <q-input v-model="commentText" type="textarea" outlined autogrow label="对该步骤提出条件或补充意见" :disable="!canEdit" />
              <q-btn color="primary" no-caps icon="send" :label="canEdit ? '提交意见（收入本批）' : '取批次号后可评论'" :disable="!canEdit" @click="submitComment" />
            </div>
          </div>
        </section>

        <section v-if="route.path === '/review'" class="content-panel full-panel">
          <div class="panel-heading">
            <div>
              <span class="panel-kicker">MULTI-PARTY SIGN-OFF</span>
              <h2>多角色会签与发布门禁</h2>
            </div>
            <div class="readiness"><strong>{{ store.readiness }}%</strong><span>发布就绪度</span></div>
          </div>
          <div class="review-grid">
            <article v-for="card in signCards" :key="card.role" class="review-card">
              <div class="review-head">
                <strong>{{ card.name }}</strong>
                <q-badge :color="signState(card).color">{{ signState(card).label }}</q-badge>
              </div>
              <span>{{ card.team }}</span>
              <p>{{ card.scope }}</p>
              <div v-if="card.sign && !card.sign.validNow && !card.staged" class="invalid-reason">
                <q-icon name="gpp_bad" color="negative" size="16px" />
                {{ card.sign.invalidReason || '管辖数据已更新，会签立即失效' }}
              </div>
              <div v-if="card.sign && card.sign.validNow" class="invalid-reason ok">
                <q-icon name="verified" color="positive" size="16px" />
                签署于 {{ new Date(card.sign.signedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) }}
              </div>
              <q-btn
                v-if="!card.staged"
                outline
                no-caps
                :label="card.sign ? '重新会签（随批提交）' : '会签（随批提交）'"
                @click="doSign(card.role, card.name)"
              />
              <q-btn v-else disable no-caps label="已在本批，待提交" />
            </article>
          </div>
          <div class="release-gate">
            <div>
              <q-icon name="verified_user" size="30px" />
              <div>
                <strong>发布前门禁</strong>
                <span v-if="blockers.length === 0">冲突清零、意见关闭、四方会签全部有效，可以锁定发布。</span>
                <span v-else class="blocker-list">
                  <q-badge v-for="(blocker, index) in blockers.slice(0, 3)" :key="index" color="deep-orange" class="blocker-badge">{{ blocker }}</q-badge>
                  <template v-if="!store.inBatch">会签与修改都需要先取得批次号。</template>
                </span>
              </div>
            </div>
            <q-btn
              color="primary"
              no-caps
              icon="lock"
              :label="store.locked ? `已发布 V${store.revision}` : `锁定并发布 V${store.revision + 1}`"
              :disable="store.locked || blockers.length > 0"
              @click="store.lockPlan"
            />
          </div>
        </section>
      </q-page>
    </q-page-container>

    <!-- 全局通知 -->
    <div class="toast-stack">
      <transition-group name="toast">
        <div v-for="toast in store.toasts" :key="toast.id" class="toast-item" :class="toast.tone">
          <q-icon :name="toast.tone === 'positive' ? 'check_circle' : toast.tone === 'negative' ? 'error' : toast.tone === 'warning' ? 'warning' : 'info'" />
          <span>{{ toast.message }}</span>
        </div>
      </transition-group>
    </div>
  </q-layout>
</template>

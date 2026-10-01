<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from 'vue';
import { useLiftStore } from '../store';

const store = useLiftStore();
const dirty = computed(() => store.hasUnsavedChanges);

function confirmLeave(event: BeforeUnloadEvent) {
  if (store.hasUnsavedChanges) {
    event.preventDefault();
    event.returnValue = '';
  }
}

onMounted(() => window.addEventListener('beforeunload', confirmLeave));
onBeforeUnmount(() => window.removeEventListener('beforeunload', confirmLeave));
</script>

<template>
  <div class="batch-bar">
    <q-banner v-if="store.showUpgrade" rounded dense class="batch-banner upgrade">
      <template #avatar><q-icon name="upgrade" color="primary" /></template>
      <strong>旧稿升级完成</strong>：原草稿缺少版本号，已升级为带基线的复核批次，原始数据已备份保留。
      <template #action>
        <q-btn flat dense no-caps label="知道了" @click="store.dismissUpgrade" />
      </template>
    </q-banner>

    <q-banner v-if="store.showRecovery" rounded dense class="batch-banner recovery">
      <template #avatar><q-icon name="history" color="primary" /></template>
      <strong>检测到未完成批次</strong>：上次关闭页面时有未保存的复核批次，修改内容已暂存在本机。
      <template #action>
        <q-btn flat dense no-caps color="primary" label="恢复批次" @click="store.recoverBatch" />
        <q-btn flat dense no-caps label="丢弃" @click="store.discardRecovery" />
      </template>
    </q-banner>

    <q-banner v-if="store.batch?.offline" rounded dense class="batch-banner offline">
      <template #avatar><q-icon name="cloud_off" color="warning" /></template>
      <strong>网络已断开</strong>：本批次修改将暂存在本机，恢复联网后自动保存并比对基线。
    </q-banner>

    <q-banner v-if="store.remoteDirty && !store.batch?.offline" rounded dense class="batch-banner remote">
      <template #avatar><q-icon name="sync" color="secondary" /></template>
      <strong>其他标签页已提交新版本</strong>：保存时将逐对象比对基线，冲突项会退回冲突清单。
    </q-banner>

    <div class="batch-toolbar">
      <div class="batch-status">
        <q-icon :name="store.batch ? 'layers' : 'layers_clear'" :color="store.batch ? 'primary' : 'grey'" />
        <template v-if="store.batch">
          <strong>{{ store.batchLabel }}</strong>
          <span class="batch-meta">基线 V{{ store.batch.baseline.revision }} · {{ new Date(store.batch.acquiredAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) }} 取号</span>
          <q-banner v-if="dirty" dense rounded class="dirty-dot">有未保存修改</q-banner>
        </template>
        <span v-else class="batch-meta">修改前请先取批次号，保存时按基线比对</span>
      </div>
      <div class="batch-actions">
        <q-btn
          v-if="store.batch"
          flat
          no-caps
          icon="close"
          label="放弃批次"
          :disable="!dirty"
          @click="store.discardBatch"
        />
        <q-btn outline no-caps icon="add" label="取批次号" @click="store.acquireBatch" />
        <q-btn
          color="primary"
          no-caps
          icon="save"
          :label="dirty ? '保存批次（有修改）' : '保存批次'"
          @click="store.saveBatch"
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
.batch-bar { margin-bottom: 16px; display: flex; flex-direction: column; gap: 8px; }
.batch-banner { border: 1px solid var(--line); border-radius: 8px; background: #fff; }
.batch-banner.upgrade { border-left: 3px solid var(--accent); }
.batch-banner.recovery { border-left: 3px solid #2b6cb0; }
.batch-banner.offline { border-left: 3px solid var(--warning); }
.batch-banner.remote { border-left: 3px solid #2b6cb0; }
.batch-toolbar {
  display: flex; justify-content: space-between; align-items: center; gap: 12px;
  background: #fff; border: 1px solid var(--line); border-radius: 8px; padding: 10px 14px;
}
.batch-status { display: flex; align-items: center; gap: 10px; font-size: 13px; }
.batch-meta { color: #75867f; font-size: 12px; }
.batch-actions { display: flex; gap: 8px; }
.dirty-dot { padding: 2px 8px; font-size: 11px; min-height: 0; background: #fff0db; color: #995b14; border-radius: 4px; }
</style>

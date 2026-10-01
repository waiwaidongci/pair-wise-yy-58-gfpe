<script setup lang="ts">
import { computed } from 'vue';
import { useLiftStore } from '../store';

const store = useLiftStore();

const requirements = computed(() => [
  { label: '冲突清零', met: store.openFindings.length === 0 },
  { label: '意见全部关闭', met: store.openComments.length === 0 },
  { label: '四个角色完成会签', met: store.allSigned }
]);

const gateOpen = computed(() => requirements.value.every((item) => item.met));

function stateColor(state: string, valid: boolean) {
  if (state === 'accepted') return valid ? 'positive' : 'warning';
  if (state === 'reserved') return 'warning';
  return 'grey';
}

function stateLabel(state: string, valid: boolean) {
  if (state === 'accepted') return valid ? '已接受' : '已失效';
  if (state === 'reserved') return '有保留';
  return '待确认';
}
</script>

<template>
  <section class="content-panel full-panel">
    <div class="panel-heading">
      <div>
        <span class="panel-kicker">MULTI-PARTY SIGN-OFF</span>
        <h2>多角色会签与发布门禁</h2>
      </div>
      <div class="readiness"><strong>{{ store.readiness }}%</strong><span>发布就绪度</span></div>
    </div>

    <div class="review-grid">
      <article v-for="person in store.signoffs" :key="person.id" class="review-card" :class="{ invalid: person.state === 'accepted' && !person.valid }">
        <div class="review-head">
          <strong>{{ person.person }}</strong>
          <q-badge :color="stateColor(person.state, person.valid)">{{ stateLabel(person.state, person.valid) }}</q-badge>
        </div>
        <span>{{ person.role }} · {{ person.team }}</span>
        <p>{{ person.scope }}</p>
        <p v-if="person.state === 'accepted' && !person.valid" class="invalid-hint">
          步骤参数或评论已变更，原会签立即失效，需重新签署。
        </p>
        <p v-else-if="person.state === 'accepted' && person.signedAt" class="signed-at">
          签署于 {{ new Date(person.signedAt).toLocaleString('zh-CN', { hour12: false }) }} · 基线 V{{ person.basedOnRevision }}
        </p>
        <q-btn
          v-if="person.state !== 'accepted' || !person.valid"
          outline
          no-caps
          :label="person.state === 'accepted' ? '重新签署' : '接受方案'"
          @click="store.signoff(person.id)"
        />
        <q-btn v-else disable no-caps label="已签署" />
      </article>
    </div>

    <div class="release-gate">
      <div class="gate-requirements">
        <q-icon name="verified_user" size="30px" />
        <div>
          <strong>发布前门禁</strong>
          <span v-for="req in requirements" :key="req.label" class="req" :class="{ met: req.met }">
            <q-icon :name="req.met ? 'check_circle' : 'radio_button_unchecked'" size="14px" />
            {{ req.label }}
          </span>
        </div>
      </div>
      <q-btn
        v-if="store.lock.locked"
        color="teal"
        no-caps
        icon="lock"
        :label="`已锁定发布 V${store.lock.revision}`"
        disable
      />
      <q-btn
        v-else
        color="primary"
        no-caps
        icon="lock"
        label="锁定并发布"
        :disable="!gateOpen"
        @click="store.lockPlan"
      />
    </div>
  </section>
</template>

<style scoped>
.review-card.invalid { border-color: var(--warning); background: #fdf6ec; }
.invalid-hint { color: #995b14; font-size: 12px; margin: 0 0 10px; }
.signed-at { color: #2b8a69; font-size: 11px; margin: 0 0 10px; }
.gate-requirements { display: flex; align-items: center; gap: 10px; }
.req { display: inline-flex; align-items: center; gap: 4px; margin-right: 12px; color: #b4d2c8; font-size: 11px; }
.req.met { color: #7fd6b8; }
.release-gate .q-btn { white-space: nowrap; }
</style>

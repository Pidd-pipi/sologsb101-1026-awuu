<script setup lang="ts">
/** /operations 倒罐与压帽作业编排：按日期排序、拖拽调序、指派操作人；倒罐按罐容量真正搬酒 */
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { liveQuery } from 'dexie'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus'
import { Plus, Rank } from '@element-plus/icons-vue'
import FilterBar from '@/components/common/FilterBar.vue'
import StageTag from '@/components/common/StageTag.vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import {
  db,
  getRackVersion,
  occupiedVolumeOfTank,
  batchVolumeInTank,
  type BatchRow,
  type OperationRow,
  type ParcelRow,
  type RackingRow,
  type TankAllocationRow,
  type TankRow
} from '@/utils/db'
import { useIdbTable } from '@/hooks/useIdbTable'
import { useOperationStore } from '@/stores/operationStore'
import { OPERATION_STATES, OPERATION_TYPES, createEmptyOperation, type Operation } from '@/types/operation'
import { planRacking, type RackingPlan } from '@/utils/rackingPlan'
import { useRackingLock } from '@/utils/rackingLock'
import { today } from '@/utils/uuid'
import type { FilterSelectConfig, FilterModel } from '@/types/filter'
import { filtersToQuery } from '@/utils/query'

const route = useRoute()
const router = useRouter()
const store = useOperationStore()
const rackingLock = useRackingLock()

const { rows: operations, ready } = useIdbTable<OperationRow>(() => db.operations, {
  compare: (a, b) => a.seq - b.seq || a.date.localeCompare(b.date)
})
const { rows: batches } = useIdbTable<BatchRow>(() => db.batches)
const { rows: parcels } = useIdbTable<ParcelRow>(() => db.parcels)
const { rows: tanks } = useIdbTable<TankRow>(() => db.tanks)
const { rows: allocations } = useIdbTable<TankAllocationRow>(() => db.tankAllocations)
const { rows: rackings } = useIdbTable<RackingRow>(() => db.rackings, {
  compare: (a, b) => b.date.localeCompare(a.date) || b.createdAt - a.createdAt
})

/** 实时占用版本号：倒罐表单打开期间若变化，说明罐位被其它页面改动 */
const rackVersion = ref(0)
let versionUnsub: { unsubscribe: () => void } | null = null
const selects: FilterSelectConfig[] = [
  { key: 'types', label: '作业类型', options: OPERATION_TYPES.map((item) => ({ label: item, value: item })) },
  { key: 'states', label: '状态', options: OPERATION_STATES.map((item) => ({ label: item, value: item })) }
]

function parcelNameOf(batchId: string): string {
  const batch = batches.value.find((item) => item.id === batchId)
  if (!batch) return '批次已删除'
  const parcel = parcels.value.find((item) => item.id === batch.parcelId)
  return parcel ? parcel.name : '未知地块'
}

function batchLabel(batchId: string): string {
  const batch = batches.value.find((item) => item.id === batchId)
  if (!batch) return '批次已删除'
  return `${parcelNameOf(batchId)} · ${batch.harvestDate}`
}

function tankCode(tankId: string): string {
  if (!tankId) return '已释放'
  return tanks.value.find((item) => item.id === tankId)?.code ?? '未知罐'
}

const filtered = computed(() => {
  const keyword = String(store.filters.keyword ?? '').trim().toLowerCase()
  const types = Array.isArray(store.filters.types) ? store.filters.types : []
  const states = Array.isArray(store.filters.states) ? store.filters.states : []
  const scoped = store.currentBatchId
    ? operations.value.filter((item) => item.batchId === store.currentBatchId)
    : operations.value
  return scoped
    .filter((item) => {
      const label = `${item.type} ${item.operator} ${batchLabel(item.batchId)}`.toLowerCase()
      if (keyword && !label.includes(keyword)) return false
      if (types.length > 0 && !types.includes(item.type)) return false
      if (states.length > 0 && !states.includes(item.state)) return false
      return true
    })
    .sort((a, b) => a.seq - b.seq)
})

/** 作业关联的倒罐流水（如存在） */
const rackingByOperation = computed(() => {
  const map = new Map<string, RackingRow>()
  for (const row of rackings.value) map.set(row.operationId, row)
  return map
})

const summary = computed(() => ({
  total: filtered.value.length,
  planned: filtered.value.filter((item) => item.state === '计划').length,
  done: filtered.value.filter((item) => item.state === '已完成').length,
  totalMinutes: filtered.value.reduce((sum, item) => sum + item.durationMin, 0)
}))

/* ------------------------------ 拖拽调序 ------------------------------ */
const dragIndex = ref<number | null>(null)
const overIndex = ref<number | null>(null)

function onDragStart(index: number): void {
  dragIndex.value = index
}

function onDragOver(index: number): void {
  overIndex.value = index
}

async function onDrop(index: number): Promise<void> {
  const from = dragIndex.value
  dragIndex.value = null
  overIndex.value = null
  if (from === null || from === index) return
  await store.move(filtered.value, from, index)
  ElMessage.success('作业顺序已更新并写回本地库')
}

/** 上下移按钮：无鼠标拖拽时的等价操作 */
async function moveBy(index: number, offset: number): Promise<void> {
  await store.move(filtered.value, index, index + offset)
}

/* ------------------------------ 普通作业新增 / 编辑 ------------------------------ */
const dialogVisible = ref(false)
const editingId = ref<string | null>(null)
const formRef = ref<FormInstance>()
const form = reactive<Omit<Operation, 'id' | 'seq'>>(createEmptyOperation())

const rules: FormRules = {
  batchId: [{ required: true, message: '请选择批次', trigger: 'change' }],
  operator: [{ required: true, message: '请填写操作人', trigger: 'blur' }]
}

function openCreate(): void {
  editingId.value = null
  Object.assign(form, createEmptyOperation())
  if (store.currentBatchId) form.batchId = store.currentBatchId
  dialogVisible.value = true
}

function openEdit(row: OperationRow): void {
  editingId.value = row.id
  Object.assign(form, {
    batchId: row.batchId,
    type: row.type,
    date: row.date,
    durationMin: row.durationMin,
    operator: row.operator,
    state: row.state
  })
  dialogVisible.value = true
}

async function submit(): Promise<void> {
  const valid = await formRef.value?.validate().catch(() => false)
  if (!valid) return
  try {
    if (editingId.value) {
      await store.updateOperation(editingId.value, { ...form })
      ElMessage.success('作业已更新')
    } else {
      await store.createOperation({ ...form })
      ElMessage.success('作业已排入队列')
    }
    dialogVisible.value = false
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '保存失败')
  }
}

async function finish(row: OperationRow): Promise<void> {
  await store.finish(row.id)
  ElMessage.success('作业已完成，批次最近作业时间已回写')
}

async function remove(row: OperationRow): Promise<void> {
  try {
    await ElMessageBox.confirm(`确认删除 ${row.date} 的「${row.type}」作业？`, '删除确认', { type: 'warning' })
  } catch {
    return
  }
  await store.deleteOperation(row.id)
  ElMessage.success('作业已删除')
}

/* ------------------------------ 倒罐（搬酒） ------------------------------ */
const rackingVisible = ref(false)
const rackingSubmitting = ref(false)
const rackingFormRef = ref<FormInstance>()
const rackingForm = reactive({
  batchId: '',
  fromTankId: '',
  targetTankIds: [] as string[],
  plannedVolumeL: 500,
  date: today(),
  durationMin: 45,
  operator: ''
})
/** 打开表单时的占用版本号 */
const expectedRackVersion = ref(0)
/** 版本号在表单打开期间被推进过（其它页面先提交） */
const versionStale = ref(false)

const rackingRules: FormRules = {
  batchId: [{ required: true, message: '请选择批次', trigger: 'change' }],
  fromTankId: [{ required: true, message: '请选择倒出罐', trigger: 'change' }],
  plannedVolumeL: [{ required: true, message: '请填写倒罐量', trigger: 'blur' }],
  operator: [{ required: true, message: '请填写操作人', trigger: 'blur' }]
}

const activeBatches = computed(() => batches.value.filter((batch) => batch.state !== '已出罐'))

/** 当前选中批次的分罐行 */
const batchAllocations = computed(() =>
  allocations.value.filter((item) => item.batchId === rackingForm.batchId)
)

/** 该批次当前可倒出的罐（在该罐确有分酒） */
const sourceTanks = computed(() =>
  batchAllocations.value
    .map((alloc) => ({
      alloc,
      tank: tanks.value.find((item) => item.id === alloc.tankId)
    }))
    .filter((item) => !!item.tank)
)

/** 可选目标罐：非倒出罐、非清洗、无其它批次占用 */
const targetOptions = computed(() => {
  const ownBatchId = rackingForm.batchId
  return tanks.value
    .filter((tank) => tank.id !== rackingForm.fromTankId && tank.state !== '清洗中')
    .map((tank) => {
      const own = batchVolumeInTank(ownBatchId, tank.id, allocations.value)
      const used = occupiedVolumeOfTank(tank.id, allocations.value)
      const usedByOthers = used - own
      const occupiedByOther = usedByOthers > 0.0001
      return {
        tank,
        ownL: own,
        freeL: Math.max(0, Math.round((tank.capacityL - used) * 10) / 10),
        disabled: occupiedByOther
      }
    })
})

/** 已选目标罐的实时容量（按选择顺序，供规划器使用） */
const selectedTargets = computed(() =>
  rackingForm.targetTankIds
    .map((tankId) => targetOptions.value.find((item) => item.tank.id === tankId))
    .filter((item): item is NonNullable<typeof item> => !!item)
    .map((item) => ({ tankId: item.tank.id, tankCode: item.tank.code, freeL: item.freeL }))
)

const rackingPlan = computed<RackingPlan | null>(() => {
  if (!rackingForm.fromTankId || !(rackingForm.plannedVolumeL > 0)) return null
  const sourceVolume = batchAllocations.value.find((item) => item.tankId === rackingForm.fromTankId)?.volumeL ?? 0
  if (sourceVolume <= 0) return null
  return planRacking({
    sourceBatchVolumeL: sourceVolume,
    plannedL: rackingForm.plannedVolumeL,
    targets: selectedTargets.value
  })
})

const lockHeld = computed(() =>
  rackingForm.batchId ? rackingLock.heldBatchIds.value.has(rackingForm.batchId) : false
)
const lockedByOther = computed(() =>
  rackingForm.batchId ? rackingLock.isHeldByOther(rackingForm.batchId) : false
)

async function onBatchChange(batchId: string, oldBatchId: string): Promise<void> {
  rackingForm.fromTankId = ''
  rackingForm.targetTankIds = []
  versionStale.value = false
  if (oldBatchId && oldBatchId !== batchId) await rackingLock.release(oldBatchId)
  await tryLockBatch(batchId)
}

async function tryLockBatch(batchId: string): Promise<void> {
  if (!batchId) return
  if (rackingLock.heldBatchIds.value.has(batchId)) return
  const acquired = await rackingLock.acquire(batchId)
  if (!acquired) {
    ElMessage.warning('该批次的倒罐正在另一个页面操作，本页面只能查看罐位，不能重复提交')
  }
}

async function openRacking(): Promise<void> {
  versionStale.value = false
  Object.assign(rackingForm, {
    batchId: store.currentBatchId ?? '',
    fromTankId: '',
    targetTankIds: [],
    plannedVolumeL: 500,
    date: today(),
    durationMin: 45,
    operator: ''
  })
  rackingVisible.value = true
  if (rackingForm.batchId) await tryLockBatch(rackingForm.batchId)
}

watch(rackingVisible, async (visible) => {
  if (visible) {
    expectedRackVersion.value = await getRackVersion()
    const observable = liveQuery(() => getRackVersion())
    versionUnsub = observable.subscribe((version) => {
      if (version !== expectedRackVersion.value) versionStale.value = true
      rackVersion.value = version
    })
  } else {
    versionUnsub?.unsubscribe()
    versionUnsub = null
    if (rackingForm.batchId) await rackingLock.release(rackingForm.batchId)
  }
})

const canSubmitRacking = computed(
  () =>
    lockHeld.value &&
    !versionStale.value &&
    !rackingSubmitting.value &&
    !!rackingForm.fromTankId &&
    rackingForm.targetTankIds.length > 0 &&
    (rackingPlan.value?.movedL ?? 0) > 0
)

async function submitRacking(): Promise<void> {
  const valid = await rackingFormRef.value?.validate().catch(() => false)
  if (!valid) return
  if (!lockHeld.value) {
    ElMessage.error('该批次的倒罐正在另一个页面操作，本页面不能提交')
    return
  }
  if (versionStale.value) {
    ElMessage.error('打开后罐位已被其它页面改动，请关闭倒罐单、确认最新罐位后再提交')
    return
  }
  rackingSubmitting.value = true
  try {
    const result = await store.racking({
      batchId: rackingForm.batchId,
      fromTankId: rackingForm.fromTankId,
      targetTankIds: rackingForm.targetTankIds,
      plannedVolumeL: rackingForm.plannedVolumeL,
      date: rackingForm.date,
      durationMin: rackingForm.durationMin,
      operator: rackingForm.operator,
      expectedRackVersion: expectedRackVersion.value
    })
    const detail = result.splits.map((split) => `${split.tankCode} ${split.volumeL}L`).join('、')
    if (result.partial) {
      ElMessageBox.alert(
        `实际倒出 ${result.movedVolumeL}L（计划 ${result.plannedVolumeL}L），${detail}；其余 ${result.remainingVolumeL}L 仍留在原罐，容量够了可再倒一次。`,
        '目标罐容量不足，已分批倒',
        { type: 'warning' }
      )
    } else {
      ElMessage.success(`倒罐完成：${result.movedVolumeL}L → ${detail}，原罐余 ${result.remainingVolumeL}L`)
    }
    rackingVisible.value = false
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '倒罐失败，本次写入已整批回滚')
  } finally {
    rackingSubmitting.value = false
  }
}

function onFilterChange(next: FilterModel): void {
  store.setFilters(next)
}

onMounted(() => {
  store.applyQuery(route.query)
})

watch(
  () => store.filters,
  (value) => {
    void router.replace({ path: route.path, query: filtersToQuery(value) })
  },
  { deep: true }
)
</script>

<template>
  <div class="page">
    <div class="page__head">
      <div>
        <h2 class="page__title">倒罐与压帽作业编排</h2>
        <p class="page__subtitle">
          倒罐会按目标罐容量把整批酒拆进多个罐，容量不够自动分批、余量留在原罐；作业、分罐与罐位一次写入。
        </p>
      </div>
      <div>
        <el-button type="success" @click="openRacking">倒罐（搬酒）</el-button>
        <el-button type="primary" :icon="Plus" @click="openCreate">新增作业</el-button>
      </div>
    </div>

    <el-card shadow="never">
      <div class="metric-row">
        <el-tag type="info" effect="plain">作业 {{ summary.total }} 条</el-tag>
        <el-tag type="warning" effect="plain">计划中 {{ summary.planned }}</el-tag>
        <el-tag type="success" effect="plain">已完成 {{ summary.done }}</el-tag>
        <el-tag effect="plain">合计工时 {{ summary.totalMinutes }} 分钟</el-tag>
        <el-select v-model="store.currentBatchId" clearable placeholder="全部批次" class="batch-filter" @change="store.select(store.currentBatchId)">
          <el-option v-for="item in batches" :key="item.id" :label="batchLabel(item.id)" :value="item.id" />
        </el-select>
      </div>
    </el-card>

    <FilterBar
      :model-value="store.filters"
      :selects="selects"
      keyword-placeholder="搜索作业类型 / 操作人 / 批次…"
      @update:model-value="onFilterChange"
      @reset="store.resetFilters()"
    />

    <EmptyPanel
      v-if="ready && filtered.length === 0"
      title="还没有排定的作业"
      description="为在罐批次添加倒罐 / 压帽 / 淋皮作业；倒罐会按罐容量真正搬酒并更新罐位。"
      create-text="新增作业"
      @create="openCreate"
    />

    <div v-else class="op-list">
      <div
        v-for="(row, index) in filtered"
        :key="row.id"
        class="op-item"
        :class="{ 'is-dragging': dragIndex === index, 'is-over': overIndex === index }"
        draggable="true"
        @dragstart="onDragStart(index)"
        @dragover.prevent="onDragOver(index)"
        @drop.prevent="onDrop(index)"
        @dragend="dragIndex = null"
      >
        <el-icon class="drag-handle"><Rank /></el-icon>
        <div class="op-item__seq">#{{ index + 1 }}</div>
        <div class="op-item__body">
          <div class="op-item__title">
            <strong>{{ row.type }}</strong>
            <StageTag :value="row.state" size="small" />
            <el-tag size="small" effect="plain">{{ row.durationMin }} 分钟</el-tag>
          </div>
          <div class="op-item__meta">
            {{ row.date }} · 操作人 {{ row.operator }} · {{ batchLabel(row.batchId) }}
          </div>
          <div v-if="rackingByOperation.get(row.id)" class="op-item__racking">
            <el-tag size="small" type="success" effect="plain">倒罐搬酒</el-tag>
            <span>
              罐 {{ tankCode(rackingByOperation.get(row.id)!.fromTankId) }} →
              <template v-for="(split, splitIndex) in rackingByOperation.get(row.id)!.splits" :key="split.tankId">
                {{ splitIndex > 0 ? '、' : '' }}罐 {{ tankCode(split.tankId) }} {{ split.volumeL }}L
              </template>
              （搬出 {{ rackingByOperation.get(row.id)!.movedVolumeL }}L，原罐余
              {{ rackingByOperation.get(row.id)!.remainingVolumeL }}L）
            </span>
          </div>
        </div>
        <div class="op-item__actions">
          <el-button link size="small" :disabled="index === 0" @click="moveBy(index, -1)">上移</el-button>
          <el-button link size="small" :disabled="index === filtered.length - 1" @click="moveBy(index, 1)">下移</el-button>
          <el-button v-if="row.state === '计划'" link type="success" size="small" @click="finish(row)">完成</el-button>
          <el-button link type="primary" size="small" @click="openEdit(row)">编辑</el-button>
          <el-button link type="danger" size="small" @click="remove(row)">删除</el-button>
        </div>
      </div>
    </div>

    <el-card v-if="rackings.length > 0" shadow="never" class="racking-log">
      <template #header>
        <div class="card-title">
          <span>倒罐流水（{{ rackings.length }}）</span>
          <span class="muted">每次倒罐的分罐与余量记录，与作业同事务写入</span>
        </div>
      </template>
      <el-table :data="rackings" stripe size="small">
        <el-table-column prop="date" label="日期" width="110" />
        <el-table-column label="批次" min-width="160">
          <template #default="{ row }">{{ batchLabel(row.batchId) }}</template>
        </el-table-column>
        <el-table-column label="倒出罐" width="90">
          <template #default="{ row }">{{ tankCode(row.fromTankId) }}</template>
        </el-table-column>
        <el-table-column label="分罐明细" min-width="220">
          <template #default="{ row }">
            <span v-for="(split, index) in row.splits" :key="split.tankId">
              {{ index > 0 ? '；' : '' }}罐 {{ tankCode(split.tankId) }} {{ split.volumeL }}L
            </span>
          </template>
        </el-table-column>
        <el-table-column label="搬出(L)" width="90" prop="movedVolumeL" align="right" />
        <el-table-column label="原罐余(L)" width="100" prop="remainingVolumeL" align="right" />
      </el-table>
    </el-card>

    <!-- 普通作业对话框 -->
    <el-dialog v-model="dialogVisible" :title="editingId ? '编辑作业' : '新增作业'" width="540px">
      <el-form ref="formRef" :model="form" :rules="rules" label-width="100px">
        <el-form-item label="批次" prop="batchId">
          <el-select v-model="form.batchId" class="full" placeholder="选择批次">
            <el-option
              v-for="item in batches.filter((batch) => batch.state !== '已出罐')"
              :key="item.id"
              :label="batchLabel(item.id)"
              :value="item.id"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="作业类型">
          <el-radio-group v-model="form.type">
            <el-radio-button v-for="item in OPERATION_TYPES" :key="item" :value="item">{{ item }}</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="日期">
          <el-date-picker v-model="form.date" type="date" value-format="YYYY-MM-DD" class="full" />
        </el-form-item>
        <el-form-item label="时长(分钟)">
          <el-input-number v-model="form.durationMin" :min="5" :max="600" :step="5" />
        </el-form-item>
        <el-form-item label="操作人" prop="operator">
          <el-input v-model="form.operator" placeholder="如：陈岩" />
        </el-form-item>
        <el-form-item label="状态">
          <el-select v-model="form.state" class="full">
            <el-option v-for="item in OPERATION_STATES" :key="item" :label="item" :value="item" />
          </el-select>
        </el-form-item>
        <el-alert
          v-if="form.type === '倒罐'"
          type="info"
          :closable="false"
          title="这里只登记倒罐作业；要真正把酒搬到目标罐，请使用页面上方「倒罐（搬酒）」。"
        />
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" @click="submit">保存</el-button>
      </template>
    </el-dialog>

    <!-- 倒罐（搬酒）对话框 -->
    <el-dialog v-model="rackingVisible" title="倒罐（按罐容量搬酒）" width="680px">
      <el-alert
        v-if="lockedByOther && !lockHeld"
        type="error"
        :closable="false"
        show-icon
        title="罐位已被占用：另一个页面正在操作该批次的倒罐"
        description="本次提交已停止，避免两人同时搬酒。请等待对方完成后刷新罐位，再发起倒罐。"
        class="mb"
      />
      <el-alert
        v-else-if="versionStale"
        type="warning"
        :closable="false"
        show-icon
        title="打开倒罐单后罐位发生了变化"
        description="可能有其他人先提交了倒罐。请关闭本单，按最新罐位重新选择目标罐后再提交。"
        class="mb"
      />
      <el-form ref="rackingFormRef" :model="rackingForm" :rules="rackingRules" label-width="100px">
        <el-form-item label="批次" prop="batchId">
          <el-select
            v-model="rackingForm.batchId"
            class="full"
            placeholder="选择在罐批次"
            @change="onBatchChange(rackingForm.batchId, $event)"
          >
            <el-option
              v-for="item in activeBatches"
              :key="item.id"
              :label="`${batchLabel(item.id)} · 在罐 ${item.volumeL}L`"
              :value="item.id"
            />
          </el-select>
        </el-form-item>

        <el-form-item v-if="rackingForm.batchId" label="当前分罐">
          <div class="alloc-line">
            <el-tag v-for="alloc in batchAllocations" :key="alloc.id" size="small" effect="plain" class="alloc-tag">
              罐 {{ tankCode(alloc.tankId) }} · {{ alloc.volumeL }}L
            </el-tag>
          </div>
        </el-form-item>

        <el-form-item label="倒出罐" prop="fromTankId">
          <el-select v-model="rackingForm.fromTankId" class="full" placeholder="选择倒出罐">
            <el-option
              v-for="item in sourceTanks"
              :key="item.alloc.id"
              :label="`罐 ${item.tank!.code} · 该罐内 ${item.alloc.volumeL}L`"
              :value="item.alloc.tankId"
            />
          </el-select>
        </el-form-item>

        <el-form-item label="目标罐">
          <div class="full">
            <el-select
              v-model="rackingForm.targetTankIds"
              class="full"
              multiple
              collapse-tags
              collapse-tags-tooltip
              placeholder="按倒酒顺序选择目标罐（可多选拆分）"
            >
              <el-option
                v-for="item in targetOptions"
                :key="item.tank.id"
                :label="`罐 ${item.tank.code} · 容量 ${item.tank.capacityL}L · 空余 ${item.freeL}L${item.ownL > 0 ? `（本批已占 ${item.ownL}L）` : ''}${item.disabled ? ' · 其它批次占用' : ''}`"
                :value="item.tank.id"
                :disabled="item.disabled"
              />
            </el-select>
            <div class="muted tip">按选择顺序逐罐装：一个罐装不下自动进下一个罐，全部装满仍有余量则留在原罐。</div>
          </div>
        </el-form-item>

        <el-form-item label="计划倒出(L)" prop="plannedVolumeL">
          <el-input-number v-model="rackingForm.plannedVolumeL" :min="1" :max="50000" :step="50" />
        </el-form-item>
        <el-form-item label="日期">
          <el-date-picker v-model="rackingForm.date" type="date" value-format="YYYY-MM-DD" class="full" />
        </el-form-item>
        <el-form-item label="时长(分钟)">
          <el-input-number v-model="rackingForm.durationMin" :min="5" :max="600" :step="5" />
        </el-form-item>
        <el-form-item label="操作人" prop="operator">
          <el-input v-model="rackingForm.operator" placeholder="如：林沐" />
        </el-form-item>

        <el-form-item v-if="rackingPlan" label="倒罐预览">
          <el-descriptions :column="1" border size="small" class="full">
            <el-descriptions-item label="将搬出">{{ rackingPlan.movedL }}L</el-descriptions-item>
            <el-descriptions-item label="分罐">
              <span v-if="rackingPlan.splits.length === 0" class="muted">所选目标罐没有空余容量</span>
              <span v-for="(split, index) in rackingPlan.splits" :key="split.tankId">
                {{ index > 0 ? '；' : '' }}罐 {{ split.tankCode }} {{ split.putL }}L
              </span>
            </el-descriptions-item>
            <el-descriptions-item label="原罐余量">{{ rackingPlan.remainingL }}L</el-descriptions-item>
          </el-descriptions>
        </el-form-item>
        <el-alert
          v-if="rackingPlan?.partial"
          type="warning"
          :closable="false"
          show-icon
          title="目标罐空余容量不足"
          description="本次只搬走目标罐能装下的部分，余量留在原罐，容量释放后可再倒一次。"
          class="mb"
        />
      </el-form>
      <template #footer>
        <el-button @click="rackingVisible = false">取消</el-button>
        <el-button type="success" :disabled="!canSubmitRacking" :loading="rackingSubmitting" @click="submitRacking">
          确认倒罐
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.full {
  width: 100%;
}

.mb {
  margin-bottom: 12px;
}

.metric-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.batch-filter {
  width: 240px;
  margin-left: auto;
}

.op-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.op-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
  background: #ffffff;
  border: 1px solid var(--wine-border);
  border-left: 4px solid #b9688a;
  border-radius: 10px;
}

.op-item.is-dragging {
  opacity: 0.45;
}

.op-item.is-over {
  border-top: 2px dashed #b9688a;
}

.op-item__seq {
  width: 38px;
  font-weight: 700;
  color: #8a3b56;
  font-variant-numeric: tabular-nums;
}

.op-item__body {
  flex: 1;
}

.op-item__title {
  display: flex;
  align-items: center;
  gap: 8px;
}

.op-item__meta {
  margin-top: 4px;
  font-size: 12px;
  color: #8c8479;
}

.op-item__racking {
  margin-top: 6px;
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: #4d7a5c;
}

.op-item__actions {
  display: flex;
  align-items: center;
}

.racking-log {
  margin-top: 16px;
}

.alloc-line {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.alloc-tag {
  margin: 0;
}

.tip {
  margin-top: 4px;
  font-size: 12px;
}
</style>

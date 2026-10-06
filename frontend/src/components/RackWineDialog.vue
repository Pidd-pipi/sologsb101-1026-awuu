<script setup lang="ts">
/**
 * 倒罐对话框：按目标罐容量把一个批次从源罐拆进多个罐。
 * - 实时预览分罐计划：目标依次灌满，目标罐容量不够则分批倒，余下留原罐
 * - 提交时作业 / 分罐 / 罐位单事务写入；并发冲突时停下提示，不留半截记录
 */
import { computed, reactive, ref, watch } from 'vue'
import { ElMessage, type FormInstance, type FormRules } from 'element-plus'
import { db, type BatchRow, type SplitRow, type TankRow, type ParcelRow } from '@/utils/db'
import { useIdbTable } from '@/hooks/useIdbTable'
import { useRackingStore } from '@/stores/rackingStore'
import { planRacking } from '@/utils/racking'
import { splitsOfBatch } from '@/utils/tankOccupancy'
import type { RackPlan } from '@/types/split'

const props = defineProps<{
  modelValue: boolean
  batches: BatchRow[]
  tanks: TankRow[]
  splits: SplitRow[]
  defaultBatchId?: string | null
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void
  (e: 'racked', batchId: string): void
}>()

const rackingStore = useRackingStore()
const { rows: parcels } = useIdbTable<ParcelRow>(() => db.parcels)

const formRef = ref<FormInstance>()
const submitting = ref(false)
const form = reactive({
  batchId: '',
  sourceTankId: '',
  targetTankIds: [] as string[],
  date: new Date().toISOString().slice(0, 10),
  durationMin: 45,
  operator: ''
})

const rules: FormRules = {
  batchId: [{ required: true, message: '请选择批次', trigger: 'change' }],
  sourceTankId: [{ required: true, message: '请选择源罐', trigger: 'change' }],
  operator: [{ required: true, message: '请填写操作人', trigger: 'blur' }]
}

const dialogVisible = computed({
  get: () => props.modelValue,
  set: (value) => emit('update:modelValue', value)
})

/** 仅在罐批次可倒罐 */
const activeBatches = computed(() => props.batches.filter((batch) => batch.state !== '已出罐'))

const currentBatch = computed(() => props.batches.find((batch) => batch.id === form.batchId) ?? null)

/** 当前批次的在罐分罐（可能分布在多个罐） */
const currentSplits = computed(() =>
  currentBatch.value ? splitsOfBatch(props.splits, currentBatch.value.id).filter((split) => split.volumeL > 0) : []
)

const sourceSplit = computed(() =>
  currentSplits.value.find((split) => split.tankId === form.sourceTankId) ?? null
)

function parcelName(parcelId: string): string {
  return parcels.value.find((item) => item.id === parcelId)?.name ?? '未知地块'
}

function batchLabel(batch: BatchRow): string {
  return `${parcelName(batch.parcelId)} · ${batch.harvestDate} · ${batch.id}`
}

function tankCode(tankId: string): string {
  return props.tanks.find((tank) => tank.id === tankId)?.code ?? '未知罐'
}

interface TargetOption {
  tankId: string
  code: string
  capacityL: number
  /** 该罐已被其它在罐批次占用 */
  occupiedByOther: boolean
  /** 本批次此前已在该罐的量（合罐场景） */
  selfVolumeL: number
  /** 可倒入余量 */
  freeL: number
}

/** 候选目标罐：清洗中与被其它批次占用的罐不可选；本批次自用罐可作合罐目标 */
const targetOptions = computed<TargetOption[]>(() => {
  return props.tanks
    .filter((tank) => tank.id !== form.sourceTankId)
    .map((tank) => {
      const occupant = props.splits.find((split) => split.tankId === tank.id && split.volumeL > 0)
      const selfVolumeL = occupant?.batchId === form.batchId ? occupant.volumeL : 0
      const occupiedByOther = Boolean(occupant && occupant.batchId !== form.batchId)
      return {
        tankId: tank.id,
        code: tank.code,
        capacityL: tank.capacityL,
        occupiedByOther,
        selfVolumeL,
        freeL: occupiedByOther ? 0 : Math.max(0, tank.capacityL - selfVolumeL)
      }
    })
    .filter((option) => !option.occupiedByOther)
    .sort((a, b) => a.code.localeCompare(b.code, 'zh-Hans-CN'))
})

/** 按所选目标顺序实时计算分罐计划 */
const plan = computed<RackPlan | null>(() => {
  if (!sourceSplit.value || form.targetTankIds.length === 0) return null
  const ordered = form.targetTankIds
    .map((id) => targetOptions.value.find((option) => option.tankId === id))
    .filter((option): option is TargetOption => Boolean(option))
  return planRacking({
    sourceTankId: form.sourceTankId,
    sourceVolumeL: sourceSplit.value.volumeL,
    targets: ordered.map((option) => ({
      tankId: option.tankId,
      capacityL: option.capacityL,
      selfVolumeL: option.selfVolumeL
    }))
  })
})

const totalFreeCapacity = computed(() =>
  form.targetTankIds.reduce((sum, id) => sum + (targetOptions.value.find((option) => option.tankId === id)?.freeL ?? 0), 0)
)

function resetForm(preferBatchId?: string | null): void {
  const batchId = preferBatchId && activeBatches.value.some((batch) => batch.id === preferBatchId)
    ? preferBatchId
    : activeBatches.value[0]?.id ?? ''
  form.batchId = batchId
  const firstSplit = props.splits.filter((split) => split.batchId === batchId && split.volumeL > 0)[0]
  form.sourceTankId = firstSplit?.tankId ?? ''
  form.targetTankIds = []
  form.date = new Date().toISOString().slice(0, 10)
  form.durationMin = 45
  form.operator = ''
}

watch(
  () => props.modelValue,
  (visible) => {
    if (visible) resetForm(props.defaultBatchId)
  }
)

/** 切换批次后默认选中该批次当前量最大的罐作为源罐 */
watch(
  () => form.batchId,
  () => {
    const splits = currentSplits.value
    form.sourceTankId = splits.slice().sort((a, b) => b.volumeL - a.volumeL)[0]?.tankId ?? ''
    form.targetTankIds = []
  }
)

/** 源罐不应再作为自己的目标 */
watch(
  () => form.sourceTankId,
  () => {
    form.targetTankIds = form.targetTankIds.filter((id) => id !== form.sourceTankId)
  }
)

async function submit(): Promise<void> {
  const valid = await formRef.value?.validate().catch(() => false)
  if (!valid) return
  if (form.targetTankIds.length === 0) {
    ElMessage.warning('请至少选择一个目标罐')
    return
  }
  if (!plan.value || plan.value.movedTotalL <= 0) {
    ElMessage.warning('所选目标罐没有可倒入余量，请重新选择')
    return
  }
  if (!currentBatch.value) return
  submitting.value = true
  try {
    const result = await rackingStore.submit({
      batchId: form.batchId,
      sourceTankId: form.sourceTankId,
      targetTankIds: form.targetTankIds,
      date: form.date,
      durationMin: form.durationMin,
      operator: form.operator,
      expectedBatchUpdatedAt: currentBatch.value.updatedAt
    })
    const summary = result.plan.targets
      .map((target) => `${tankCode(target.tankId)} ${target.moveVolumeL}L`)
      .join('、')
    ElMessage.success(
      `倒罐已完成：${tankCode(result.plan.sourceTankId)} → ${summary}；原罐余量 ${result.plan.leftVolumeL}L`
    )
    emit('racked', form.batchId)
    dialogVisible.value = false
  } catch (error) {
    // 并发冲突 / 罐位被占 / 其它校验失败：事务已整体回滚，停下提示用户核对后重试
    ElMessage.error(error instanceof Error ? error.message : '倒罐失败，未写入任何记录')
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <el-dialog v-model="dialogVisible" title="倒罐（按罐容量分罐）" width="680px">
    <el-form ref="formRef" :model="form" :rules="rules" label-width="92px">
      <el-form-item label="批次" prop="batchId">
        <el-select v-model="form.batchId" class="full" placeholder="选择在罐批次">
          <el-option
            v-for="item in activeBatches"
            :key="item.id"
            :label="batchLabel(item)"
            :value="item.id"
          />
        </el-select>
      </el-form-item>

      <el-form-item v-if="currentBatch" label="当前分罐">
        <div class="split-now">
          <el-tag
            v-for="split in currentSplits"
            :key="split.id"
            :type="split.tankId === form.sourceTankId ? 'danger' : 'info'"
            effect="plain"
            class="split-tag"
          >
            {{ tankCode(split.tankId) }} · {{ split.volumeL }}L
          </el-tag>
        </div>
      </el-form-item>

      <el-form-item label="源罐" prop="sourceTankId">
        <el-select v-model="form.sourceTankId" class="full" placeholder="选择倒出酒的罐">
          <el-option
            v-for="split in currentSplits"
            :key="split.tankId"
            :label="`${tankCode(split.tankId)}（现有 ${split.volumeL}L）`"
            :value="split.tankId"
          />
        </el-select>
      </el-form-item>

      <el-form-item label="目标罐">
        <el-select
          v-model="form.targetTankIds"
          multiple
          collapse-tags
          collapse-tags-tooltip
          class="full"
          placeholder="按倒罐顺序选择（可多选，依次灌满）"
        >
          <el-option
            v-for="option in targetOptions"
            :key="option.tankId"
            :label="`${option.code} · 容量 ${option.capacityL}L · 可倒入 ${option.freeL}L${option.selfVolumeL > 0 ? `（本批次已在罐 ${option.selfVolumeL}L）` : ''}`"
            :value="option.tankId"
          />
        </el-select>
      </el-form-item>

      <el-form-item label="作业日期">
        <el-date-picker v-model="form.date" type="date" value-format="YYYY-MM-DD" />
      </el-form-item>
      <el-form-item label="时长(分钟)">
        <el-input-number v-model="form.durationMin" :min="5" :max="600" :step="5" />
      </el-form-item>
      <el-form-item label="操作人" prop="operator">
        <el-input v-model="form.operator" placeholder="如：林沐" />
      </el-form-item>
    </el-form>

    <el-alert
      v-if="plan && sourceSplit && totalFreeCapacity < sourceSplit.volumeL"
      type="warning"
      :closable="false"
      show-icon
      class="plan-alert"
      :title="`目标罐总余量 ${totalFreeCapacity}L，小于源罐现有 ${sourceSplit.volumeL}L：将分批倒满目标罐，余下 ${plan.leftVolumeL}L 留在原罐`"
    />

    <el-card v-if="plan" shadow="never" class="plan-card">
      <template #header>
        <span>分罐计划预览（提交后作业 / 分罐 / 罐位一次写入，失败整体回滚）</span>
      </template>
      <el-table :data="plan.targets" border size="small">
        <el-table-column label="顺序" type="index" width="60" align="center" />
        <el-table-column label="目标罐" width="110">
          <template #default="{ row }">{{ tankCode(row.tankId) }}</template>
        </el-table-column>
        <el-table-column prop="capacityL" label="容量(L)" width="110" align="right" />
        <el-table-column prop="moveVolumeL" label="本次倒入(L)" width="120" align="right" />
        <el-table-column prop="afterVolumeL" label="倒入后本批次在罐(L)" align="right" />
      </el-table>
      <div class="plan-summary">
        <el-tag type="info" effect="plain">源罐倒出 {{ plan.movedTotalL }}L</el-tag>
        <el-tag :type="plan.leftVolumeL > 0 ? 'warning' : 'success'" effect="plain">
          原罐余量 {{ plan.leftVolumeL }}L
        </el-tag>
      </div>
    </el-card>

    <template #footer>
      <el-button @click="dialogVisible = false">取消</el-button>
      <el-button type="primary" :loading="submitting" @click="submit">提交倒罐</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.full {
  width: 100%;
}

.split-now {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.split-tag {
  font-variant-numeric: tabular-nums;
}

.plan-card {
  margin-top: 4px;
}

.plan-alert {
  margin-bottom: 10px;
}

.plan-summary {
  display: flex;
  gap: 8px;
  margin-top: 10px;
}
</style>

<template>
  <!-- 面板本体走 PanelShell：此前它套的是通用 Modal，没有 .panel-shell
       停靠契约，所以"角色"是全站唯一一个铺开盖住整个视口、不进右坞的面板。 -->
  <PanelShell title="数据统计" hint="修行生涯累计" size="2xl" @close="$emit('close')">
    <div class="space-y-6">
           <!-- 基础统计 -->
           <div>
              <h3 class="text-lg font-bold text-fg-primary mb-3 flex items-center gap-2 font-display">
                 <span class="text-blue-500">
                    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
                 </span>
                 基础统计
              </h3>
              <div class="grid grid-cols-2 md:grid-cols-3 gap-3">
                 <div class="bg-surface-raised p-3 rounded border border-line-subtle">
                    <div class="text-xs text-fg-faint mb-1">游戏天数</div>
                    <div class="text-lg num text-gold-500" :title="player?.created_at ? `创角 ${player.created_at}` : undefined">{{ gameDays }}</div>
                 </div>
                 <div class="bg-surface-raised p-3 rounded border border-line-subtle">
                    <div class="text-xs text-fg-faint mb-1">游戏时长</div>
                    <div class="text-lg num text-blue-400">{{ formatOnlineTime(player?.total_online_time || 0) }}</div>
                 </div>
                 <div class="bg-surface-raised p-3 rounded border border-line-subtle">
                    <div class="text-xs text-fg-faint mb-1">当前境界</div>
                    <div class="text-lg num text-purple-400">{{ player?.realm }}</div>
                 </div>
                 <div class="bg-surface-raised p-3 rounded border border-line-subtle">
                    <div class="text-xs text-fg-faint mb-1">境界进度</div>
                    <div class="w-full bg-surface-sunken rounded-full h-2 mt-2 mb-1 overflow-hidden">
                       <div class="bg-purple-600 h-full rounded-full" :style="{ width: expBarWidth }"></div>
                    </div>
                    <!-- 与左栏同口径：进度% + 修为/上限，避免只有百分比看不出量级 -->
                    <div class="text-right text-xs text-purple-400 num" :title="`${formatNumber(expCurrent)} / ${formatNumber(expCap)}`">
                       {{ formatExpProgress(expProgress) }}
                       <span class="text-fg-faint">·</span>
                       {{ formatCompact(expCurrent) }} / {{ formatCompact(expCap) }}
                    </div>
                    <div v-if="expRemainingText" class="text-right text-[10px] text-fg-faint num mt-0.5">
                       距圆满还差 {{ expRemainingText }}
                    </div>
                 </div>
                 <div class="bg-surface-raised p-3 rounded border border-line-subtle">
                    <div class="text-xs text-fg-faint mb-1">当前修为</div>
                    <!-- 大数走万/亿单位，hover 看精确值 -->
                    <div class="text-lg num text-emerald-400" :title="formatNumber(expCurrent)">{{ formatCompact(expCurrent) }}</div>
                 </div>
                 <div class="bg-surface-raised p-3 rounded border border-line-subtle">
                    <div class="text-xs text-fg-faint mb-1">当前灵石</div>
                    <div class="text-lg num text-gold-500" :title="formatNumber(player?.spirit_stones || 0)">{{ formatCompact(player?.spirit_stones || 0) }}</div>
                 </div>
              </div>
           </div>

           <!-- 属性明细：整块由服务端属性注册表驱动 -->
           <!-- 左栏只放 panel.spot=sidebar 的几格，其余属性（法攻/法防/暴击/闪避/吸血/
                资料片新增的五行抗性…）全靠这里露出。资料片加一个属性，这张表自动多一行。 -->
           <div>
              <h3 class="text-lg font-bold text-fg-primary mb-3 flex items-center gap-2 font-display">
                 <span class="text-emerald-500">
                    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><path d="M7 16V9"/><path d="M11 16V5"/><path d="M15 16v-4"/><path d="M19 16v-7"/></svg>
                 </span>
                 属性明细
              </h3>
              <div v-if="detailRows.length" class="grid grid-cols-2 md:grid-cols-3 gap-3">
                 <div
                    v-for="row in detailRows"
                    :key="row.key"
                    class="bg-surface-raised p-3 rounded border border-line-subtle"
                 >
                    <div class="text-xs text-fg-faint mb-1 truncate" :title="row.description">{{ row.label }}</div>
                    <div class="text-lg num text-fg-primary" :title="row.exact">{{ row.shown }}</div>
                 </div>
              </div>
              <div v-else class="bg-surface-raised p-4 rounded border border-line-subtle text-center text-fg-faint text-sm">
                 暂无属性数据
              </div>
           </div>

           <!-- 战斗统计 -->
           <div>
              <h3 class="text-lg font-bold text-fg-primary mb-3 flex items-center gap-2 font-display">
                 <span class="text-red-500">
                    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m14.5 17.5-11.5-11.5"/><path d="m11.5 6 11.5 11.5"/><path d="m17.5 14.5 3 3"/><path d="m3 3 11.5 11.5"/><path d="m3 21 4-4"/><path d="m17 7 4-4"/></svg>
                 </span>
                 战斗统计
              </h3>
              <div class="grid grid-cols-3 gap-3">
                 <div class="bg-surface-raised p-3 rounded border border-line-subtle">
                    <div class="text-xs text-fg-faint mb-1">击杀敌人</div>
                    <div class="text-lg num text-red-400">{{ attributes.player_stats?.kill_count || 0 }}</div>
                 </div>
                 <div class="bg-surface-raised p-3 rounded border border-line-subtle">
                    <div class="text-xs text-fg-faint mb-1">历练次数</div>
                    <div class="text-lg num text-orange-400">{{ attributes.player_stats?.exploration_count || 0 }}</div>
                 </div>
                 <div class="bg-surface-raised p-3 rounded border border-line-subtle">
                    <div class="text-xs text-fg-faint mb-1">死亡次数</div>
                    <div class="text-lg num text-purple-400">{{ attributes.player_stats?.death_count || 0 }}</div>
                 </div>
              </div>
           </div>

           <!-- 修炼统计 -->
           <div>
              <h3 class="text-lg font-bold text-fg-primary mb-3 flex items-center gap-2 font-display">
                 <span class="text-gold-500">
                    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
                 </span>
                 修炼统计
              </h3>
              <div class="grid grid-cols-2 md:grid-cols-3 gap-3">
                 <div class="bg-surface-raised p-3 rounded border border-line-subtle">
                    <div class="text-xs text-fg-faint mb-1">打坐次数</div>
                    <div class="text-lg num text-blue-400">{{ attributes.player_stats?.meditation_count || 0 }}</div>
                 </div>
                 <div class="bg-surface-raised p-3 rounded border border-line-subtle">
                    <div class="text-xs text-fg-faint mb-1">突破次数</div>
                    <div class="text-lg num text-purple-400">{{ attributes.player_stats?.breakthrough_count || 0 }}</div>
                 </div>
                 <!-- 更多统计项 -->
              </div>
           </div>
    </div>
  </PanelShell>
</template>

<script setup>
import { ref, onMounted, computed } from 'vue';
import PanelShell from '../ui/PanelShell.vue';
import { usePlayerStore } from '../../stores/player';
import { useUIStore } from '../../stores/ui';
import { getFullAttributes } from '../../api/attribute';
import { useStatSchema } from '../../composables/useStatSchema';
import { formatNumber, formatCompact, formatExpProgress, calcExpProgress } from '../../utils/format';

const { detailStats, gridCell } = useStatSchema();

defineEmits(['close']);

const playerStore = usePlayerStore();
const uiStore = useUIStore();
const player = computed(() => playerStore.player);

const attributes = ref({ 
    current: {}, 
    max: {}, 
    breakdown: {},
    info: {
        talent: null,
        title: null,
        all_titles: [],
        owned_titles: []
    },
    player_stats: {},
    attribute_points: 0,
    validation: {} 
});

/**
 * 属性明细行：字段清单来自服务端属性注册表（panel.spot !== 'sidebar' 的那些），
 * 数值来自 /api/attribute/full 的 final_attributes。
 * 只渲染 payload 里真的存在的键，避免服务端还没算某属性时露 0 骗人。
 */
const detailRows = computed(() => {
  const final = attributes.value.final_attributes || {};
  return detailStats.value
    .filter(entry => final[entry.key] !== undefined)
    .map(entry => gridCell(entry, final[entry.key]));
});

const fetchAttributes = async () => {
  try {
    const res = await getFullAttributes();
    if (res.data && res.data.data) {
      attributes.value = res.data.data;
    }
  } catch (error) {
    console.error('Fetch attributes failed:', error);
    uiStore.showApiError(error, 'Fetch attributes failed')
  }
};

const formatOnlineTime = (ms) => {
  if (!ms) return '0分钟';
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return `${minutes}分钟`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}小时${remainingMinutes}分钟`;
};

/**
 * 游戏天数：按创角自然日计。
 * 原先用 total_online_time/24h+1，在线 7 小时也显示「1 天」，
 * 而且不挂机就永远不涨 —— 和「游戏时长」重复且语义错位。
 */
const gameDays = computed(() => {
  const created = player.value?.created_at
  if (created) {
    const days = Math.floor((Date.now() - new Date(created).getTime()) / 86400000) + 1
    return Math.max(1, days)
  }
  // 无创建时间时兜底旧口径，避免空白
  return Math.floor((Number(player.value?.total_online_time) || 0) / 86400000) + 1
})

const expCurrent = computed(() => attributes.value.exp?.current ?? player.value?.exp ?? 0)
const expCap = computed(() => attributes.value.exp?.cap ?? player.value?.exp_next ?? player.value?.exp_cap ?? 0)

/** 境界进度：优先后端权威值，缺失时与左栏共用 calcExpProgress */
const expProgress = computed(() => {
  const fromServer = player.value?.exp_progress
  if (fromServer !== undefined && fromServer !== null && fromServer !== '') {
    const n = Number(fromServer)
    if (Number.isFinite(n)) return n
  }
  return calcExpProgress(expCurrent.value, expCap.value)
})

const expBarWidth = computed(() => {
  const p = expProgress.value
  if (p <= 0) return '0%'
  return `${Math.min(100, Math.max(p, 0.5))}%`
})

/** 距本境界圆满还差多少修为（已满则为空） */
const expRemainingText = computed(() => {
  try {
    const cur = BigInt(expCurrent.value || 0)
    const cap = BigInt(expCap.value || 0)
    if (cap <= 0n || cur >= cap) return ''
    return formatCompact((cap - cur).toString())
  } catch {
    const cur = Number(expCurrent.value) || 0
    const cap = Number(expCap.value) || 0
    if (cap <= 0 || cur >= cap) return ''
    return formatCompact(cap - cur)
  }
})

onMounted(() => {
  fetchAttributes();
});
</script>

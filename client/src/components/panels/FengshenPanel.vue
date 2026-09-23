<!--
 * 封神台面板组件（PVP 镜像排名竞技场）
 *
 * 弹窗式组件，展示封神台赛季制排名竞技玩法：
 *   Tab 1: 排行榜 — 查看排名列表 + 挑战按钮
 *   Tab 2: 我的封神 — 个人排名/积分/防守阵容设置
 *   Tab 3: 赛季信息 — 赛季时间/奖励规则
 *
 * 设计原则：
 *   - 所有业务逻辑在后端，前端仅做展示与接口调用
 *   - 外壳统一走 ui/PanelShell，分段导航走 ui/Tabs
 *   - 颜色风格：封神台用紫金双色系（arcane/gold），彰显竞技荣耀感
 *
 * 数据来源：
 *   - getRanking() / challengeRank() — 排行榜与挑战
 *   - getMyRanking() / getDefense() / setDefense() — 个人信息与防守
 *   - getSeasonInfo() — 赛季信息
-->
<template>
  <PanelShell title="封神台" hint="赛季制排名竞技" size="xl" @close="$emit('close')">
    <template #header-actions>
      <div class="hidden sm:flex items-center gap-2">
        <Badge tone="arcane">排名 <span class="num">{{ myInfo?.rank > 0 ? myInfo.rank : '未上榜' }}</span></Badge>
        <Badge tone="gold">积分 <span class="num">{{ myInfo?.fengshen_score || 0 }}</span></Badge>
        <Badge tone="success">剩余挑战 <span class="num">{{ myInfo?.daily_challenge_remaining ?? 5 }}</span></Badge>
      </div>
    </template>

    <!-- Tab 切换栏：切换时按需加载，行为与原 switchTab 一致 -->
    <Tabs
      :model-value="activeTab"
      :items="tabItems"
      class="mb-3"
      @update:model-value="switchTab"
    />

    <!-- ===== Tab 1: 排行榜 ===== -->
    <div v-if="activeTab === 'ranking'" class="space-y-3">
      <!-- 我的排名摘要：三列指标，短内容也不再拉出一长条空带 -->
      <PanelCard tone="gold">
        <div class="grid grid-cols-3 gap-2 text-center">
          <div>
            <div class="text-[10px] text-fg-faint mb-0.5">我的排名</div>
            <div class="text-lg font-bold text-state-arcane num">{{ myInfo?.rank > 0 ? myInfo.rank : '未上榜' }}</div>
          </div>
          <div>
            <div class="text-[10px] text-fg-faint mb-0.5">封神积分</div>
            <div class="text-lg font-bold text-gold-400 num">{{ myInfo?.fengshen_score || 0 }}</div>
          </div>
          <div>
            <div class="text-[10px] text-fg-faint mb-0.5">剩余挑战</div>
            <div class="text-lg font-bold text-state-success num">{{ myInfo?.daily_challenge_remaining ?? 5 }}</div>
          </div>
        </div>
      </PanelCard>

      <!-- 排行榜列表 -->
      <LoadingBlock v-if="rankingLoading" />
      <EmptyState
        v-else-if="rankingList.length === 0"
        text="暂无排名数据"
        hint="设置防守阵容即可上榜"
        icon="擂台"
      />
      <div v-else class="space-y-2">
        <div
          v-for="entry in rankingList"
          :key="entry.player_id"
          class="bg-surface-hover border rounded-panel p-3 flex items-center justify-between gap-3 transition-colors"
          :class="entry.rank === myInfo?.rank ? 'border-state-arcane/50 bg-surface-tint-arcane/40' : 'border-line hover:border-state-arcane/30'"
        >
          <div class="flex items-center gap-3 min-w-0">
            <!-- 排名徽章 -->
            <div
              class="w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold num shrink-0"
              :class="getRankBadgeClass(entry.rank)"
            >
              {{ entry.rank }}
            </div>
            <div class="min-w-0">
              <div class="flex items-center gap-2">
                <span class="text-sm font-bold text-fg-primary truncate">{{ entry.nickname }}</span>
                <span class="text-xs text-fg-muted shrink-0">{{ entry.realm }}</span>
              </div>
              <div class="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-fg-faint mt-0.5">
                <span>积分 <span class="text-gold-400 num">{{ entry.fengshen_score }}</span></span>
                <span>胜率 <span class="text-state-success num">{{ entry.win_rate }}%</span></span>
                <span class="num">{{ entry.total_wins }}胜 {{ entry.total_losses }}败</span>
              </div>
            </div>
          </div>
          <!-- 挑战按钮 -->
          <AppButton
            v-if="canChallenge(entry.rank)"
            size="sm"
            variant="primary"
            :disabled="actionLoading"
            class="shrink-0"
            @click="handleChallenge(entry)"
          >
            {{ actionLoading ? '挑战中…' : '挑战' }}
          </AppButton>
          <span v-else-if="entry.rank === myInfo?.rank" class="text-xs text-state-arcane px-2 shrink-0">我</span>
          <span v-else class="text-xs text-fg-faint px-2 shrink-0">超出范围</span>
        </div>
      </div>
    </div>

    <!-- ===== Tab 2: 我的封神 ===== -->
    <div v-else-if="activeTab === 'my'" class="space-y-3">
      <!-- 个人信息卡 -->
      <PanelCard>
        <div class="grid grid-cols-2 md:grid-cols-4 gap-3 text-center">
          <div>
            <div class="text-xs text-fg-faint">排名</div>
            <div class="text-lg font-bold text-state-arcane num">{{ myInfo?.rank || '未上榜' }}</div>
          </div>
          <div>
            <div class="text-xs text-fg-faint">封神积分</div>
            <div class="text-lg font-bold text-gold-400 num">{{ myInfo?.fengshen_score || 0 }}</div>
          </div>
          <div>
            <div class="text-xs text-fg-faint">胜率</div>
            <div class="text-lg font-bold text-state-success num">{{ myInfo?.win_rate || 0 }}%</div>
          </div>
          <div>
            <div class="text-xs text-fg-faint">赛季</div>
            <div class="text-lg font-bold text-fg-secondary num">第{{ myInfo?.season || 1 }}届</div>
          </div>
        </div>
        <div class="grid grid-cols-3 gap-3 text-center mt-3 pt-3 border-t border-line">
          <div>
            <div class="text-xs text-fg-faint">累计胜利</div>
            <div class="text-sm font-bold text-state-success num">{{ myInfo?.total_wins || 0 }}</div>
          </div>
          <div>
            <div class="text-xs text-fg-faint">累计失败</div>
            <div class="text-sm font-bold text-state-danger num">{{ myInfo?.total_losses || 0 }}</div>
          </div>
          <div>
            <div class="text-xs text-fg-faint">今日剩余</div>
            <div class="text-sm font-bold text-gold-400 num">{{ myInfo?.daily_challenge_remaining ?? 5 }} / {{ myInfo?.daily_challenge_count ?? 0 + (myInfo?.daily_challenge_remaining ?? 5) }}</div>
          </div>
        </div>
      </PanelCard>

      <!-- 防守阵容 -->
      <PanelCard title="防守阵容">
        <div v-if="defenseInfo?.has_defense && defenseInfo.snapshot">
          <div class="grid grid-cols-2 md:grid-cols-3 gap-2 text-sm mb-3">
            <div class="bg-surface-raised border border-line rounded-control px-2 py-1">
              <span class="text-xs text-fg-faint">攻击</span>
              <span class="text-fg-primary ml-1 num">{{ formatCompact(defenseInfo.snapshot.atk) }}</span>
            </div>
            <div class="bg-surface-raised border border-line rounded-control px-2 py-1">
              <span class="text-xs text-fg-faint">防御</span>
              <span class="text-fg-primary ml-1 num">{{ formatCompact(defenseInfo.snapshot.def) }}</span>
            </div>
            <div class="bg-surface-raised border border-line rounded-control px-2 py-1">
              <span class="text-xs text-fg-faint">速度</span>
              <span class="text-fg-primary ml-1 num">{{ formatCompact(defenseInfo.snapshot.speed) }}</span>
            </div>
            <div class="bg-surface-raised border border-line rounded-control px-2 py-1">
              <span class="text-xs text-fg-faint">气血上限</span>
              <span class="text-fg-primary ml-1 num">{{ formatCompact(defenseInfo.snapshot.hp_max) }}</span>
            </div>
            <div class="bg-surface-raised border border-line rounded-control px-2 py-1">
              <span class="text-xs text-fg-faint">境界</span>
              <span class="text-fg-primary ml-1">{{ defenseInfo.snapshot.realm }}</span>
            </div>
            <div class="bg-surface-raised border border-line rounded-control px-2 py-1">
              <span class="text-xs text-fg-faint">设置时间</span>
              <span class="text-fg-secondary ml-1 text-xs num">{{ formatTime(defenseInfo.defense_set_at) }}</span>
            </div>
          </div>
          <div class="text-xs text-fg-faint mb-3">
            防守阵容使用设置时的属性快照参与战斗，更新装备/境界后需重新设置以刷新快照
          </div>
          <AppButton size="sm" variant="primary" :disabled="actionLoading" @click="handleSetDefense">
            {{ actionLoading ? '设置中…' : '刷新防守阵容' }}
          </AppButton>
        </div>
        <div v-else class="text-center py-4">
          <p class="text-fg-muted text-sm mb-3">尚未设置防守阵容，无法上榜被挑战</p>
          <AppButton size="sm" variant="primary" :disabled="actionLoading" @click="handleSetDefense">
            {{ actionLoading ? '设置中…' : '设置防守阵容' }}
          </AppButton>
        </div>
      </PanelCard>
    </div>

    <!-- ===== Tab 3: 赛季信息 ===== -->
    <div v-else-if="activeTab === 'season'">
      <div v-if="seasonInfo" class="space-y-3">
        <!-- 赛季时间 -->
        <PanelCard title="赛季信息">
          <div class="grid grid-cols-2 gap-3 text-sm">
            <div>
              <span class="text-xs text-fg-faint">当前赛季</span>
              <p class="text-fg-primary num">第 {{ seasonInfo.current_season }} 届</p>
            </div>
            <div>
              <span class="text-xs text-fg-faint">剩余天数</span>
              <p class="text-gold-400 font-bold num">{{ seasonInfo.remaining_days }} 天</p>
            </div>
            <div>
              <span class="text-xs text-fg-faint">开始时间</span>
              <p class="text-fg-secondary text-xs num">{{ formatTime(seasonInfo.season_start) }}</p>
            </div>
            <div>
              <span class="text-xs text-fg-faint">结束时间</span>
              <p class="text-fg-secondary text-xs num">{{ formatTime(seasonInfo.season_end) }}</p>
            </div>
          </div>
        </PanelCard>

        <!-- 奖励规则 -->
        <PanelCard title="赛季奖励">
          <div class="space-y-2">
            <div
              v-for="(rank, idx) in seasonInfo.top_ranks"
              :key="rank"
              class="flex items-center justify-between bg-surface-raised border border-line rounded-control px-3 py-2"
            >
              <div class="flex items-center gap-2">
                <div
                  class="w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold num"
                  :class="getRankBadgeClass(rank)"
                >
                  {{ rank }}
                </div>
                <span class="text-sm text-fg-primary">第 <span class="num">{{ rank }}</span> 名</span>
              </div>
              <div class="flex gap-4 text-sm">
                <span class="text-gold-400 num">{{ formatCompact(seasonInfo.rank_reward_honor[idx] || 0) }} 荣誉</span>
                <span class="text-state-success num">{{ formatCompact(seasonInfo.rank_reward_stones[idx] || 0) }} 灵石</span>
              </div>
            </div>
          </div>
          <p class="text-xs text-fg-faint mt-3">
            赛季结束后自动结算，奖励发放至 Top <span class="num">{{ seasonInfo.top_ranks.join('/') }}</span> 名，积分重置为初始值
          </p>
        </PanelCard>
      </div>
      <LoadingBlock v-else />
    </div>

    <!-- 挑战确认弹窗 -->
    <Modal :isOpen="challengeConfirmShow" title="确认挑战" @close="challengeConfirmShow = false">
      <div class="space-y-2 text-sm text-fg-secondary">
        <p>确认挑战以下道友？</p>
        <div v-if="pendingChallenge" class="bg-surface-hover border border-line rounded-panel p-3 mt-2">
          <div>排名：<span class="text-state-arcane font-bold num">第 {{ pendingChallenge.rank }} 名</span></div>
          <div>道友：<span class="text-fg-primary font-bold">{{ pendingChallenge.nickname }}</span></div>
          <div>境界：<span class="text-fg-secondary">{{ pendingChallenge.realm }}</span></div>
          <div>积分：<span class="text-gold-400 num">{{ pendingChallenge.fengshen_score }}</span></div>
          <div class="text-xs text-fg-faint mt-1">胜利交换排名 +<span class="num">30</span> 积分，失败 -<span class="num">20</span> 积分</div>
        </div>
      </div>
      <template #footer>
        <AppButton size="sm" variant="outline" @click="challengeConfirmShow = false">取消</AppButton>
        <AppButton size="sm" variant="primary" @click="confirmChallenge">确认挑战</AppButton>
      </template>
    </Modal>

    <!-- 挑战结果弹窗 -->
    <Modal :isOpen="challengeResultShow" title="战斗结果" @close="challengeResultShow = false">
      <div v-if="challengeResult" class="space-y-3 text-sm text-fg-secondary">
        <div class="text-center py-2">
          <div class="text-2xl font-display font-bold mb-2">{{ challengeResult.battle_result.attacker_wins ? '胜利' : '失败' }}</div>
          <div :class="challengeResult.battle_result.attacker_wins ? 'text-state-success' : 'text-state-danger'">
            {{ challengeResult.battle_result.attacker_wins ? '排名已交换！' : '排名未变动' }}
          </div>
        </div>
        <div class="bg-surface-hover border border-line rounded-panel p-3 space-y-1">
          <div>我的战力：<span class="text-fg-primary num">{{ formatCompact(challengeResult.battle_result.attacker_power) }}</span></div>
          <div>对手战力：<span class="text-fg-primary num">{{ formatCompact(challengeResult.battle_result.defender_power) }}</span></div>
          <div>积分变化：<span :class="challengeResult.battle_result.attacker_score_change >= 0 ? 'text-state-success' : 'text-state-danger'" class="num">
            {{ challengeResult.battle_result.attacker_score_change >= 0 ? '+' : '' }}{{ challengeResult.battle_result.attacker_score_change }}
          </span></div>
          <div>当前排名：<span class="text-state-arcane font-bold num">第 {{ challengeResult.my_rank }} 名</span></div>
          <div>当前积分：<span class="text-gold-400 font-bold num">{{ challengeResult.my_score }}</span></div>
          <div>剩余挑战：<span class="text-fg-primary num">{{ challengeResult.daily_challenge_remaining }} 次</span></div>
        </div>
      </div>
      <template #footer>
        <AppButton size="sm" variant="primary" @click="challengeResultShow = false">确定</AppButton>
      </template>
    </Modal>
  </PanelShell>
</template>

<script setup>
/**
 * 封神台面板逻辑
 *
 * 响应式状态管理：
 *   - activeTab：当前激活的 Tab
 *   - rankingList/myInfo/defenseInfo/seasonInfo：各 Tab 数据
 *   - actionLoading：操作中状态（防止重复提交）
 *   - challengeConfirmShow/challengeResultShow：弹窗状态
 *   - pendingChallenge/challengeResult：弹窗数据
 *
 * 方法：
 *   - switchTab：切换 Tab 并按需加载数据
 *   - loadRanking/loadMyInfo/loadDefense/loadSeasonInfo：数据加载
 *   - canChallenge：判断目标排名是否可挑战
 *   - handleChallenge/confirmChallenge：挑战流程（二次确认→调用接口→展示结果）
 *   - handleSetDefense：设置/刷新防守阵容
 *   - getRankBadgeClass：排名徽章样式
 *   - formatTime：时间格式化
 */
import { ref, onMounted } from 'vue';
import { formatBeijing } from '../../utils/time';
import { formatCompact } from '../../utils/format';
import Modal from '../common/Modal.vue';
import PanelShell from '../ui/PanelShell.vue';
import Tabs from '../ui/Tabs.vue';
import AppButton from '../ui/AppButton.vue';
import Badge from '../ui/Badge.vue';
import PanelCard from '../ui/PanelCard.vue';
import EmptyState from '../ui/EmptyState.vue';
import LoadingBlock from '../ui/LoadingBlock.vue';
import {
  getRanking, getMyRanking, getDefense, setDefense,
  challengeRank, getSeasonInfo
} from '../../api/fengshen';

// ===== Tab 定义（key/label 契约见 ui/Tabs.vue）=====
const tabItems = [
  { key: 'ranking', label: '排行榜' },
  { key: 'my', label: '我的封神' },
  { key: 'season', label: '赛季信息' }
];
const activeTab = ref('ranking');

// ===== 响应式状态 =====
const rankingLoading = ref(false);
const rankingList = ref([]);
const myInfo = ref(null);
const defenseInfo = ref(null);
const seasonInfo = ref(null);
const actionLoading = ref(false);

// 挑战弹窗状态
const challengeConfirmShow = ref(false);
const challengeResultShow = ref(false);
const pendingChallenge = ref(null);
const challengeResult = ref(null);

// ===== 方法 =====

/**
 * 切换 Tab，按需加载数据
 */
function switchTab(tabId) {
  activeTab.value = tabId;
  if (tabId === 'ranking' && rankingList.value.length === 0) {
    loadRanking();
  } else if (tabId === 'my' && !myInfo.value) {
    loadMyInfo();
    loadDefense();
  } else if (tabId === 'season' && !seasonInfo.value) {
    loadSeasonInfo();
  }
}

/**
 * 加载排行榜数据
 */
async function loadRanking() {
  rankingLoading.value = true;
  try {
    const res = await getRanking(1, 20);
    // 后端统一包了 { code, data }，业务字段在 data 里
    const payload = res.data.data || {};
    rankingList.value = payload.list || [];
    // 同步更新 myInfo 中的排名和积分
    if (payload.my_rank !== undefined) {
      if (!myInfo.value) myInfo.value = {};
      myInfo.value.rank = payload.my_rank;
      myInfo.value.fengshen_score = payload.my_score;
    }
  } catch (e) {
    console.error('[封神台] 加载排行榜失败:', e);
  } finally {
    rankingLoading.value = false;
  }
}

/**
 * 加载我的封神台信息
 */
async function loadMyInfo() {
  try {
    const res = await getMyRanking();
    myInfo.value = res.data.data;
  } catch (e) {
    console.error('[封神台] 加载我的信息失败:', e);
  }
}

/**
 * 加载防守阵容
 */
async function loadDefense() {
  try {
    const res = await getDefense();
    defenseInfo.value = res.data.data;
  } catch (e) {
    console.error('[封神台] 加载防守阵容失败:', e);
  }
}

/**
 * 加载赛季信息
 */
async function loadSeasonInfo() {
  try {
    const res = await getSeasonInfo();
    seasonInfo.value = res.data.data;
  } catch (e) {
    console.error('[封神台] 加载赛季信息失败:', e);
  }
}

/**
 * 判断目标排名是否可挑战
 * 可挑战条件：已上榜 + 目标排名比自己高 + 在 challenge_rank_range 范围内
 * @param {number} targetRank - 目标排名
 * @returns {boolean} 是否可挑战
 */
function canChallenge(targetRank) {
  if (!myInfo.value || myInfo.value.rank <= 0) return false;
  if (myInfo.value.daily_challenge_remaining <= 0) return false;
  const myRank = myInfo.value.rank;
  // 目标排名必须比自己高（排名数字更小），且差距不超过 5
  return targetRank < myRank && (myRank - targetRank) <= 5;
}

/**
 * 点击挑战按钮，弹出确认弹窗
 * @param {Object} entry - 排行榜条目
 */
function handleChallenge(entry) {
  pendingChallenge.value = entry;
  challengeConfirmShow.value = true;
}

/**
 * 确认挑战，调用接口并展示结果
 */
async function confirmChallenge() {
  if (!pendingChallenge.value) return;
  challengeConfirmShow.value = false;
  actionLoading.value = true;
  try {
    const res = await challengeRank(pendingChallenge.value.rank);
    challengeResult.value = res.data.data;
    challengeResultShow.value = true;
    // 刷新排行榜和我的信息
    await Promise.all([loadRanking(), loadMyInfo()]);
  } catch (e) {
    console.error('[封神台] 挑战失败:', e);
    alert(e?.response?.data?.message || '挑战失败，请稍后重试');
  } finally {
    actionLoading.value = false;
  }
}

/**
 * 设置/刷新防守阵容
 */
async function handleSetDefense() {
  actionLoading.value = true;
  try {
    await setDefense({});
    await Promise.all([loadMyInfo(), loadDefense(), loadRanking()]);
  } catch (e) {
    console.error('[封神台] 设置防守阵容失败:', e);
    alert(e?.response?.data?.message || '设置失败，请稍后重试');
  } finally {
    actionLoading.value = false;
  }
}

/**
 * 获取排名徽章样式
 * @param {number} rank - 排名
 * @returns {string} CSS 类名
 */
function getRankBadgeClass(rank) {
  if (rank === 1) return 'bg-gold-500/20 text-gold-400 border border-gold-700/50';
  if (rank === 2) return 'bg-surface-active text-fg-secondary border border-line-strong';
  if (rank === 3) return 'bg-gold-800/25 text-gold-600 border border-gold-800/60';
  return 'bg-surface-sunken text-fg-muted border border-line';
}

/**
 * 格式化时间
 * @param {string} isoStr - ISO 时间字符串
 * @returns {string} 格式化后的时间
 */
function formatTime(isoStr) {
  // 统一按北京时间展示（固定 UTC+8）
  return formatBeijing(isoStr, { seconds: false, fallback: '—' });
}

// ===== 生命周期 =====
onMounted(() => {
  loadRanking();
  loadMyInfo();
});
</script>

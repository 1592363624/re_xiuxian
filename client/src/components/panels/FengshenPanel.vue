/**
 * 封神台面板组件（PVP 镜像排名竞技场）
 *
 * 弹窗式组件，展示封神台赛季制排名竞技玩法：
 *   Tab 1: 排行榜 — 查看排名列表 + 挑战按钮
 *   Tab 2: 我的封神 — 个人排名/积分/胜负/防守阵容设置
 *   Tab 3: 赛季信息 — 赛季时间/奖励规则
 *
 * 设计原则：
 *   - 所有业务逻辑在后端，前端仅做展示与接口调用
 *   - 禁用浏览器原生 alert/confirm，使用自定义 Modal 二次确认
 *   - 颜色风格：封神台用紫金双色系（purple/amber），彰显竞技荣耀感
 *
 * 数据来源：
 *   - getRanking() / challengeRank() — 排行榜与挑战
 *   - getMyRanking() / getDefense() / setDefense() — 个人信息与防守
 *   - getSeasonInfo() — 赛季信息
 */
<template>
  <div class="fixed inset-0 z-50 flex items-center justify-center">
    <!-- 遮罩层 -->
    <div class="absolute inset-0 bg-black/80 backdrop-blur-sm" @click="$emit('close')"></div>

    <!-- 主面板 -->
    <div class="relative bg-[#1c1917] border border-purple-900/40 rounded-lg p-6 max-w-3xl w-full mx-4 shadow-2xl shadow-purple-900/20 animate-fade-in max-h-[88vh] flex flex-col">
      <!-- 标题栏 -->
      <div class="flex items-center justify-between mb-4">
        <h2 class="text-xl font-bold text-purple-400 flex items-center gap-2">
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/>
            <path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/>
            <path d="M4 22h16"/>
            <path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/>
            <path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/>
            <path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/>
          </svg>
          封神台
        </h2>
        <button @click="$emit('close')" class="text-stone-500 hover:text-white transition-colors">
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
        </button>
      </div>

      <!-- Tab 切换栏 -->
      <div class="flex gap-2 mb-4 border-b border-stone-700 pb-2">
        <button
          v-for="tab in tabs"
          :key="tab.id"
          @click="switchTab(tab.id)"
          :class="activeTab === tab.id
            ? 'text-purple-400 border-b-2 border-purple-400'
            : 'text-stone-400 hover:text-stone-200 border-b-2 border-transparent'"
          class="px-3 py-1 text-sm font-medium transition-colors"
        >
          {{ tab.label }}
        </button>
      </div>

      <!-- 内容滚动区 -->
      <div class="flex-1 overflow-y-auto space-y-4 pr-1">
        <!-- ===== Tab 1: 排行榜 ===== -->
        <div v-if="activeTab === 'ranking'">
          <!-- 我的排名摘要 -->
          <div class="bg-purple-950/20 border border-purple-800/40 rounded-lg p-3 mb-3">
            <div class="flex items-center justify-between">
              <div>
                <span class="text-xs text-stone-400">我的排名</span>
                <span class="text-lg font-bold text-purple-300 ml-2">{{ myInfo?.rank || '未上榜' }}</span>
              </div>
              <div>
                <span class="text-xs text-stone-400">封神积分</span>
                <span class="text-lg font-bold text-amber-400 ml-2">{{ myInfo?.fengshen_score || 0 }}</span>
              </div>
              <div>
                <span class="text-xs text-stone-400">剩余挑战</span>
                <span class="text-lg font-bold text-emerald-400 ml-2">{{ myInfo?.daily_challenge_remaining ?? 5 }}</span>
              </div>
            </div>
          </div>

          <!-- 排行榜列表 -->
          <div v-if="rankingLoading" class="text-center text-stone-500 py-6">加载中...</div>
          <div v-else-if="rankingList.length === 0" class="text-center text-stone-500 py-6">
            <p>暂无排名数据</p>
            <p class="text-xs mt-1">设置防守阵容即可上榜</p>
          </div>
          <div v-else class="space-y-2">
            <div
              v-for="entry in rankingList"
              :key="entry.player_id"
              class="bg-[#292524] border rounded-lg p-3 flex items-center justify-between transition-colors"
              :class="entry.rank === myInfo?.rank ? 'border-purple-600/50' : 'border-stone-700 hover:border-purple-800/50'"
            >
              <div class="flex items-center gap-3">
                <!-- 排名徽章 -->
                <div
                  class="w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold"
                  :class="getRankBadgeClass(entry.rank)"
                >
                  {{ entry.rank }}
                </div>
                <div>
                  <div class="flex items-center gap-2">
                    <span class="text-sm font-bold text-stone-200">{{ entry.nickname }}</span>
                    <span class="text-xs text-stone-400">{{ entry.realm }}</span>
                  </div>
                  <div class="flex gap-3 text-xs text-stone-500 mt-0.5">
                    <span>积分 <span class="text-amber-400">{{ entry.fengshen_score }}</span></span>
                    <span>胜率 <span class="text-emerald-400">{{ entry.win_rate }}%</span></span>
                    <span>{{ entry.total_wins }}胜 {{ entry.total_losses }}败</span>
                  </div>
                </div>
              </div>
              <!-- 挑战按钮 -->
              <button
                v-if="canChallenge(entry.rank)"
                @click="handleChallenge(entry)"
                :disabled="actionLoading"
                class="px-3 py-1 text-xs bg-purple-900/40 text-purple-300 border border-purple-700/50 rounded hover:bg-purple-800/50 transition-colors disabled:opacity-50 shrink-0"
              >
                {{ actionLoading ? '挑战中...' : '挑战' }}
              </button>
              <span v-else-if="entry.rank === myInfo?.rank" class="text-xs text-purple-400 px-3">我</span>
              <span v-else class="text-xs text-stone-600 px-3">超出范围</span>
            </div>
          </div>
        </div>

        <!-- ===== Tab 2: 我的封神 ===== -->
        <div v-else-if="activeTab === 'my'">
          <!-- 个人信息卡 -->
          <div class="bg-[#292524] border border-stone-700 rounded-lg p-4 mb-3">
            <div class="grid grid-cols-2 md:grid-cols-4 gap-3 text-center">
              <div>
                <div class="text-xs text-stone-500">排名</div>
                <div class="text-lg font-bold text-purple-300">{{ myInfo?.rank || '未上榜' }}</div>
              </div>
              <div>
                <div class="text-xs text-stone-500">封神积分</div>
                <div class="text-lg font-bold text-amber-400">{{ myInfo?.fengshen_score || 0 }}</div>
              </div>
              <div>
                <div class="text-xs text-stone-500">胜率</div>
                <div class="text-lg font-bold text-emerald-400">{{ myInfo?.win_rate || 0 }}%</div>
              </div>
              <div>
                <div class="text-xs text-stone-500">赛季</div>
                <div class="text-lg font-bold text-stone-300">第{{ myInfo?.season || 1 }}届</div>
              </div>
            </div>
            <div class="grid grid-cols-3 gap-3 text-center mt-3 pt-3 border-t border-stone-700">
              <div>
                <div class="text-xs text-stone-500">累计胜利</div>
                <div class="text-sm font-bold text-emerald-400">{{ myInfo?.total_wins || 0 }}</div>
              </div>
              <div>
                <div class="text-xs text-stone-500">累计失败</div>
                <div class="text-sm font-bold text-rose-400">{{ myInfo?.total_losses || 0 }}</div>
              </div>
              <div>
                <div class="text-xs text-stone-500">今日剩余</div>
                <div class="text-sm font-bold text-amber-400">{{ myInfo?.daily_challenge_remaining ?? 5 }} / {{ myInfo?.daily_challenge_count ?? 0 + (myInfo?.daily_challenge_remaining ?? 5) }}</div>
              </div>
            </div>
          </div>

          <!-- 防守阵容 -->
          <div class="bg-[#292524] border border-stone-700 rounded-lg p-4">
            <h3 class="text-sm font-bold text-purple-300 mb-3">🛡️ 防守阵容</h3>
            <div v-if="defenseInfo?.has_defense && defenseInfo.snapshot">
              <div class="grid grid-cols-2 md:grid-cols-3 gap-2 text-sm mb-3">
                <div class="bg-[#1c1917] border border-stone-700 rounded px-2 py-1">
                  <span class="text-xs text-stone-500">攻击</span>
                  <span class="text-stone-200 ml-1">{{ defenseInfo.snapshot.atk.toLocaleString() }}</span>
                </div>
                <div class="bg-[#1c1917] border border-stone-700 rounded px-2 py-1">
                  <span class="text-xs text-stone-500">防御</span>
                  <span class="text-stone-200 ml-1">{{ defenseInfo.snapshot.def.toLocaleString() }}</span>
                </div>
                <div class="bg-[#1c1917] border border-stone-700 rounded px-2 py-1">
                  <span class="text-xs text-stone-500">速度</span>
                  <span class="text-stone-200 ml-1">{{ defenseInfo.snapshot.speed.toLocaleString() }}</span>
                </div>
                <div class="bg-[#1c1917] border border-stone-700 rounded px-2 py-1">
                  <span class="text-xs text-stone-500">气血上限</span>
                  <span class="text-stone-200 ml-1">{{ defenseInfo.snapshot.hp_max.toLocaleString() }}</span>
                </div>
                <div class="bg-[#1c1917] border border-stone-700 rounded px-2 py-1">
                  <span class="text-xs text-stone-500">境界</span>
                  <span class="text-stone-200 ml-1">{{ defenseInfo.snapshot.realm }}</span>
                </div>
                <div class="bg-[#1c1917] border border-stone-700 rounded px-2 py-1">
                  <span class="text-xs text-stone-500">设置时间</span>
                  <span class="text-stone-200 ml-1 text-xs">{{ formatTime(defenseInfo.defense_set_at) }}</span>
                </div>
              </div>
              <div class="text-xs text-stone-500 mb-3">
                💡 防守阵容使用设置时的属性快照参与战斗，更新装备/境界后需重新设置以刷新快照
              </div>
              <button
                @click="handleSetDefense"
                :disabled="actionLoading"
                class="px-4 py-2 text-sm bg-purple-900/40 text-purple-300 border border-purple-700/50 rounded hover:bg-purple-800/50 transition-colors disabled:opacity-50"
              >
                {{ actionLoading ? '设置中...' : '刷新防守阵容' }}
              </button>
            </div>
            <div v-else class="text-center py-4">
              <p class="text-stone-400 text-sm mb-3">尚未设置防守阵容，无法上榜被挑战</p>
              <button
                @click="handleSetDefense"
                :disabled="actionLoading"
                class="px-4 py-2 text-sm bg-purple-900/40 text-purple-300 border border-purple-700/50 rounded hover:bg-purple-800/50 transition-colors disabled:opacity-50"
              >
                {{ actionLoading ? '设置中...' : '设置防守阵容' }}
              </button>
            </div>
          </div>
        </div>

        <!-- ===== Tab 3: 赛季信息 ===== -->
        <div v-else-if="activeTab === 'season'">
          <div v-if="seasonInfo" class="space-y-3">
            <!-- 赛季时间 -->
            <div class="bg-[#292524] border border-stone-700 rounded-lg p-4">
              <h3 class="text-sm font-bold text-purple-300 mb-3">📅 赛季信息</h3>
              <div class="grid grid-cols-2 gap-3 text-sm">
                <div>
                  <span class="text-xs text-stone-500">当前赛季</span>
                  <p class="text-stone-200">第 {{ seasonInfo.current_season }} 届</p>
                </div>
                <div>
                  <span class="text-xs text-stone-500">剩余天数</span>
                  <p class="text-amber-400 font-bold">{{ seasonInfo.remaining_days }} 天</p>
                </div>
                <div>
                  <span class="text-xs text-stone-500">开始时间</span>
                  <p class="text-stone-300 text-xs">{{ formatTime(seasonInfo.season_start) }}</p>
                </div>
                <div>
                  <span class="text-xs text-stone-500">结束时间</span>
                  <p class="text-stone-300 text-xs">{{ formatTime(seasonInfo.season_end) }}</p>
                </div>
              </div>
            </div>

            <!-- 奖励规则 -->
            <div class="bg-[#292524] border border-stone-700 rounded-lg p-4">
              <h3 class="text-sm font-bold text-amber-300 mb-3">🏆 赛季奖励</h3>
              <div class="space-y-2">
                <div
                  v-for="(rank, idx) in seasonInfo.top_ranks"
                  :key="rank"
                  class="flex items-center justify-between bg-[#1c1917] border border-stone-700 rounded px-3 py-2"
                >
                  <div class="flex items-center gap-2">
                    <div
                      class="w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold"
                      :class="getRankBadgeClass(rank)"
                    >
                      {{ rank }}
                    </div>
                    <span class="text-sm text-stone-200">第 {{ rank }} 名</span>
                  </div>
                  <div class="flex gap-4 text-sm">
                    <span class="text-amber-400">{{ (seasonInfo.rank_reward_honor[idx] || 0).toLocaleString() }} 荣誉</span>
                    <span class="text-emerald-400">{{ (seasonInfo.rank_reward_stones[idx] || 0).toLocaleString() }} 灵石</span>
                  </div>
                </div>
              </div>
              <p class="text-xs text-stone-500 mt-3">
                💡 赛季结束后自动结算，奖励发放至Top {{ seasonInfo.top_ranks.join('/') }} 名，积分重置为初始值
              </p>
            </div>
          </div>
          <div v-else class="text-center text-stone-500 py-6">加载中...</div>
        </div>
      </div>

      <!-- 挑战确认弹窗 -->
      <Modal :isOpen="challengeConfirmShow" title="确认挑战" @close="challengeConfirmShow = false">
        <div class="space-y-2 text-sm text-stone-300">
          <p>确认挑战以下道友？</p>
          <div v-if="pendingChallenge" class="bg-[#292524] border border-stone-700 rounded p-3 mt-2">
            <div>排名：<span class="text-purple-300 font-bold">第 {{ pendingChallenge.rank }} 名</span></div>
            <div>道友：<span class="text-stone-200 font-bold">{{ pendingChallenge.nickname }}</span></div>
            <div>境界：<span class="text-stone-300">{{ pendingChallenge.realm }}</span></div>
            <div>积分：<span class="text-amber-400">{{ pendingChallenge.fengshen_score }}</span></div>
            <div class="text-xs text-stone-500 mt-1">胜利交换排名 +30 积分，失败 -20 积分</div>
          </div>
        </div>
        <template #footer>
          <button @click="challengeConfirmShow = false" class="px-4 py-2 text-sm border border-stone-700 text-stone-300 rounded hover:bg-stone-800 transition-colors">取消</button>
          <button @click="confirmChallenge" class="px-4 py-2 text-sm bg-purple-900/50 text-purple-300 border border-purple-700/50 rounded hover:bg-purple-800/60 transition-colors">确认挑战</button>
        </template>
      </Modal>

      <!-- 挑战结果弹窗 -->
      <Modal :isOpen="challengeResultShow" title="战斗结果" @close="challengeResultShow = false">
        <div v-if="challengeResult" class="space-y-3 text-sm text-stone-300">
          <div class="text-center py-2">
            <div class="text-3xl mb-2">{{ challengeResult.battle_result.attacker_wins ? '⚔️ 胜利' : '💀 失败' }}</div>
            <div :class="challengeResult.battle_result.attacker_wins ? 'text-emerald-400' : 'text-rose-400'">
              {{ challengeResult.battle_result.attacker_wins ? '排名已交换！' : '排名未变动' }}
            </div>
          </div>
          <div class="bg-[#292524] border border-stone-700 rounded p-3 space-y-1">
            <div>我的战力：<span class="text-stone-200">{{ challengeResult.battle_result.attacker_power.toLocaleString() }}</span></div>
            <div>对手战力：<span class="text-stone-200">{{ challengeResult.battle_result.defender_power.toLocaleString() }}</span></div>
            <div>积分变化：<span :class="challengeResult.battle_result.attacker_score_change >= 0 ? 'text-emerald-400' : 'text-rose-400'">
              {{ challengeResult.battle_result.attacker_score_change >= 0 ? '+' : '' }}{{ challengeResult.battle_result.attacker_score_change }}
            </span></div>
            <div>当前排名：<span class="text-purple-300 font-bold">第 {{ challengeResult.my_rank }} 名</span></div>
            <div>当前积分：<span class="text-amber-400 font-bold">{{ challengeResult.my_score }}</span></div>
            <div>剩余挑战：<span class="text-stone-200">{{ challengeResult.daily_challenge_remaining }} 次</span></div>
          </div>
        </div>
        <template #footer>
          <button @click="challengeResultShow = false" class="px-4 py-2 text-sm bg-purple-900/50 text-purple-300 border border-purple-700/50 rounded hover:bg-purple-800/60 transition-colors">确定</button>
        </template>
      </Modal>
    </div>
  </div>
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
import Modal from '../common/Modal.vue';
import {
  getRanking, getMyRanking, getDefense, setDefense,
  challengeRank, getSeasonInfo
} from '../../api/fengshen';

// ===== Tab 定义 =====
const tabs = [
  { id: 'ranking', label: '排行榜' },
  { id: 'my', label: '我的封神' },
  { id: 'season', label: '赛季信息' }
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
    rankingList.value = res.data.list || [];
    // 同步更新 myInfo 中的排名和积分
    if (res.data.my_rank !== undefined) {
      if (!myInfo.value) myInfo.value = {};
      myInfo.value.rank = res.data.my_rank;
      myInfo.value.fengshen_score = res.data.my_score;
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
    myInfo.value = res.data;
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
    defenseInfo.value = res.data;
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
    seasonInfo.value = res.data;
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
    challengeResult.value = res.data;
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
  if (rank === 1) return 'bg-amber-500/20 text-amber-400 border border-amber-600/50';
  if (rank === 2) return 'bg-stone-400/20 text-stone-300 border border-stone-500/50';
  if (rank === 3) return 'bg-orange-700/20 text-orange-500 border border-orange-700/50';
  return 'bg-stone-800 text-stone-400 border border-stone-700';
}

/**
 * 格式化时间
 * @param {string} isoStr - ISO 时间字符串
 * @returns {string} 格式化后的时间
 */
function formatTime(isoStr) {
  if (!isoStr) return '—';
  const d = new Date(isoStr);
  if (isNaN(d.getTime())) return '—';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// ===== 生命周期 =====
onMounted(() => {
  loadRanking();
  loadMyInfo();
});
</script>

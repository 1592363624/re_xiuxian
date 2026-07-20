/**
 * 飞升灵界 + 夺舍重生 面板组件
 *
 * 批次3 高阶玩法综合面板，包含以下功能模块：
 *   1. 飞升面板：玩家基础信息、飞升档案、成功率估算、前置条件检查
 *   2. 空间节点：搜寻节点 → 定星稳固 → 获取逆灵通道坐标/法则碎片
 *   3. 问道：化神后期可解锁，每日3次/CD 30分钟，积累感悟值
 *   4. 法相天地：9级数值表，每级 5% 全属性加成 + 2% 飞升成功率加成
 *   5. 探寻裂缝：元婴初期可探寻，每日5次/CD 10分钟，15% 反噬概率
 *   6. 飞升尝试：满足前置后触发飞升，事务保证原子性
 *   7. 天机回溯：飞升失败后每日1次回溯机会
 *   8. 夺舍重生：飞升失败/寿命尽/PVP被杀时触发，3个目标按权重随机
 *
 * 设计原则：
 *   - 所有状态从后端 GET /ascension/profile 拉取，禁止硬编码
 *   - 业务逻辑全部在后端，前端仅做展示与接口调用
 *   - 禁用浏览器原生 alert/confirm，使用自定义 Modal 二次确认
 *   - 关键操作（飞升/夺舍）需二次确认
 */
<template>
  <div class="fixed inset-0 z-50 flex items-center justify-center">
    <!-- 遮罩层 -->
    <div class="absolute inset-0 bg-black/80 backdrop-blur-sm" @click="$emit('close')"></div>

    <!-- 主面板 -->
    <div class="relative bg-[#1c1917] border border-amber-900/40 rounded-lg p-6 max-w-4xl w-full mx-4 shadow-2xl animate-fade-in max-h-[90vh] flex flex-col">
      <!-- 标题栏 -->
      <div class="flex items-center justify-between mb-4">
        <h2 class="text-xl font-bold text-amber-300 flex items-center gap-2">
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 2l2.4 7.4H22l-6.2 4.5 2.4 7.4L12 16.8l-6.2 4.5 2.4-7.4L2 9.4h7.6z"/>
          </svg>
          飞升灵界 · 夺舍重生
        </h2>
        <button @click="$emit('close')" class="text-stone-500 hover:text-white transition-colors">
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
        </button>
      </div>

      <!-- 加载中状态 -->
      <div v-if="loading && !profile" class="flex-1 flex items-center justify-center">
        <div class="text-stone-500 text-sm">正在获取飞升档案...</div>
      </div>

      <!-- 状态总览栏 -->
      <div v-if="profile" class="bg-[#292524] border border-stone-700 rounded-lg p-3 mb-3 grid grid-cols-2 md:grid-cols-5 gap-3 text-xs">
        <div>
          <div class="text-stone-500">当前境界</div>
          <div class="text-amber-300 font-bold">{{ profile.player.realm }}</div>
        </div>
        <div>
          <div class="text-stone-500">残魂值</div>
          <div class="font-bold" :class="profile.player.remnant_soul < 50 ? 'text-rose-400' : 'text-emerald-400'">
            {{ profile.player.remnant_soul.toFixed(1) }} / 100
          </div>
        </div>
        <div>
          <div class="text-stone-500">神识</div>
          <div class="text-cyan-300 font-bold">{{ profile.player.divine_sense }}</div>
        </div>
        <div>
          <div class="text-stone-500">问道感悟</div>
          <div class="text-purple-300 font-bold">{{ profile.player.ask_dao_insight.toFixed(2) }}</div>
        </div>
        <div>
          <div class="text-stone-500">法相等级</div>
          <div class="text-pink-300 font-bold">
            {{ profile.player.dharma_form_level }} / 9
            <span class="text-stone-500 ml-1">(+{{ profile.player.dharma_form_level * 5 }}%)</span>
          </div>
        </div>
      </div>

      <!-- 飞升成功率与前置条件 -->
      <div v-if="profile" class="bg-[#292524] border border-stone-700 rounded-lg p-3 mb-3">
        <div class="flex items-center justify-between mb-2">
          <div class="text-xs text-stone-400">飞升成功率</div>
          <div class="text-lg font-bold" :class="profile.prerequisites.canAscend ? 'text-emerald-300' : 'text-amber-400'">
            {{ (profile.success_rate.final_rate * 100).toFixed(1) }}%
          </div>
        </div>
        <!-- 成功率进度条 -->
        <div class="h-2 bg-stone-800 rounded-full overflow-hidden mb-2">
          <div class="h-full bg-gradient-to-r from-amber-600 via-amber-400 to-emerald-400 transition-all duration-500"
            :style="{ width: `${Math.min(profile.success_rate.final_rate * 100, 100)}%` }"></div>
        </div>
        <!-- 前置条件清单 -->
        <div class="grid grid-cols-1 md:grid-cols-2 gap-1 mt-2">
          <div v-for="(reason, idx) in profile.prerequisites.reasons" :key="idx"
            class="text-[11px] text-rose-400 flex items-center gap-1">
            <span class="text-rose-500">✗</span>
            <span>{{ reason }}</span>
          </div>
          <div v-if="profile.prerequisites.canAscend" class="text-[11px] text-emerald-400 flex items-center gap-1">
            <span>✓</span>
            <span>所有前置条件已满足，可尝试飞升</span>
          </div>
        </div>
      </div>

      <!-- Tab 切换栏 -->
      <div v-if="profile" class="flex border-b border-stone-700 mb-3 overflow-x-auto">
        <button v-for="tab in tabs" :key="tab.id"
          @click="activeTab = tab.id"
          class="px-4 py-2 text-xs font-medium transition-colors whitespace-nowrap relative"
          :class="activeTab === tab.id ? 'text-amber-300' : 'text-stone-500 hover:text-stone-300'">
          {{ tab.name }}
          <div v-if="activeTab === tab.id" class="absolute bottom-0 left-0 w-full h-0.5 bg-amber-400"></div>
        </button>
      </div>

      <!-- 内容滚动区 -->
      <div v-if="profile" class="flex-1 overflow-y-auto pr-1">
        <!-- Tab 1: 飞升主面板 -->
        <div v-show="activeTab === 'ascension'" class="space-y-3">
          <!-- 飞升档案 -->
          <section class="bg-[#292524] border border-stone-700 rounded-lg p-4">
            <div class="text-sm font-bold text-amber-300 mb-2">飞升档案</div>
            <div class="grid grid-cols-2 md:grid-cols-3 gap-3 text-xs">
              <div>
                <div class="text-stone-500">飞升状态</div>
                <div class="font-bold" :class="getAscensionStateColor(profile.ascension.ascension_state)">
                  {{ getAscensionStateLabel(profile.ascension.ascension_state) }}
                </div>
              </div>
              <div>
                <div class="text-stone-500">大衍诀层数</div>
                <div class="text-purple-300 font-bold">{{ profile.ascension.dayan_level }} / 5</div>
              </div>
              <div>
                <div class="text-stone-500">法则碎片</div>
                <div class="text-cyan-300 font-bold">{{ profile.ascension.law_fragments_count }} / 5</div>
              </div>
              <div>
                <div class="text-stone-500">飞升尝试</div>
                <div class="text-stone-300 font-bold">{{ profile.ascension.ascension_attempt_count }} 次</div>
              </div>
              <div>
                <div class="text-stone-500">成功次数</div>
                <div class="text-emerald-300 font-bold">{{ profile.ascension.ascension_success_count }} 次</div>
              </div>
              <div>
                <div class="text-stone-500">回溯次数</div>
                <div class="text-amber-300 font-bold">{{ profile.ascension.revert_count }} 次</div>
              </div>
            </div>
          </section>

          <!-- 空间节点列表 -->
          <section class="bg-[#292524] border border-stone-700 rounded-lg p-4">
            <div class="flex items-center justify-between mb-3">
              <div class="text-sm font-bold text-cyan-300">空间节点</div>
              <button @click="handleSearchNode"
                :disabled="loading"
                class="text-xs px-3 py-1 rounded bg-cyan-950/40 border border-cyan-800 text-cyan-300 hover:bg-cyan-900/40 disabled:opacity-50 transition-colors">
                搜寻节点 (CD 1h)
              </button>
            </div>
            <div v-if="profile.nodes.length === 0" class="text-xs text-stone-500 text-center py-4">
              暂无空间节点，点击「搜寻节点」开始探索
            </div>
            <div v-else class="space-y-2">
              <div v-for="node in profile.nodes" :key="node.id"
                class="bg-stone-900/50 border border-stone-700 rounded p-2 text-xs">
                <div class="flex items-center justify-between">
                  <div>
                    <span class="text-amber-300 font-bold">{{ node.node_name }}</span>
                    <span class="ml-2 text-stone-500">{{ node.node_type }}</span>
                  </div>
                  <div class="text-[10px] px-2 py-0.5 rounded"
                    :class="getNodeStateClass(node.node_state)">
                    {{ getNodeStateLabel(node.node_state) }}
                  </div>
                </div>
                <div class="text-stone-400 mt-1">
                  奖励：<span class="text-emerald-300">{{ node.reward_type }} ×{{ node.reward_amount }}</span>
                </div>
                <div class="text-stone-500 text-[10px] mt-1">
                  发现：{{ formatTime(node.discovered_at) }}
                  <span v-if="node.stabilize_end_time">· 稳固结束：{{ formatTime(node.stabilize_end_time) }}</span>
                </div>
                <button v-if="node.node_state === 'discovered'"
                  @click="handleStabilizeNode(node.id)"
                  :disabled="loading"
                  class="mt-2 w-full py-1 text-[11px] rounded bg-amber-950/40 border border-amber-800 text-amber-300 hover:bg-amber-900/40 disabled:opacity-50 transition-colors">
                  定星稳固（消耗神识+灵石，30分钟）
                </button>
              </div>
            </div>
          </section>

          <!-- 飞升尝试 + 天机回溯 -->
          <section class="bg-[#292524] border border-stone-700 rounded-lg p-4">
            <div class="text-sm font-bold text-amber-300 mb-2">飞升尝试</div>
            <div class="text-xs text-stone-400 mb-3">
              飞升成功后将进入真仙境界，开启灵界新玩法。<br>
              失败将损失 30 残魂值、10% 修为，并进入 2 小时虚弱状态。
            </div>
            <div class="grid grid-cols-2 gap-2">
              <button @click="showAscendConfirm = true"
                :disabled="loading || !profile.prerequisites.canAscend"
                class="py-2 rounded-lg text-xs font-bold tracking-wider transition-all disabled:opacity-50 bg-gradient-to-r from-amber-900 to-amber-700 border border-amber-500 text-amber-100 hover:from-amber-800 hover:to-amber-600">
                {{ profile.prerequisites.canAscend ? '尝试飞升' : '前置未满足' }}
              </button>
              <button @click="handleRevert"
                :disabled="loading || profile.ascension.ascension_state !== 'failed'"
                class="py-2 rounded-lg text-xs font-bold tracking-wider transition-all disabled:opacity-50 bg-indigo-950/40 border border-indigo-800 text-indigo-300 hover:bg-indigo-900/40">
                天机回溯 (每日1次)
              </button>
            </div>
          </section>
        </div>

        <!-- Tab 2: 问道 -->
        <div v-show="activeTab === 'ask_dao'" class="space-y-3">
          <section class="bg-[#292524] border border-stone-700 rounded-lg p-4">
            <div class="flex items-center justify-between mb-3">
              <div>
                <div class="text-sm font-bold text-purple-300">向天道问道</div>
                <div class="text-[10px] text-stone-500">化神后期可解锁，积累感悟提升飞升成功率</div>
              </div>
              <button @click="handleAskDao"
                :disabled="loading"
                class="text-xs px-4 py-2 rounded bg-purple-950/40 border border-purple-800 text-purple-300 hover:bg-purple-900/40 disabled:opacity-50 transition-colors">
                问道
              </button>
            </div>
            <div class="text-xs text-stone-400 space-y-1">
              <div>· 每日 3 次，CD 30 分钟</div>
              <div>· 每次随机获得 1-10 点感悟值（10% 暴击双倍）</div>
              <div>· 每 10 点感悟值提供 1% 飞升成功率加成（上限 20%）</div>
              <div>· 当前感悟值：<span class="text-purple-300 font-bold">{{ profile.player.ask_dao_insight.toFixed(2) }}</span></div>
              <div>· 当前飞升加成：<span class="text-emerald-300 font-bold">+{{ (profile.success_rate.breakdown.ask_dao_bonus * 100).toFixed(1) }}%</span></div>
            </div>
          </section>
        </div>

        <!-- Tab 3: 法相天地 -->
        <div v-show="activeTab === 'dharma_form'" class="space-y-3">
          <section class="bg-[#292524] border border-stone-700 rounded-lg p-4">
            <div class="flex items-center justify-between mb-3">
              <div>
                <div class="text-sm font-bold text-pink-300">法相天地</div>
                <div class="text-[10px] text-stone-500">9级数值表，每级 5% 全属性加成 + 2% 飞升成功率加成</div>
              </div>
              <button @click="handleDharmaForm"
                :disabled="loading"
                class="text-xs px-4 py-2 rounded bg-pink-950/40 border border-pink-800 text-pink-300 hover:bg-pink-900/40 disabled:opacity-50 transition-colors">
                修炼法相
              </button>
            </div>
            <div class="text-xs text-stone-400 space-y-1">
              <div>· 当前法相等级：<span class="text-pink-300 font-bold">{{ profile.player.dharma_form_level }} / 9</span></div>
              <div>· 全属性加成：<span class="text-emerald-300 font-bold">+{{ profile.player.dharma_form_level * 5 }}%</span></div>
              <div>· 飞升成功率加成：<span class="text-emerald-300 font-bold">+{{ (profile.success_rate.breakdown.dharma_form_bonus * 100).toFixed(1) }}%</span></div>
              <div>· 修炼消耗：问道感悟 + 灵石（失败返还 30% 灵石）</div>
            </div>
          </section>
        </div>

        <!-- Tab 4: 探寻裂缝 -->
        <div v-show="activeTab === 'fracture'" class="space-y-3">
          <section class="bg-[#292524] border border-stone-700 rounded-lg p-4">
            <div class="flex items-center justify-between mb-3">
              <div>
                <div class="text-sm font-bold text-cyan-300">探寻虚空裂缝</div>
                <div class="text-[10px] text-stone-500">元婴初期可探寻，每日 5 次，CD 10 分钟</div>
              </div>
              <button @click="handleExploreFracture"
                :disabled="loading"
                class="text-xs px-4 py-2 rounded bg-cyan-950/40 border border-cyan-800 text-cyan-300 hover:bg-cyan-900/40 disabled:opacity-50 transition-colors">
                探寻裂缝
              </button>
            </div>
            <div class="text-xs text-stone-400 space-y-1">
              <div>· 每次消耗 50 神识 + 灵石</div>
              <div>· 15% 概率触发反噬（损失残魂）</div>
              <div>· 可获得法则碎片、稀有材料、丹方等</div>
              <div>· 当前神识：<span class="text-cyan-300 font-bold">{{ profile.player.divine_sense }}</span></div>
              <div>· 法则碎片：<span class="text-purple-300 font-bold">{{ profile.ascension.law_fragments_count }} / 5</span></div>
            </div>
          </section>
        </div>

        <!-- Tab 5: 夺舍重生 -->
        <div v-show="activeTab === 'reincarnation'" class="space-y-3">
          <section class="bg-[#292524] border border-stone-700 rounded-lg p-4">
            <div class="text-sm font-bold text-rose-300 mb-2">夺舍重生</div>
            <div class="text-xs text-stone-400 mb-3">
              飞升失败 / 寿元耗尽 / PVP 被杀 时可触发夺舍重生。<br>
              系统将推送 3 个目标供选择，选定后境界跌落但保留部分修为，残魂恢复至 50。<br>
              冷却时间 72 小时。
            </div>
            <div class="grid grid-cols-2 gap-2 mb-3">
              <button @click="showReincarnationTrigger = true"
                :disabled="loading || !profile.player.is_dead"
                class="py-2 rounded-lg text-xs font-bold tracking-wider transition-all disabled:opacity-50 bg-rose-950/40 border border-rose-800 text-rose-300 hover:bg-rose-900/40">
                {{ profile.player.is_dead ? '触发夺舍' : '未处死亡状态' }}
              </button>
              <button @click="loadReincarnationRecords"
                :disabled="loading"
                class="py-2 rounded-lg text-xs font-bold tracking-wider transition-all disabled:opacity-50 bg-stone-900/40 border border-stone-700 text-stone-300 hover:bg-stone-800/40">
                查看历史记录
              </button>
            </div>

            <!-- 夺舍目标列表 -->
            <div v-if="reincarnationTargets.length > 0" class="space-y-2 mt-3">
              <div class="text-xs text-stone-400 mb-2">可选目标（30 分钟内有效，超时将随机选定）：</div>
              <div v-for="target in reincarnationTargets" :key="target.target_id"
                class="bg-stone-900/50 border border-stone-700 rounded p-3 text-xs">
                <div class="flex items-center justify-between">
                  <div>
                    <span class="text-amber-300 font-bold">{{ target.target_name }}</span>
                    <span class="ml-2 text-stone-500">{{ target.target_type_display }}</span>
                    <span v-if="target.is_rare" class="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-amber-950/60 text-amber-300 border border-amber-700">稀有</span>
                  </div>
                  <div class="text-[10px] px-2 py-0.5 rounded"
                    :class="getRiskClass(target.risk_level)">
                    风险{{ target.risk_level }}
                  </div>
                </div>
                <div class="text-stone-400 mt-1">
                  <div>· 境界排名：{{ target.target_realm_rank }}</div>
                  <div>· 修为继承：{{ (target.inherit_ratio * 100).toFixed(0) }}%</div>
                  <div>· 境界跌落：{{ target.drop_realm_count }} 大境界</div>
                  <div>· 成功率：{{ (target.success_rate * 100).toFixed(0) }}%</div>
                  <div class="text-stone-500 mt-1">{{ target.description }}</div>
                </div>
                <button @click="handleChooseTarget(target.target_id)"
                  :disabled="loading"
                  class="mt-2 w-full py-1.5 text-[11px] rounded bg-rose-950/40 border border-rose-800 text-rose-300 hover:bg-rose-900/40 disabled:opacity-50 transition-colors">
                  选定此目标夺舍
                </button>
              </div>
            </div>

            <!-- 夺舍历史记录 -->
            <div v-if="reincarnationRecords.length > 0" class="mt-3">
              <div class="text-xs text-stone-400 mb-2">历史记录：</div>
              <div class="space-y-1 max-h-40 overflow-y-auto">
                <div v-for="record in reincarnationRecords" :key="record.id"
                  class="bg-stone-900/30 border border-stone-800 rounded p-2 text-[11px]">
                  <div class="flex items-center justify-between">
                    <span class="text-stone-300">{{ formatTime(record.reincarnated_at) }}</span>
                    <span :class="record.is_success ? 'text-emerald-400' : 'text-rose-400'">
                      {{ record.is_success ? '成功' : '失败' }}
                    </span>
                  </div>
                  <div class="text-stone-500 mt-1">
                    {{ record.origin_realm }} → {{ record.new_realm }} · 目标：{{ record.target_name }}
                  </div>
                </div>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>

    <!-- 飞升二次确认弹窗 -->
    <div v-if="showAscendConfirm" class="fixed inset-0 z-[60] flex items-center justify-center">
      <div class="absolute inset-0 bg-black/80" @click="showAscendConfirm = false"></div>
      <div class="relative bg-[#1c1917] border border-amber-700 rounded-lg p-6 max-w-md w-full mx-4 shadow-2xl">
        <h3 class="text-lg font-bold text-amber-300 mb-2">飞升确认</h3>
        <p class="text-stone-300 text-sm mb-4">
          当前成功率：<span class="text-amber-300 font-bold">{{ (profile?.success_rate.final_rate * 100).toFixed(1) }}%</span><br>
          成功：飞升灵界，进入真仙境界。<br>
          失败：残魂 -30，修为 -10%，进入 2 小时虚弱状态。
        </p>
        <div class="flex justify-end gap-2">
          <button @click="showAscendConfirm = false"
            class="px-4 py-2 text-xs rounded bg-stone-800 text-stone-300 hover:bg-stone-700">取消</button>
          <button @click="handleAscend"
            :disabled="loading"
            class="px-4 py-2 text-xs rounded bg-amber-700 text-amber-100 hover:bg-amber-600 disabled:opacity-50">
            {{ loading ? '飞升中...' : '确认飞升' }}
          </button>
        </div>
      </div>
    </div>

    <!-- 触发夺舍二次确认弹窗 -->
    <div v-if="showReincarnationTrigger" class="fixed inset-0 z-[60] flex items-center justify-center">
      <div class="absolute inset-0 bg-black/80" @click="showReincarnationTrigger = false"></div>
      <div class="relative bg-[#1c1917] border border-rose-700 rounded-lg p-6 max-w-md w-full mx-4 shadow-2xl">
        <h3 class="text-lg font-bold text-rose-300 mb-2">触发夺舍重生</h3>
        <p class="text-stone-300 text-sm mb-3">请选择死亡原因：</p>
        <div class="space-y-2 mb-4">
          <button v-for="reason in deathReasons" :key="reason.value"
            @click="handleTriggerReincarnation(reason.value)"
            :disabled="loading"
            class="w-full text-left px-3 py-2 text-xs rounded bg-stone-900 border border-stone-700 text-stone-300 hover:bg-stone-800 hover:border-rose-700 transition-colors">
            <div class="font-bold">{{ reason.label }}</div>
            <div class="text-stone-500 mt-0.5">{{ reason.desc }}</div>
          </button>
        </div>
        <div class="flex justify-end">
          <button @click="showReincarnationTrigger = false"
            class="px-4 py-2 text-xs rounded bg-stone-800 text-stone-300 hover:bg-stone-700">取消</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 飞升灵界面板组件脚本
 * 使用 Composition API，所有状态从后端拉取，禁止硬编码业务数据
 */
import { ref, onMounted, computed } from 'vue';
import {
  getProfile,
  searchNode,
  stabilizeNode,
  ascend,
  revert,
  askDao,
  practiceDharmaForm,
  exploreFracture,
  triggerReincarnation,
  chooseTarget,
  getReincarnationRecords,
  type AscensionProfileData,
  type ReincarnationTarget,
  type ReincarnationRecord
} from '../../api/ascension';
import { useUIStore } from '../../stores/ui';

const uiStore = useUIStore();

/** 面板状态：是否加载中 */
const loading = ref(false);
/** 飞升面板数据 */
const profile = ref<AscensionProfileData | null>(null);
/** 当前激活的 Tab */
const activeTab = ref('ascension');
/** 飞升确认弹窗 */
const showAscendConfirm = ref(false);
/** 触发夺舍确认弹窗 */
const showReincarnationTrigger = ref(false);
/** 夺舍目标列表 */
const reincarnationTargets = ref<ReincarnationTarget[]>([]);
/** 夺舍历史记录 */
const reincarnationRecords = ref<ReincarnationRecord[]>([]);

/** Tab 配置 */
const tabs = [
  { id: 'ascension', name: '飞升' },
  { id: 'ask_dao', name: '问道' },
  { id: 'dharma_form', name: '法相天地' },
  { id: 'fracture', name: '探寻裂缝' },
  { id: 'reincarnation', name: '夺舍重生' }
];

/** 死亡原因选项 */
const deathReasons = [
  { value: 'lifespan_out' as const, label: '寿元耗尽', desc: '寿元已尽，肉身自然衰亡' },
  { value: 'pvp_kill' as const, label: 'PVP 被杀', desc: '被其他修士斩杀' },
  { value: 'breakthrough_fail' as const, label: '突破失败', desc: '境界突破失败导致陨落' },
  { value: 'ascension_fail' as const, label: '飞升失败', desc: '飞升失败后残魂飘荡' }
];

/**
 * 组件挂载时拉取飞升面板数据
 */
onMounted(async () => {
  await loadProfile();
});

/**
 * 拉取飞升面板数据
 */
async function loadProfile() {
  loading.value = true;
  try {
    const resp = await getProfile();
    if (resp.data?.code === 200 && resp.data.data) {
      profile.value = resp.data.data;
    } else {
      uiStore.showToast(resp.data?.message || '获取飞升档案失败', 'error');
    }
  } catch (e: any) {
    uiStore.showToast(e.message || '网络错误', 'error');
  } finally {
    loading.value = false;
  }
}

/**
 * 搜寻空间节点
 */
async function handleSearchNode() {
  loading.value = true;
  try {
    const resp = await searchNode();
    if (resp.data?.code === 200) {
      uiStore.showToast(resp.data.message || '搜寻完成', 'success');
      await loadProfile();
    } else {
      uiStore.showToast(resp.data?.message || '搜寻失败', 'error');
    }
  } catch (e: any) {
    uiStore.showToast(e.message || '网络错误', 'error');
  } finally {
    loading.value = false;
  }
}

/**
 * 定星稳固节点
 * @param nodeId 节点ID
 */
async function handleStabilizeNode(nodeId: number) {
  loading.value = true;
  try {
    const resp = await stabilizeNode(nodeId);
    if (resp.data?.code === 200) {
      uiStore.showToast(resp.data.message || '已开始稳固', 'success');
      await loadProfile();
    } else {
      uiStore.showToast(resp.data?.message || '稳固失败', 'error');
    }
  } catch (e: any) {
    uiStore.showToast(e.message || '网络错误', 'error');
  } finally {
    loading.value = false;
  }
}

/**
 * 飞升尝试（二次确认后调用）
 */
async function handleAscend() {
  showAscendConfirm.value = false;
  loading.value = true;
  try {
    const resp = await ascend();
    if (resp.data?.code === 200) {
      const success = resp.data.data?.success;
      uiStore.showToast(resp.data.message || (success ? '飞升成功！' : '飞升失败'), success ? 'success' : 'warning');
      await loadProfile();
    } else {
      uiStore.showToast(resp.data?.message || '飞升失败', 'error');
    }
  } catch (e: any) {
    uiStore.showToast(e.message || '网络错误', 'error');
  } finally {
    loading.value = false;
  }
}

/**
 * 天机回溯
 */
async function handleRevert() {
  loading.value = true;
  try {
    const resp = await revert();
    if (resp.data?.code === 200) {
      uiStore.showToast(resp.data.message || '回溯完成', 'success');
      await loadProfile();
    } else {
      uiStore.showToast(resp.data?.message || '回溯失败', 'error');
    }
  } catch (e: any) {
    uiStore.showToast(e.message || '网络错误', 'error');
  } finally {
    loading.value = false;
  }
}

/**
 * 问道
 */
async function handleAskDao() {
  loading.value = true;
  try {
    const resp = await askDao();
    if (resp.data?.code === 200) {
      uiStore.showToast(resp.data.message || '问道完成', 'success');
      await loadProfile();
    } else {
      uiStore.showToast(resp.data?.message || '问道失败', 'error');
    }
  } catch (e: any) {
    uiStore.showToast(e.message || '网络错误', 'error');
  } finally {
    loading.value = false;
  }
}

/**
 * 修炼法相天地
 */
async function handleDharmaForm() {
  loading.value = true;
  try {
    const resp = await practiceDharmaForm();
    if (resp.data?.code === 200) {
      uiStore.showToast(resp.data.message || '修炼完成', 'success');
      await loadProfile();
    } else {
      uiStore.showToast(resp.data?.message || '修炼失败', 'error');
    }
  } catch (e: any) {
    uiStore.showToast(e.message || '网络错误', 'error');
  } finally {
    loading.value = false;
  }
}

/**
 * 探寻虚空裂缝
 */
async function handleExploreFracture() {
  loading.value = true;
  try {
    const resp = await exploreFracture();
    if (resp.data?.code === 200) {
      uiStore.showToast(resp.data.message || '探寻完成', 'success');
      await loadProfile();
    } else {
      uiStore.showToast(resp.data?.message || '探寻失败', 'error');
    }
  } catch (e: any) {
    uiStore.showToast(e.message || '网络错误', 'error');
  } finally {
    loading.value = false;
  }
}

/**
 * 触发夺舍重生
 * @param reason 死亡原因
 */
async function handleTriggerReincarnation(reason: 'lifespan_out' | 'pvp_kill' | 'breakthrough_fail' | 'ascension_fail') {
  showReincarnationTrigger.value = false;
  loading.value = true;
  try {
    const resp = await triggerReincarnation(reason);
    if (resp.data?.code === 200 && resp.data.data) {
      reincarnationTargets.value = resp.data.data.targets;
      uiStore.showToast(resp.data.message || '已推送夺舍目标', 'success');
    } else {
      uiStore.showToast(resp.data?.message || '触发失败', 'error');
    }
  } catch (e: any) {
    uiStore.showToast(e.message || '网络错误', 'error');
  } finally {
    loading.value = false;
  }
}

/**
 * 选定夺舍目标
 * @param targetId 目标ID
 */
async function handleChooseTarget(targetId: number) {
  loading.value = true;
  try {
    const resp = await chooseTarget(targetId);
    if (resp.data?.code === 200) {
      const success = resp.data.data?.success;
      uiStore.showToast(resp.data.message || (success ? '夺舍成功' : '夺舍失败'), success ? 'success' : 'warning');
      reincarnationTargets.value = [];
      await loadProfile();
    } else {
      uiStore.showToast(resp.data?.message || '选定失败', 'error');
    }
  } catch (e: any) {
    uiStore.showToast(e.message || '网络错误', 'error');
  } finally {
    loading.value = false;
  }
}

/**
 * 加载夺舍历史记录
 */
async function loadReincarnationRecords() {
  loading.value = true;
  try {
    const resp = await getReincarnationRecords(1, 20);
    if (resp.data?.code === 200 && resp.data.data) {
      reincarnationRecords.value = resp.data.data.records;
      uiStore.showToast(`已加载 ${resp.data.data.records.length} 条记录`, 'success');
    } else {
      uiStore.showToast(resp.data?.message || '加载失败', 'error');
    }
  } catch (e: any) {
    uiStore.showToast(e.message || '网络错误', 'error');
  } finally {
    loading.value = false;
  }
}

/**
 * 获取飞升状态中文标签
 */
function getAscensionStateLabel(state: string): string {
  const map: Record<string, string> = {
    preparing: '准备中',
    ascending: '飞升中',
    failed: '已失败'
  };
  return map[state] || state;
}

/**
 * 获取飞升状态颜色类
 */
function getAscensionStateColor(state: string): string {
  const map: Record<string, string> = {
    preparing: 'text-stone-300',
    ascending: 'text-amber-300',
    failed: 'text-rose-400'
  };
  return map[state] || 'text-stone-300';
}

/**
 * 获取节点状态中文标签
 */
function getNodeStateLabel(state: string): string {
  const map: Record<string, string> = {
    discovered: '已发现',
    stabilizing: '稳固中',
    stable: '已稳固',
    expired: '已过期'
  };
  return map[state] || state;
}

/**
 * 获取节点状态样式类
 */
function getNodeStateClass(state: string): string {
  const map: Record<string, string> = {
    discovered: 'bg-cyan-950/40 text-cyan-300 border border-cyan-800',
    stabilizing: 'bg-amber-950/40 text-amber-300 border border-amber-800',
    stable: 'bg-emerald-950/40 text-emerald-300 border border-emerald-800',
    expired: 'bg-stone-950/40 text-stone-500 border border-stone-800'
  };
  return map[state] || 'bg-stone-950/40 text-stone-300 border border-stone-800';
}

/**
 * 获取风险等级样式类
 */
function getRiskClass(risk: number): string {
  const map: Record<number, string> = {
    1: 'bg-emerald-950/40 text-emerald-300 border border-emerald-800',
    2: 'bg-amber-950/40 text-amber-300 border border-amber-800',
    3: 'bg-rose-950/40 text-rose-300 border border-rose-800'
  };
  return map[risk] || 'bg-stone-950/40 text-stone-300 border border-stone-800';
}

/**
 * 格式化时间显示
 */
function formatTime(time: string | null): string {
  if (!time) return '-';
  const d = new Date(time);
  return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
}
</script>

<style scoped>
/* 飞升灵界面板局部样式 - 使用 Tailwind CSS 工具类，此处仅补充动画 */
@keyframes fadeIn {
  from { opacity: 0; transform: translateY(-10px); }
  to { opacity: 1; transform: translateY(0); }
}
.animate-fade-in {
  animation: fadeIn 0.3s ease-out;
}
</style>
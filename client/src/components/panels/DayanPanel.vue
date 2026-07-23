<template>
  <!--
    大衍诀修炼面板（玩法文档第23节·大衍诀与傀儡路线）
    - 3 Tab：修炼状态/层级图鉴/玩法说明
    - 业务逻辑全部在后端 DayanService 中处理，前端仅展示与接口调用
    - 禁用浏览器原生 alert/confirm，使用自定义 Modal 二次确认
    - 核心交互：参悟（消耗修为获经验）+ 突破（消耗残篇+成功率判定）
  -->
  <div class="fixed inset-0 z-40 flex items-center justify-center bg-black/70 backdrop-blur-sm" @click.self="emit('close')">
    <div class="relative w-full max-w-3xl max-h-[92vh] mx-4 bg-gradient-to-b from-[#1c1917] to-[#0c0a09] border border-indigo-900/50 rounded-2xl shadow-2xl shadow-indigo-900/30 flex flex-col">
      <!-- 头部 -->
      <div class="flex items-center justify-between px-6 py-4 border-b border-indigo-900/40 shrink-0">
        <div class="flex items-center gap-3">
          <div class="w-10 h-10 rounded-full bg-gradient-to-br from-indigo-500 to-violet-700 flex items-center justify-center shadow-lg shadow-indigo-900/50">
            <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" class="text-indigo-100">
              <circle cx="12" cy="12" r="3"/>
              <circle cx="12" cy="12" r="7"/>
              <circle cx="12" cy="12" r="11"/>
              <path d="M12 1v3"/><path d="M12 20v3"/>
            </svg>
          </div>
          <div>
            <h2 class="text-xl font-bold text-indigo-200 tracking-wider">大衍诀</h2>
            <p class="text-[11px] text-stone-500">神识修炼 · 五层衍神 · 飞升前置</p>
          </div>
        </div>
        <button @click="emit('close')" class="text-stone-400 hover:text-rose-400 transition-colors w-8 h-8 flex items-center justify-center rounded-full hover:bg-rose-900/30">
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>

      <!-- Tab 栏 -->
      <div class="flex border-b border-indigo-900/40 shrink-0">
        <button v-for="tab in tabs" :key="tab.id" @click="switchTab(tab.id)"
          :class="['flex-1 px-4 py-3 text-sm font-bold tracking-wider transition-all relative',
                   activeTab === tab.id ? 'text-indigo-200 bg-indigo-900/20' : 'text-stone-500 hover:text-stone-300']">
          {{ tab.name }}
        </button>
      </div>

      <!-- 内容区 -->
      <div class="flex-1 overflow-y-auto p-6">
        <!-- 加载态 -->
        <div v-if="loading && activeTab !== 'guide'" class="text-center py-10 text-stone-500">查询中...</div>

        <!-- Tab 1: 修炼状态 -->
        <div v-else-if="activeTab === 'status'">
          <div v-if="!status" class="text-center py-12 text-stone-500 text-sm">暂无修炼数据</div>
          <div v-else class="space-y-5">
            <!-- 当前层数卡片 -->
            <div class="bg-gradient-to-br from-indigo-950/40 to-violet-950/30 border border-indigo-900/50 rounded-xl p-5">
              <div class="flex items-center justify-between mb-3">
                <div>
                  <div class="text-xs text-stone-500 mb-1">当前境界</div>
                  <div class="text-sm text-stone-300">{{ status.player_realm }} <span class="text-stone-500 text-[10px]">(rank {{ status.player_realm_rank }})</span></div>
                </div>
                <div class="text-right">
                  <div class="text-xs text-stone-500 mb-1">神识倍率</div>
                  <div class="text-lg font-bold text-indigo-300">×{{ status.sense_multiplier.toFixed(2) }}</div>
                </div>
              </div>
              <div class="text-center py-3">
                <div class="text-2xl font-bold text-indigo-200 tracking-wide">{{ status.current_level_name }}</div>
                <div class="text-[11px] text-stone-500 mt-1">{{ status.current_level_description }}</div>
              </div>
              <!-- 神识上限加成提示 -->
              <div class="mt-2 pt-3 border-t border-indigo-900/40 flex items-center justify-center gap-4 text-[11px]">
                <span class="text-stone-500">神识上限加成 <span class="text-emerald-300 font-bold">+{{ status.sense_max_bonus }}</span></span>
                <span class="text-stone-700">|</span>
                <span v-if="status.can_ascend" class="text-amber-300 font-bold">✦ 已满足飞升前置</span>
                <span v-else class="text-stone-500">飞升需 {{ status.ascension_requirement.required_level }} 层·衍神</span>
              </div>
            </div>

            <!-- 经验进度 -->
            <div v-if="status.exp_to_next > 0" class="bg-stone-900/50 border border-stone-700/50 rounded-xl p-4">
              <div class="flex items-center justify-between mb-2">
                <span class="text-sm text-stone-300">修炼经验</span>
                <span class="text-xs text-stone-400">{{ status.current_exp }} / {{ status.exp_to_next }}</span>
              </div>
              <div class="w-full h-3 bg-stone-950 rounded-full overflow-hidden border border-stone-800">
                <div class="h-full bg-gradient-to-r from-indigo-600 to-violet-500 rounded-full transition-all duration-500"
                     :style="{ width: expPercent + '%' }"></div>
              </div>
              <div v-if="status.can_breakthrough" class="mt-2 text-center text-xs text-amber-300 animate-pulse">
                ✦ 经验已满，可尝试突破至下一层
              </div>
            </div>
            <div v-else class="bg-amber-950/20 border border-amber-800/40 rounded-xl p-4 text-center">
              <div class="text-sm text-amber-300">大衍诀已修至最高层·衍神</div>
              <div class="text-[11px] text-stone-500 mt-1">无需再参悟，可着手飞升准备</div>
            </div>

            <!-- 参悟操作区 -->
            <div v-if="status.exp_to_next > 0" class="bg-stone-900/50 border border-stone-700/50 rounded-xl p-4">
              <div class="flex items-center justify-between mb-3">
                <span class="text-sm font-bold text-stone-200">参悟大衍诀</span>
                <span class="text-xs text-stone-400">
                  今日剩余 <span :class="status.meditate.daily_remaining > 0 ? 'text-emerald-300' : 'text-rose-400'">{{ status.meditate.daily_remaining }}</span> / {{ status.meditate.daily_limit }} 次
                </span>
              </div>
              <div class="grid grid-cols-3 gap-2 mb-3 text-center">
                <div class="bg-stone-950/50 rounded-lg py-2">
                  <div class="text-[10px] text-stone-500">消耗修为</div>
                  <div class="text-sm font-bold text-rose-300">{{ status.meditate.cost_exp }}</div>
                </div>
                <div class="bg-stone-950/50 rounded-lg py-2">
                  <div class="text-[10px] text-stone-500">获得经验</div>
                  <div class="text-sm font-bold text-indigo-300">+{{ status.meditate.exp_per_meditate }}</div>
                </div>
                <div class="bg-stone-950/50 rounded-lg py-2">
                  <div class="text-[10px] text-stone-500">当前修为</div>
                  <div class="text-sm font-bold text-amber-300 truncate" :title="status.player_exp">{{ formatBigNumber(status.player_exp) }}</div>
                </div>
              </div>
              <!-- 冷却提示 -->
              <div v-if="status.meditate.cooldown_remaining_sec > 0" class="text-center text-xs text-amber-400 mb-2">
                冷却中，剩余 {{ formatCooldown(status.meditate.cooldown_remaining_sec) }}
              </div>
              <!-- 参悟按钮 -->
              <button @click="openMeditateConfirm"
                :disabled="!status.meditate.can_meditate || meditateLoading"
                :class="['w-full px-4 py-3 rounded-lg font-bold text-sm transition-all',
                         status.meditate.can_meditate && !meditateLoading
                           ? 'bg-gradient-to-r from-indigo-700 to-violet-700 hover:from-indigo-600 hover:to-violet-600 text-indigo-100'
                           : 'bg-stone-800 text-stone-600 cursor-not-allowed']">
                {{ meditateLoading ? '参悟中...' : '参悟大衍诀' }}
              </button>
            </div>

            <!-- 突破操作区 -->
            <div v-if="status.next_fragment" class="bg-stone-900/50 border border-stone-700/50 rounded-xl p-4">
              <div class="flex items-center justify-between mb-3">
                <span class="text-sm font-bold text-stone-200">突破至下一层</span>
                <span v-if="status.can_breakthrough" class="text-xs text-emerald-300">条件已满足</span>
                <span v-else class="text-xs text-stone-500">条件未满足</span>
              </div>
              <!-- 残篇需求 -->
              <div class="bg-stone-950/50 rounded-lg p-3 mb-3">
                <div class="flex items-center justify-between">
                  <div>
                    <div class="text-sm text-stone-200">{{ status.next_fragment.name }}</div>
                    <div class="text-[10px] text-stone-500">{{ status.next_fragment.description }}</div>
                  </div>
                  <div class="text-right">
                    <div class="text-sm font-bold" :class="status.next_fragment.owned >= status.next_fragment.required ? 'text-emerald-300' : 'text-rose-400'">
                      {{ status.next_fragment.owned }} / {{ status.next_fragment.required }}
                    </div>
                    <div class="text-[10px] text-stone-500">{{ status.next_fragment.source }}</div>
                  </div>
                </div>
              </div>
              <!-- 突破说明 -->
              <div class="text-[11px] text-stone-500 mb-3 leading-relaxed">
                突破成功率随层数递减，失败时残篇损耗但经验保留。建议准备充分后再行突破。
              </div>
              <!-- 突破按钮 -->
              <button @click="openBreakthroughConfirm"
                :disabled="!status.can_breakthrough || breakthroughLoading"
                :class="['w-full px-4 py-3 rounded-lg font-bold text-sm transition-all',
                         status.can_breakthrough && !breakthroughLoading
                           ? 'bg-gradient-to-r from-amber-700 to-orange-700 hover:from-amber-600 hover:to-orange-600 text-amber-100'
                           : 'bg-stone-800 text-stone-600 cursor-not-allowed']">
                {{ breakthroughLoading ? '突破中...' : (status.can_breakthrough ? '尝试突破' : '条件未满足') }}
              </button>
            </div>
          </div>
        </div>

        <!-- Tab 2: 层级图鉴 -->
        <div v-else-if="activeTab === 'atlas'">
          <div v-if="!config" class="text-center py-12 text-stone-500 text-sm">配置加载中...</div>
          <div v-else class="space-y-3">
            <div v-for="lvl in levelList" :key="lvl.level"
                 :class="['rounded-xl border p-4 transition-all',
                          status && lvl.level === status.current_level
                            ? 'bg-indigo-950/30 border-indigo-600/60 shadow-lg shadow-indigo-900/20'
                            : status && lvl.level < status.current_level
                              ? 'bg-stone-900/30 border-stone-700/40 opacity-70'
                              : 'bg-stone-900/50 border-stone-700/50']">
              <div class="flex items-start justify-between mb-2">
                <div class="flex items-center gap-2">
                  <span class="w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold"
                        :class="status && lvl.level === status.current_level ? 'bg-indigo-600 text-white' : status && lvl.level < status.current_level ? 'bg-emerald-800/60 text-emerald-200' : 'bg-stone-700 text-stone-400'">
                    {{ lvl.level === 0 ? '○' : lvl.level }}
                  </span>
                  <div>
                    <div class="text-sm font-bold" :class="status && lvl.level === status.current_level ? 'text-indigo-200' : 'text-stone-300'">{{ lvl.name }}</div>
                    <div class="text-[10px] text-stone-500">{{ lvl.description }}</div>
                  </div>
                </div>
                <div class="text-right">
                  <div class="text-xs text-stone-400">神识倍率</div>
                  <div class="text-sm font-bold text-indigo-300">×{{ lvl.sense_multiplier.toFixed(2) }}</div>
                </div>
              </div>
              <div class="grid grid-cols-2 gap-2 text-[11px]">
                <div class="bg-stone-950/40 rounded px-2 py-1">
                  <span class="text-stone-500">神识上限：</span>
                  <span class="text-emerald-300 font-bold">+{{ lvl.level * (config.sense_bonus_per_level || 100) }}</span>
                </div>
                <div class="bg-stone-950/40 rounded px-2 py-1">
                  <span class="text-stone-500">升级经验：</span>
                  <span class="text-amber-300 font-bold">{{ lvl.exp_to_next > 0 ? lvl.exp_to_next : '—' }}</span>
                </div>
              </div>
              <!-- 残篇需求（非0层且有残篇） -->
              <div v-if="lvl.fragment_required && config.fragments[lvl.fragment_required]" class="mt-2 text-[10px] text-stone-500">
                突破需：<span class="text-violet-300">{{ config.fragments[lvl.fragment_required].name }}</span>
                · 来源：{{ config.fragments[lvl.fragment_required].source }}
              </div>
            </div>
          </div>
        </div>

        <!-- Tab 3: 玩法说明 -->
        <div v-else-if="activeTab === 'guide'" class="space-y-4 text-sm text-stone-300 leading-relaxed">
          <div class="bg-stone-900/50 border border-stone-700/50 rounded-xl p-4">
            <h3 class="text-indigo-300 font-bold mb-2">◆ 大衍诀简介</h3>
            <p class="text-stone-400 text-[13px]">大衍诀是后期成长线，核心价值是提高神识操控、傀儡运用、裂缝探索、节点稳定和飞升前置能力。修炼后按层数提供有效神识倍率，影响探查、斗法神识威压、御宝预算等判定。</p>
          </div>
          <div class="bg-stone-900/50 border border-stone-700/50 rounded-xl p-4">
            <h3 class="text-indigo-300 font-bold mb-2">◆ 五层修炼</h3>
            <ul class="text-stone-400 text-[13px] space-y-1">
              <li>· <span class="text-stone-200">第一层·凝识</span>：凝练神识，神识上限+100，倍率×1.30</li>
              <li>· <span class="text-stone-200">第二层·分念</span>：分神多念，神识上限+200，倍率×1.60</li>
              <li>· <span class="text-stone-200">第三层·控傀</span>：操控傀儡，神识上限+300，倍率×2.00（解锁傀儡工坊）</li>
              <li>· <span class="text-stone-200">第四层·千机</span>：千机神算，神识上限+400，倍率×2.45</li>
              <li>· <span class="text-stone-200">第五层·衍神</span>：衍化元神，神识上限+500，倍率×3.00（飞升前置）</li>
            </ul>
          </div>
          <div class="bg-stone-900/50 border border-stone-700/50 rounded-xl p-4">
            <h3 class="text-indigo-300 font-bold mb-2">◆ 参悟机制</h3>
            <ul class="text-stone-400 text-[13px] space-y-1">
              <li>· 每日可参悟 <span class="text-indigo-300">3 次</span>，跨日重置</li>
              <li>· 每次参悟冷却 <span class="text-indigo-300">10 分钟</span></li>
              <li>· 消耗修为（随层数递增），获得大衍诀经验</li>
              <li>· 需达到炼气期（rank≥15）方可参悟</li>
            </ul>
          </div>
          <div class="bg-stone-900/50 border border-stone-700/50 rounded-xl p-4">
            <h3 class="text-indigo-300 font-bold mb-2">◆ 突破机制</h3>
            <ul class="text-stone-400 text-[13px] space-y-1">
              <li>· 经验满后，消耗对应层数的<span class="text-violet-300">残篇</span>尝试突破</li>
              <li>· 成功率随层数递减：80% → 70% → 60% → 50% → 40%（下限30%）</li>
              <li>· <span class="text-emerald-300">成功</span>：层数+1，经验重置</li>
              <li>· <span class="text-rose-400">失败</span>：残篇损耗，经验保留</li>
            </ul>
          </div>
          <div class="bg-amber-950/20 border border-amber-800/40 rounded-xl p-4">
            <h3 class="text-amber-300 font-bold mb-2">✦ 飞升前置</h3>
            <p class="text-stone-400 text-[13px]">大衍诀五层·衍神是飞升灵界的必要条件。修至五层后方可着手空间法则碎片收集与逆灵通道定星，最终尝试飞升。</p>
          </div>
        </div>
      </div>

      <!-- 底部刷新 -->
      <div class="px-6 py-3 border-t border-indigo-900/40 shrink-0 text-center">
        <button @click="loadData" class="text-xs text-stone-500 hover:text-indigo-300 transition-colors">
          ↻ 刷新数据
        </button>
      </div>
    </div>

    <!-- 参悟确认 Modal -->
    <Modal :isOpen="meditateConfirmShow" @close="meditateConfirmShow = false" title="确认参悟大衍诀" width="420px">
      <div class="space-y-3 text-sm text-stone-300">
        <p>即将参悟大衍诀，本次消耗：</p>
        <div class="bg-stone-950/50 rounded-lg p-3 space-y-1 text-[13px]">
          <div class="flex justify-between"><span class="text-stone-500">消耗修为</span><span class="text-rose-300 font-bold">{{ status?.meditate.cost_exp }}</span></div>
          <div class="flex justify-between"><span class="text-stone-500">获得经验</span><span class="text-indigo-300 font-bold">+{{ status?.meditate.exp_per_meditate }}</span></div>
          <div class="flex justify-between"><span class="text-stone-500">今日剩余次数</span><span class="text-stone-300">{{ status?.meditate.daily_remaining }} 次</span></div>
        </div>
        <p class="text-[11px] text-stone-500">修为消耗后不可退还，请确认后继续。</p>
      </div>
      <template #footer>
        <button @click="meditateConfirmShow = false" class="px-4 py-2 text-sm text-stone-400 hover:text-stone-200 transition-colors">取消</button>
        <button @click="executeMeditate" :disabled="meditateLoading"
          class="px-4 py-2 text-sm bg-indigo-700 hover:bg-indigo-600 text-indigo-100 rounded-lg font-bold transition-colors disabled:opacity-50">
          {{ meditateLoading ? '参悟中...' : '确认参悟' }}
        </button>
      </template>
    </Modal>

    <!-- 突破确认 Modal -->
    <Modal :isOpen="breakthroughConfirmShow" @close="breakthroughConfirmShow = false" title="确认尝试突破" width="440px">
      <div class="space-y-3 text-sm text-stone-300">
        <p>即将尝试突破大衍诀层数，本次将消耗：</p>
        <div class="bg-stone-950/50 rounded-lg p-3 space-y-1 text-[13px]">
          <div class="flex justify-between"><span class="text-stone-500">消耗残篇</span><span class="text-violet-300 font-bold">{{ status?.next_fragment?.name }} ×{{ status?.next_fragment?.required }}</span></div>
          <div class="flex justify-between"><span class="text-stone-500">当前经验</span><span class="text-amber-300 font-bold">{{ status?.current_exp }} / {{ status?.exp_to_next }}</span></div>
        </div>
        <div class="bg-amber-950/30 border border-amber-800/40 rounded-lg p-3 text-[12px] text-amber-200">
          ⚠ 突破存在失败风险，失败时残篇损耗但经验保留。成功率随层数递减，请谨慎抉择。
        </div>
      </div>
      <template #footer>
        <button @click="breakthroughConfirmShow = false" class="px-4 py-2 text-sm text-stone-400 hover:text-stone-200 transition-colors">取消</button>
        <button @click="executeBreakthrough" :disabled="breakthroughLoading"
          class="px-4 py-2 text-sm bg-gradient-to-r from-amber-700 to-orange-700 hover:from-amber-600 hover:to-orange-600 text-amber-100 rounded-lg font-bold transition-colors disabled:opacity-50">
          {{ breakthroughLoading ? '突破中...' : '确认突破' }}
        </button>
      </template>
    </Modal>

    <!-- 突破结果 Modal -->
    <Modal :isOpen="resultShow" @close="resultShow = false" :title="resultData?.breakthrough ? '突破成功' : '突破失败'" width="420px">
      <div v-if="resultData" class="space-y-3 text-sm text-stone-300 text-center">
        <div class="text-5xl py-2">{{ resultData.breakthrough ? '✦' : '✕' }}</div>
        <div :class="['text-lg font-bold', resultData.breakthrough ? 'text-amber-300' : 'text-rose-400']">{{ resultData.message }}</div>
        <div v-if="resultData.breakthrough" class="bg-stone-950/50 rounded-lg p-3 space-y-1 text-[13px]">
          <div class="flex justify-between"><span class="text-stone-500">新层数</span><span class="text-indigo-300 font-bold">{{ resultData.new_level_name }}</span></div>
          <div class="flex justify-between"><span class="text-stone-500">神识倍率</span><span class="text-indigo-300 font-bold">×{{ resultData.sense_multiplier?.toFixed(2) }}</span></div>
          <div v-if="resultData.can_ascend" class="text-amber-300 pt-1">✦ 已满足飞升前置条件</div>
        </div>
        <div v-else class="bg-stone-950/50 rounded-lg p-3 text-[13px]">
          <div class="flex justify-between"><span class="text-stone-500">成功率</span><span class="text-stone-300">{{ (resultData.success_rate * 100).toFixed(0) }}%</span></div>
          <div class="flex justify-between mt-1"><span class="text-stone-500">经验保留</span><span class="text-amber-300">{{ resultData.exp_current }}</span></div>
        </div>
      </div>
      <template #footer>
        <button @click="resultShow = false" class="px-4 py-2 text-sm bg-indigo-700 hover:bg-indigo-600 text-indigo-100 rounded-lg font-bold transition-colors">知道了</button>
      </template>
    </Modal>
  </div>
</template>

<script setup>
/**
 * 大衍诀修炼面板
 *
 * 功能职责：
 *   - 展示玩家当前大衍诀层数、经验进度、神识倍率、飞升前置状态
 *   - 参悟操作（消耗修为获得经验，每日3次，冷却10分钟）
 *   - 突破操作（消耗残篇，成功率判定，失败保留经验）
 *   - 层级图鉴（5层详情：凝识→分念→控傀→千机→衍神）
 *
 * 设计原则：后端计算，前端只渲染与接口调用
 *   - 不在前端计算经验/成功率/突破结果，全部以后端返回为准
 *   - 状态变更后调用 loadData 刷新权威数据
 *   - 所有操作均通过自定义 Modal 二次确认
 *
 * 玩法文档对照：xiuxian_game_guide.md 第23节·大衍诀与傀儡路线
 */
import { ref, computed, onMounted, onUnmounted } from 'vue'
import Modal from '../common/Modal.vue'
import { useUIStore } from '../../stores/ui'
import {
  getConfig,
  getStatus,
  meditate,
  breakthrough
} from '../../api/dayan'

// 运行时声明 emit（项目 <script setup> 未启用 lang="ts"，不可使用 TS 泛型语法）
const emit = defineEmits(['close'])
const uiStore = useUIStore()

// ===== Tab 管理 =====
const tabs = [
  { id: 'status', name: '修炼状态' },
  { id: 'atlas', name: '层级图鉴' },
  { id: 'guide', name: '玩法说明' }
]
const activeTab = ref('status')

// ===== 数据 =====
const config = ref(null)
const status = ref(null)
const loading = ref(false)

// ===== 参悟 =====
const meditateConfirmShow = ref(false)
const meditateLoading = ref(false)

// ===== 突破 =====
const breakthroughConfirmShow = ref(false)
const breakthroughLoading = ref(false)
const resultShow = ref(false)
const resultData = ref(null)

// ===== 自动刷新定时器（冷却倒计时） =====
let refreshTimer = null

// ===== 计算属性 =====
/** 经验百分比（0-100） */
const expPercent = computed(() => {
  if (!status.value || !status.value.exp_to_next) return 0
  return Math.min(100, (status.value.current_exp / status.value.exp_to_next) * 100)
})

/** 层级列表（0-5，按层级排序） */
const levelList = computed(() => {
  if (!config.value || !config.value.levels) return []
  return Object.entries(config.value.levels)
    .map(([level, cfg]) => ({ level: Number(level), ...cfg }))
    .sort((a, b) => a.level - b.level)
})

// ===== 工具方法 =====
/**
 * 格式化大数修为显示（避免过长）
 * @param {string} numStr - 数字字符串
 * @returns {string} 格式化后的字符串
 */
function formatBigNumber(numStr) {
  if (!numStr) return '0'
  const num = BigInt(numStr)
  if (num >= 100000000n) return (Number(num) / 100000000).toFixed(2) + '亿'
  if (num >= 10000n) return (Number(num) / 10000).toFixed(1) + '万'
  return numStr
}

/**
 * 格式化冷却时间（秒 → 分秒）
 * @param {number} sec - 剩余秒数
 * @returns {string} 格式化后的时间
 */
function formatCooldown(sec) {
  if (sec <= 0) return '0秒'
  const m = Math.floor(sec / 60)
  const s = sec % 60
  if (m > 0) return `${m}分${s}秒`
  return `${s}秒`
}

// ===== 业务方法 =====
/** 切换 Tab */
function switchTab(tabId) {
  activeTab.value = tabId
}

/** 加载数据（配置 + 状态） */
async function loadData() {
  loading.value = true
  try {
    // 并行加载配置与状态
    const [cfgRes, statusRes] = await Promise.all([getConfig(), getStatus()])
    if (cfgRes.data) config.value = cfgRes.data
    const payload = statusRes.data
    if (payload.code === 200) {
      status.value = payload.data
    } else {
      uiStore.showToast(payload.message || '查询大衍诀状态失败', 'warning')
    }
  } catch (err) {
    const msg = err?.response?.data?.message || '查询大衍诀状态失败'
    uiStore.showToast(msg, 'error')
  } finally {
    loading.value = false
  }
}

/** 打开参悟确认弹窗 */
function openMeditateConfirm() {
  if (!status.value?.meditate?.can_meditate) {
    uiStore.showToast('当前无法参悟（次数不足或冷却中）', 'warning')
    return
  }
  meditateConfirmShow.value = true
}

/** 执行参悟 */
async function executeMeditate() {
  meditateLoading.value = true
  try {
    const res = await meditate()
    const payload = res.data
    meditateConfirmShow.value = false
    if (payload.code === 200 && payload.data) {
      uiStore.showToast(payload.data.message || '参悟成功', 'success')
      await loadData()
    } else {
      uiStore.showToast(payload.message || '参悟失败', 'error')
    }
  } catch (err) {
    const msg = err?.response?.data?.message || '参悟失败'
    uiStore.showToast(msg, 'error')
  } finally {
    meditateLoading.value = false
  }
}

/** 打开突破确认弹窗 */
function openBreakthroughConfirm() {
  if (!status.value?.can_breakthrough) {
    uiStore.showToast('突破条件未满足', 'warning')
    return
  }
  breakthroughConfirmShow.value = true
}

/** 执行突破 */
async function executeBreakthrough() {
  breakthroughLoading.value = true
  try {
    const res = await breakthrough()
    const payload = res.data
    breakthroughConfirmShow.value = false
    if (payload.code === 200 && payload.data) {
      resultData.value = payload.data
      resultShow.value = true
      await loadData()
    } else {
      uiStore.showToast(payload.message || '突破失败', 'error')
    }
  } catch (err) {
    const msg = err?.response?.data?.message || '突破失败'
    uiStore.showToast(msg, 'error')
  } finally {
    breakthroughLoading.value = false
  }
}

// ===== 生命周期 =====
onMounted(() => {
  loadData()
  // 每 5 秒刷新一次状态（用于冷却倒计时更新，轻量级查询）
  refreshTimer = setInterval(() => {
    if (activeTab.value === 'status' && status.value && status.value.meditate?.cooldown_remaining_sec > 0) {
      loadData()
    }
  }, 5000)
})

onUnmounted(() => {
  if (refreshTimer) clearInterval(refreshTimer)
})
</script>

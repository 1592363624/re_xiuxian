/**
 * 侍妾面板组件
 *
 * 批次3 侍妾 / 红尘寻缘 / 远航 / 婉影觉醒 子模块前端 UI
 *
 * Tab 划分：
 *   1. 侍妾列表：网格展示所有侍妾卡片（头像/名字/境界/属性/状态/操作）
 *   2. 红尘寻缘：今日剩余次数 + 寻缘按钮 + 寻缘结果展示
 *   3. 远航：4 种远航模式选择（稳妥 4h/均衡 8h/冒险 12h/月殿寻痕 24h）+ 进行中列表
 *   4. 日志：简化为最近 20 条侍妾互动日志（由列表刷新间接呈现）
 *
 * 设计原则：
 *   - 所有状态从后端 GET /concubine/list 拉取，禁止硬编码
 *   - 业务逻辑全部在后端，前端仅做展示与接口调用
 *   - 禁用浏览器原生 alert/confirm，使用自定义 Modal 二次确认
 *   - 颜色风格与 CompanionPanel.vue 一致（修仙古风：#1c1917 / #292524 / fuchsia-300）
 *   - 使用 Tailwind CSS 工具类，无自定义 CSS（除淡入动画）
 */
<template>
  <div class="fixed inset-0 z-50 flex items-center justify-center">
    <!-- 遮罩层 -->
    <div class="absolute inset-0 bg-black/80 backdrop-blur-sm" @click="$emit('close')"></div>

    <!-- 主面板 -->
    <div class="relative bg-[#1c1917] border border-fuchsia-900/40 rounded-lg p-6 max-w-5xl w-full mx-4 shadow-2xl animate-fade-in max-h-[90vh] flex flex-col">
      <!-- 标题栏 -->
      <div class="flex items-center justify-between mb-4">
        <h2 class="text-xl font-bold text-fuchsia-300 flex items-center gap-2">
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>
          </svg>
          侍妾 · 红尘寻缘
        </h2>
        <button @click="$emit('close')" class="text-stone-500 hover:text-white transition-colors">
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
        </button>
      </div>

      <!-- Tab 切换栏 -->
      <div class="flex border-b border-stone-700 mb-3 overflow-x-auto">
        <button v-for="tab in tabs" :key="tab.id"
          @click="switchTab(tab.id)"
          class="px-4 py-2 text-xs font-medium transition-colors whitespace-nowrap relative"
          :class="activeTab === tab.id ? 'text-fuchsia-300' : 'text-stone-500 hover:text-stone-300'">
          {{ tab.name }}
          <div v-if="activeTab === tab.id" class="absolute bottom-0 left-0 w-full h-0.5 bg-fuchsia-400"></div>
        </button>
      </div>

      <!-- 加载中状态 -->
      <div v-if="loading.list && !listData" class="flex-1 flex items-center justify-center">
        <div class="text-stone-500 text-sm">正在翻阅红尘名册...</div>
      </div>

      <!-- 内容滚动区 -->
      <div v-else class="flex-1 overflow-y-auto pr-1">

        <!-- ============ Tab 1: 侍妾列表 ============ -->
        <div v-show="activeTab === 'list'" class="space-y-3">
          <!-- 空状态 -->
          <section v-if="!listData?.concubines.length" class="bg-[#292524] border border-stone-700 rounded-lg p-6 text-center">
            <div class="text-stone-500 text-sm">尚未拥有侍妾</div>
            <div class="text-[11px] text-stone-500 mt-1">请前往「红尘寻缘」觅得有缘人</div>
          </section>

          <!-- 侍妾卡片网格 -->
          <section v-else>
            <div class="text-xs text-stone-500 mb-2">
              · 共有 {{ listData.total }} 位侍妾 · 今日剩余寻缘 {{ listData.seek_fate_remaining }} / {{ listData.seek_fate_limit }} 次
            </div>
            <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div v-for="concubine in listData.concubines" :key="concubine.id"
                class="bg-[#292524] border border-stone-700 rounded-lg p-3">
                <!-- 头部：头像 + 名字 + 境界 + 状态徽章 -->
                <div class="flex items-center justify-between mb-2">
                  <div class="flex items-center gap-2">
                    <div class="w-10 h-10 rounded bg-stone-900 border border-fuchsia-900/40 flex items-center justify-center text-2xl">
                      {{ concubine.avatar || '🌸' }}
                    </div>
                    <div>
                      <div class="text-fuchsia-300 font-bold text-sm">{{ concubine.name }}</div>
                      <div class="text-[10px] text-amber-300">{{ concubine.realm }}</div>
                    </div>
                  </div>
                  <div class="flex flex-col items-end gap-1">
                    <span v-if="concubine.is_awakened"
                      class="text-[10px] px-1.5 py-0.5 rounded bg-purple-950/60 text-purple-300 border border-purple-800">
                      婉影觉醒
                    </span>
                    <span class="text-[10px] px-1.5 py-0.5 rounded"
                      :class="getStatusBadgeClass(concubine.status)">
                      {{ getStatusLabel(concubine.status) }}
                    </span>
                  </div>
                </div>

                <!-- 属性进度条 -->
                <div class="space-y-1.5">
                  <div>
                    <div class="flex justify-between text-[11px] text-stone-500 mb-0.5">
                      <span>亲密度</span>
                      <span class="text-pink-300">{{ concubine.intimacy }} / 100</span>
                    </div>
                    <div class="h-1 bg-stone-800 rounded-full overflow-hidden">
                      <div class="h-full bg-gradient-to-r from-pink-600 to-pink-400 transition-all"
                        :style="{ width: `${concubine.intimacy}%` }"></div>
                    </div>
                  </div>
                  <div>
                    <div class="flex justify-between text-[11px] text-stone-500 mb-0.5">
                      <span>魅力</span>
                      <span class="text-fuchsia-300">{{ concubine.charm }} / 100</span>
                    </div>
                    <div class="h-1 bg-stone-800 rounded-full overflow-hidden">
                      <div class="h-full bg-gradient-to-r from-fuchsia-600 to-fuchsia-400 transition-all"
                        :style="{ width: `${concubine.charm}%` }"></div>
                    </div>
                  </div>
                  <div>
                    <div class="flex justify-between text-[11px] text-stone-500 mb-0.5">
                      <span>忠诚度</span>
                      <span class="text-amber-300">{{ concubine.loyalty }} / 100</span>
                    </div>
                    <div class="h-1 bg-stone-800 rounded-full overflow-hidden">
                      <div class="h-full bg-gradient-to-r from-amber-600 to-amber-400 transition-all"
                        :style="{ width: `${concubine.loyalty}%` }"></div>
                    </div>
                  </div>
                </div>

                <!-- 安置地点 -->
                <div v-if="concubine.location" class="mt-2 text-[11px] text-stone-400">
                  · 当前安置：<span class="text-cyan-300">{{ concubine.location }}</span>
                </div>

                <!-- 操作按钮组 -->
                <div class="mt-3 grid grid-cols-4 gap-1">
                  <button @click="handleAskAfter(concubine.id)"
                    :disabled="loading.action || concubine.status !== 'idle'"
                    class="py-1 text-[10px] rounded bg-pink-950/40 border border-pink-800 text-pink-300 hover:bg-pink-900/40 disabled:opacity-50">
                    问安
                  </button>
                  <button @click="handleBackfeed(concubine.id)"
                    :disabled="loading.action"
                    class="py-1 text-[10px] rounded bg-cyan-950/40 border border-cyan-800 text-cyan-300 hover:bg-cyan-900/40 disabled:opacity-50">
                    反哺
                  </button>
                  <button @click="openGiftModal(concubine.id)"
                    :disabled="loading.action"
                    class="py-1 text-[10px] rounded bg-amber-950/40 border border-amber-800 text-amber-300 hover:bg-amber-900/40 disabled:opacity-50">
                    赠予
                  </button>
                  <button @click="handleProtect(concubine.id)"
                    :disabled="loading.action || concubine.status !== 'idle'"
                    class="py-1 text-[10px] rounded bg-purple-950/40 border border-purple-800 text-purple-300 hover:bg-purple-900/40 disabled:opacity-50">
                    护法
                  </button>
                  <button @click="handleAwaken(concubine.id)"
                    :disabled="loading.action || concubine.is_awakened"
                    class="py-1 text-[10px] rounded bg-fuchsia-950/40 border border-fuchsia-800 text-fuchsia-300 hover:bg-fuchsia-900/40 disabled:opacity-50">
                    觉醒
                  </button>
                  <button @click="openPlaceModal(concubine.id)"
                    :disabled="loading.action || concubine.status !== 'idle'"
                    class="py-1 text-[10px] rounded bg-emerald-950/40 border border-emerald-800 text-emerald-300 hover:bg-emerald-900/40 disabled:opacity-50">
                    安置
                  </button>
                  <button @click="handleRecall(concubine.id)"
                    :disabled="loading.action || concubine.status !== 'placed'"
                    class="py-1 text-[10px] rounded bg-stone-800 border border-stone-600 text-stone-300 hover:bg-stone-700 disabled:opacity-50">
                    召回
                  </button>
                  <button @click="handleDismiss(concubine.id)"
                    :disabled="loading.action"
                    class="py-1 text-[10px] rounded bg-rose-950/40 border border-rose-800 text-rose-300 hover:bg-rose-900/40 disabled:opacity-50">
                    遣散
                  </button>
                </div>
              </div>
            </div>
          </section>
        </div>

        <!-- ============ Tab 2: 红尘寻缘 ============ -->
        <div v-show="activeTab === 'seek_fate'" class="space-y-3">
          <section class="bg-[#292524] border border-stone-700 rounded-lg p-4">
            <div class="flex items-center justify-between mb-3">
              <div class="text-sm font-bold text-fuchsia-300">红尘寻缘</div>
              <div class="text-[11px] text-stone-500">
                今日剩余：<span class="text-amber-300 font-bold">{{ listData?.seek_fate_remaining ?? 0 }}</span> / {{ listData?.seek_fate_limit ?? 4 }} 次
              </div>
            </div>
            <div class="text-[11px] text-stone-400 space-y-1 mb-4">
              <div>· 每日 1 次免费寻缘，额外 3 次消耗灵石</div>
              <div>· 寻得之侍妾随机出自 7 大原型</div>
              <div>· 侍妾境界、魅力、亲密度等属性随机生成</div>
            </div>
            <button @click="handleSeekFate"
              :disabled="loading.action || !listData || listData.seek_fate_remaining <= 0"
              class="w-full py-2 rounded text-xs font-bold bg-fuchsia-700 text-fuchsia-100 hover:bg-fuchsia-600 disabled:opacity-50">
              {{ listData && listData.seek_fate_remaining <= 0 ? '今日次数已尽' : '红尘寻缘' }}
            </button>
          </section>

          <!-- 寻缘结果 -->
          <section v-if="lastSeekResult" class="bg-[#292524] border border-stone-700 rounded-lg p-4">
            <div class="text-sm font-bold text-fuchsia-300 mb-2">寻缘结果</div>
            <div v-if="lastSeekResult.found && lastSeekResult.concubine"
              class="bg-stone-900/50 border border-fuchsia-900/40 rounded p-3 text-xs">
              <div class="flex items-center justify-between mb-2">
                <div class="flex items-center gap-2">
                  <div class="w-10 h-10 rounded bg-stone-900 border border-fuchsia-900/40 flex items-center justify-center text-2xl">
                    {{ lastSeekResult.concubine.avatar || '🌸' }}
                  </div>
                  <div>
                    <div class="text-fuchsia-300 font-bold">{{ lastSeekResult.concubine.name }}</div>
                    <div class="text-[10px] text-amber-300">{{ lastSeekResult.concubine.realm }}</div>
                  </div>
                </div>
                <span class="text-[10px] px-1.5 py-0.5 rounded bg-emerald-950/60 text-emerald-300 border border-emerald-800">
                  缘来
                </span>
              </div>
              <div class="grid grid-cols-3 gap-2 text-[11px]">
                <div>亲密度：<span class="text-pink-300">{{ lastSeekResult.concubine.intimacy }}</span></div>
                <div>魅力：<span class="text-fuchsia-300">{{ lastSeekResult.concubine.charm }}</span></div>
                <div>忠诚：<span class="text-amber-300">{{ lastSeekResult.concubine.loyalty }}</span></div>
              </div>
            </div>
            <div v-else class="text-stone-500 text-xs text-center py-2">
              · 缘分未至，下次再来
            </div>
            <div class="text-[11px] text-stone-400 mt-2">{{ lastSeekResult.message }}</div>
          </section>
        </div>

        <!-- ============ Tab 3: 远航 ============ -->
        <div v-show="activeTab === 'voyage'" class="space-y-3">
          <div v-if="loading.voyage" class="text-center py-6 text-stone-500 text-sm">加载远航数据中...</div>
          <template v-else-if="voyageData">
            <!-- 远航模式选择 -->
            <section class="bg-[#292524] border border-stone-700 rounded-lg p-4">
              <div class="text-sm font-bold text-fuchsia-300 mb-2">侍妾远航</div>
              <div class="text-[11px] text-stone-400 mb-3">
                · 选择一位空闲侍妾执行远航任务<br>
                · 时长越长奖励越丰厚，月殿寻痕为顶级远航
              </div>
              <!-- 侍妾选择 -->
              <div class="mb-3">
                <label class="block text-[11px] text-stone-400 mb-1">选择侍妾</label>
                <select v-model="voyageForm.concubineId"
                  class="w-full bg-stone-900 border border-stone-700 rounded px-3 py-2 text-xs text-white focus:border-fuchsia-500 focus:outline-none">
                  <option value="">请选择空闲侍妾</option>
                  <option v-for="c in idleConcubines" :key="c.id" :value="c.id">
                    {{ c.name }}（{{ c.realm }}）
                  </option>
                </select>
              </div>
              <!-- 模式选择 -->
              <div class="grid grid-cols-2 md:grid-cols-4 gap-2 mb-3">
                <button v-for="mode in voyageModes" :key="mode.value"
                  @click="voyageForm.mode = mode.value"
                  :disabled="loading.action"
                  :class="[
                    'py-2 rounded text-xs font-bold border transition-colors',
                    voyageForm.mode === mode.value
                      ? 'bg-fuchsia-700 border-fuchsia-500 text-fuchsia-100'
                      : 'bg-stone-900/40 border-stone-700 text-stone-300 hover:bg-stone-800/60'
                  ]">
                  <div>{{ mode.label }}</div>
                  <div class="text-[10px] text-stone-400 mt-0.5">{{ mode.duration }}</div>
                </button>
              </div>
              <button @click="handleStartVoyage"
                :disabled="loading.action || !voyageForm.concubineId || !voyageForm.mode"
                class="w-full py-2 rounded text-xs font-bold bg-fuchsia-700 text-fuchsia-100 hover:bg-fuchsia-600 disabled:opacity-50">
                开始远航
              </button>
            </section>

            <!-- 进行中远航 -->
            <section v-if="voyageData.active_voyages.length" class="bg-[#292524] border border-stone-700 rounded-lg p-4">
              <div class="text-sm font-bold text-amber-300 mb-3">进行中远航</div>
              <div class="space-y-2">
                <div v-for="voyage in voyageData.active_voyages" :key="voyage.id"
                  class="bg-stone-900/50 border border-stone-700 rounded p-2 text-xs">
                  <div class="flex items-center justify-between mb-1">
                    <span class="text-fuchsia-300 font-bold">{{ voyage.concubine_name }}</span>
                    <span class="text-[10px] px-1.5 py-0.5 rounded bg-amber-950/60 text-amber-300 border border-amber-800">
                      {{ getVoyageModeLabel(voyage.mode) }}
                    </span>
                  </div>
                  <div class="text-stone-500 text-[11px]">
                    · 出发：{{ formatTime(voyage.started_at) }}<br>
                    · 预计归来：{{ formatTime(voyage.expected_return_time) }}
                  </div>
                </div>
              </div>
            </section>

            <!-- 已完成待领取 -->
            <section v-if="voyageData.finished_voyages.length" class="bg-[#292524] border border-stone-700 rounded-lg p-4">
              <div class="text-sm font-bold text-emerald-300 mb-3">归来待领取</div>
              <div class="space-y-2">
                <div v-for="voyage in voyageData.finished_voyages" :key="voyage.id"
                  class="bg-stone-900/50 border border-emerald-900/40 rounded p-2 text-xs">
                  <div class="flex items-center justify-between mb-2">
                    <div>
                      <span class="text-fuchsia-300 font-bold">{{ voyage.concubine_name }}</span>
                      <span class="ml-2 text-[10px] text-stone-500">{{ getVoyageModeLabel(voyage.mode) }}</span>
                    </div>
                    <button @click="handleReturnVoyage(voyage.id)"
                      :disabled="loading.action"
                      class="px-3 py-1 rounded bg-emerald-700 text-emerald-100 hover:bg-emerald-600 disabled:opacity-50">
                      归来
                    </button>
                  </div>
                  <div v-if="voyage.rewards && voyage.rewards.length" class="text-[11px] text-stone-400">
                    奖励：
                    <span v-for="(reward, idx) in voyage.rewards" :key="idx" class="ml-1 text-amber-300">
                      {{ reward.name }} ×{{ reward.amount }}{{ idx < voyage.rewards!.length - 1 ? '、' : '' }}
                    </span>
                  </div>
                </div>
              </div>
            </section>

            <!-- 空状态 -->
            <section v-if="!voyageData.active_voyages.length && !voyageData.finished_voyages.length"
              class="bg-[#292524] border border-stone-700 rounded-lg p-4 text-center">
              <div class="text-stone-500 text-sm">暂无远航记录</div>
            </section>
          </template>
        </div>

        <!-- ============ Tab 4: 日志（简化） ============ -->
        <div v-show="activeTab === 'log'" class="space-y-3">
          <section class="bg-[#292524] border border-stone-700 rounded-lg p-4">
            <div class="text-sm font-bold text-fuchsia-300 mb-2">侍妾互动日志</div>
            <div class="text-[11px] text-stone-400 mb-3">
              · 展示侍妾列表中的最新状态与操作记录<br>
              · 完整流水请见后端日志系统
            </div>
            <div v-if="listData?.concubines.length" class="space-y-2">
              <div v-for="concubine in listData.concubines" :key="concubine.id"
                class="bg-stone-900/50 border border-stone-700 rounded p-2 text-xs">
                <div class="flex items-center justify-between mb-1">
                  <span class="text-fuchsia-300 font-bold">{{ concubine.name }}</span>
                  <span class="text-[10px] text-stone-500">{{ formatTime(concubine.created_at) }}</span>
                </div>
                <div class="text-stone-500 text-[11px] space-y-0.5">
                  <div>· 当前状态：<span class="text-amber-300">{{ getStatusLabel(concubine.status) }}</span></div>
                  <div v-if="concubine.last_ask_after_time">· 上次问安：{{ formatTime(concubine.last_ask_after_time) }}</div>
                  <div v-if="concubine.last_backfeed_time">· 上次反哺：{{ formatTime(concubine.last_backfeed_time) }}</div>
                  <div v-if="concubine.is_awakened">· 已觉醒婉影（Lv.{{ concubine.awaken_level }}）</div>
                </div>
              </div>
            </div>
            <div v-else class="text-center py-3 text-stone-500 text-xs">暂无侍妾记录</div>
          </section>
        </div>
      </div>
    </div>

    <!-- 赠予物品弹窗 -->
    <Modal :isOpen="giftModal.show" title="赠予物品" @close="giftModal.show = false" width="420px">
      <div class="space-y-3">
        <p class="text-stone-300 text-sm">将物品赠予侍妾，可提升其亲密度与魅力。</p>
        <div>
          <label class="block text-xs text-stone-400 mb-1">物品 key</label>
          <input v-model="giftModal.itemKey" placeholder="例如：spirit_herb / ling_zhi 等"
            class="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-white text-sm" />
        </div>
        <div>
          <label class="block text-xs text-stone-400 mb-1">数量（1-99）</label>
          <input v-model.number="giftModal.count" type="number" min="1" max="99"
            class="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-white text-sm" />
        </div>
        <p class="text-[11px] text-stone-500">· 物品 key 请见后端物品配置文件</p>
      </div>
      <template #footer>
        <button @click="giftModal.show = false"
          class="px-4 py-2 text-xs rounded bg-stone-800 text-stone-300 hover:bg-stone-700">取消</button>
        <button @click="handleGift"
          :disabled="loading.action || !giftModal.itemKey || !giftModal.count"
          class="px-4 py-2 text-xs rounded bg-amber-700 text-amber-100 hover:bg-amber-600 disabled:opacity-50">
          确认赠予
        </button>
      </template>
    </Modal>

    <!-- 安置地点弹窗 -->
    <Modal :isOpen="placeModal.show" title="安置侍妾" @close="placeModal.show = false" width="420px">
      <div class="space-y-3">
        <p class="text-stone-300 text-sm">选择安置地点，侍妾可在该地提供加成。</p>
        <div class="grid grid-cols-2 gap-2">
          <button v-for="loc in placeLocations" :key="loc"
            @click="placeModal.location = loc"
            :class="[
              'py-2 px-3 rounded text-xs font-bold border transition-colors',
              placeModal.location === loc
                ? 'bg-emerald-700 border-emerald-500 text-emerald-100'
                : 'bg-stone-900/40 border-stone-700 text-stone-300 hover:bg-stone-800/60'
            ]">
            {{ loc }}
          </button>
        </div>
      </div>
      <template #footer>
        <button @click="placeModal.show = false"
          class="px-4 py-2 text-xs rounded bg-stone-800 text-stone-300 hover:bg-stone-700">取消</button>
        <button @click="handlePlace"
          :disabled="loading.action || !placeModal.location"
          class="px-4 py-2 text-xs rounded bg-emerald-700 text-emerald-100 hover:bg-emerald-600 disabled:opacity-50">
          确认安置
        </button>
      </template>
    </Modal>

    <!-- 二次确认弹窗（通用） -->
    <Modal :isOpen="confirmModal.show" :title="confirmModal.title" @close="confirmModal.show = false" width="420px">
      <p class="text-stone-300 text-sm whitespace-pre-line">{{ confirmModal.message }}</p>
      <template #footer>
        <button @click="confirmModal.show = false"
          class="px-4 py-2 text-xs rounded bg-stone-800 text-stone-300 hover:bg-stone-700">取消</button>
        <button @click="confirmModal.onConfirm(); confirmModal.show = false"
          :disabled="loading.action"
          class="px-4 py-2 text-xs rounded bg-fuchsia-700 text-fuchsia-100 hover:bg-fuchsia-600 disabled:opacity-50">
          确认
        </button>
      </template>
    </Modal>
  </div>
</template>

<script setup lang="ts">
/**
 * 侍妾面板组件脚本
 * 使用 Composition API，所有状态从后端拉取，禁止硬编码业务数据
 */
import { ref, reactive, computed, onMounted } from 'vue';
import Modal from '../common/Modal.vue';
import { useUIStore } from '../../stores/ui';
import {
  concubineGetList,
  concubineSeekFate,
  concubineAskAfter,
  concubineBackfeed,
  concubineGift,
  concubinePlace,
  concubineRecall,
  concubineDismiss,
  concubineStartVoyage,
  concubineGetVoyageStatus,
  concubineReturnVoyage,
  concubineProtect,
  concubineAwaken,
  type ConcubineListData,
  type VoyageStatusData,
  type SeekFateResult,
  type Concubine
} from '../../api/companion';

const uiStore = useUIStore();

/** Tab 配置 */
const tabs = [
  { id: 'list', name: '侍妾列表' },
  { id: 'seek_fate', name: '红尘寻缘' },
  { id: 'voyage', name: '远航' },
  { id: 'log', name: '日志' }
];
/** 当前激活 Tab */
const activeTab = ref('list');
/** 已加载过的 Tab 集合，避免重复请求 */
const loadedTabs = reactive<Set<string>>(new Set());

/** 各模块加载状态 */
const loading = reactive({
  list: false,
  voyage: false,
  action: false
});

/** 各模块数据 */
const listData = ref<ConcubineListData | null>(null);
const voyageData = ref<VoyageStatusData | null>(null);
const lastSeekResult = ref<SeekFateResult | null>(null);

/** 远航模式选项（4 种） */
const voyageModes = [
  { value: 'safe' as const, label: '稳妥', duration: '4 小时' },
  { value: 'balanced' as const, label: '均衡', duration: '8 小时' },
  { value: 'risky' as const, label: '冒险', duration: '12 小时' },
  { value: 'moon_palace' as const, label: '月殿寻痕', duration: '24 小时' }
];

/** 安置地点选项（与后端配置保持一致，可扩展） */
const placeLocations = ['药园', '洞府', '灵泉', '藏经阁'];

/** 远航表单 */
const voyageForm = reactive({
  concubineId: null as number | null,
  mode: null as 'safe' | 'balanced' | 'risky' | 'moon_palace' | null
});

/** 赠予物品弹窗 */
const giftModal = reactive({
  show: false,
  concubineId: null as number | null,
  itemKey: '',
  count: 1
});

/** 安置侍妾弹窗 */
const placeModal = reactive({
  show: false,
  concubineId: null as number | null,
  location: ''
});

/** 通用二次确认弹窗 */
const confirmModal = reactive({
  show: false,
  title: '操作确认',
  message: '',
  onConfirm: () => {}
});

/**
 * 计算属性：空闲侍妾列表（用于远航选择）
 */
const idleConcubines = computed<Concubine[]>(() => {
  if (!listData.value) return [];
  return listData.value.concubines.filter(c => c.status === 'idle');
});

/**
 * 组件挂载时加载首个 Tab 数据
 */
onMounted(async () => {
  await loadList();
  loadedTabs.add('list');
});

/**
 * Tab 切换：按需懒加载
 * @param tabId Tab ID
 */
async function switchTab(tabId: string) {
  activeTab.value = tabId;
  if (loadedTabs.has(tabId)) return;
  if (tabId === 'voyage') await loadVoyageStatus();
  loadedTabs.add(tabId);
}

// ============ 数据加载函数 ============

/** 加载侍妾列表数据 */
async function loadList() {
  loading.list = true;
  try {
    const resp = await concubineGetList();
    if (resp.data?.code === 200 && resp.data.data) {
      listData.value = resp.data.data;
    } else {
      uiStore.showToast(resp.data?.message || '获取侍妾列表失败', 'error');
    }
  } catch (e: any) {
    uiStore.showToast(e.message || '网络错误', 'error');
  } finally {
    loading.list = false;
  }
}

/** 加载远航状态数据 */
async function loadVoyageStatus() {
  loading.voyage = true;
  try {
    const resp = await concubineGetVoyageStatus();
    if (resp.data?.code === 200 && resp.data.data) {
      voyageData.value = resp.data.data;
    } else {
      uiStore.showToast(resp.data?.message || '获取远航状态失败', 'error');
    }
  } catch (e: any) {
    uiStore.showToast(e.message || '网络错误', 'error');
  } finally {
    loading.voyage = false;
  }
}

// ============ 操作处理函数 ============

/** 红尘寻缘 */
async function handleSeekFate() {
  loading.action = true;
  try {
    const resp = await concubineSeekFate();
    if (resp.data?.code === 200 && resp.data.data) {
      lastSeekResult.value = resp.data.data;
      uiStore.showToast(resp.data.message || (resp.data.data.found ? '寻得有缘人' : '缘分未至'), 'success');
      await loadList();
    } else {
      uiStore.showToast(resp.data?.message || '寻缘失败', 'error');
    }
  } catch (e: any) {
    uiStore.showToast(e.message || '网络错误', 'error');
  } finally {
    loading.action = false;
  }
}

/**
 * 每日问安
 * @param concubineId 侍妾 ID
 */
async function handleAskAfter(concubineId: number) {
  loading.action = true;
  try {
    const resp = await concubineAskAfter(concubineId);
    if (resp.data?.code === 200) {
      uiStore.showToast(resp.data.message || '问安完成', 'success');
      await loadList();
    } else {
      uiStore.showToast(resp.data?.message || '问安失败', 'error');
    }
  } catch (e: any) {
    uiStore.showToast(e.message || '网络错误', 'error');
  } finally {
    loading.action = false;
  }
}

/**
 * 灵力反哺
 * @param concubineId 侍妾 ID
 */
async function handleBackfeed(concubineId: number) {
  showConfirm('灵力反哺', '确认进行灵力反哺？\n· 侍妾修为 +1000\n· 玩家修为消耗 500', async () => {
    loading.action = true;
    try {
      const resp = await concubineBackfeed(concubineId);
      if (resp.data?.code === 200) {
        uiStore.showToast(resp.data.message || '反哺完成', 'success');
        await loadList();
      } else {
        uiStore.showToast(resp.data?.message || '反哺失败', 'error');
      }
    } catch (e: any) {
      uiStore.showToast(e.message || '网络错误', 'error');
    } finally {
      loading.action = false;
    }
  });
}

/**
 * 打开赠予物品弹窗
 * @param concubineId 侍妾 ID
 */
function openGiftModal(concubineId: number) {
  giftModal.concubineId = concubineId;
  giftModal.itemKey = '';
  giftModal.count = 1;
  giftModal.show = true;
}

/** 确认赠予物品 */
async function handleGift() {
  if (!giftModal.concubineId || !giftModal.itemKey.trim() || !giftModal.count || giftModal.count < 1 || giftModal.count > 99) {
    uiStore.showToast('请填写有效的物品 key 和数量（1-99）', 'warning');
    return;
  }
  loading.action = true;
  try {
    const resp = await concubineGift(giftModal.concubineId, giftModal.itemKey.trim(), giftModal.count);
    if (resp.data?.code === 200) {
      uiStore.showToast(resp.data.message || '赠予成功', 'success');
      giftModal.show = false;
      await loadList();
    } else {
      uiStore.showToast(resp.data?.message || '赠予失败', 'error');
    }
  } catch (e: any) {
    uiStore.showToast(e.message || '网络错误', 'error');
  } finally {
    loading.action = false;
  }
}

/**
 * 打开安置侍妾弹窗
 * @param concubineId 侍妾 ID
 */
function openPlaceModal(concubineId: number) {
  placeModal.concubineId = concubineId;
  placeModal.location = '';
  placeModal.show = true;
}

/** 确认安置侍妾 */
async function handlePlace() {
  if (!placeModal.concubineId || !placeModal.location) {
    uiStore.showToast('请选择安置地点', 'warning');
    return;
  }
  loading.action = true;
  try {
    const resp = await concubinePlace(placeModal.concubineId, placeModal.location);
    if (resp.data?.code === 200) {
      uiStore.showToast(resp.data.message || '安置完成', 'success');
      placeModal.show = false;
      await loadList();
    } else {
      uiStore.showToast(resp.data?.message || '安置失败', 'error');
    }
  } catch (e: any) {
    uiStore.showToast(e.message || '网络错误', 'error');
  } finally {
    loading.action = false;
  }
}

/**
 * 召回侍妾
 * @param concubineId 侍妾 ID
 */
async function handleRecall(concubineId: number) {
  loading.action = true;
  try {
    const resp = await concubineRecall(concubineId);
    if (resp.data?.code === 200) {
      uiStore.showToast(resp.data.message || '已召回', 'success');
      await loadList();
    } else {
      uiStore.showToast(resp.data?.message || '召回失败', 'error');
    }
  } catch (e: any) {
    uiStore.showToast(e.message || '网络错误', 'error');
  } finally {
    loading.action = false;
  }
}

/**
 * 遣散侍妾（高风险操作，必须二次确认）
 * @param concubineId 侍妾 ID
 */
async function handleDismiss(concubineId: number) {
  showConfirm('遣散侍妾', '确认遣散此侍妾？\n· 操作不可撤销\n· 侍妾将永久离开，所有属性与羁绊归零', async () => {
    loading.action = true;
    try {
      const resp = await concubineDismiss(concubineId);
      if (resp.data?.code === 200) {
        uiStore.showToast(resp.data.message || '侍妾已遣散', 'success');
        await loadList();
      } else {
        uiStore.showToast(resp.data?.message || '遣散失败', 'error');
      }
    } catch (e: any) {
      uiStore.showToast(e.message || '网络错误', 'error');
    } finally {
      loading.action = false;
    }
  });
}

/** 开始远航 */
async function handleStartVoyage() {
  if (!voyageForm.concubineId || !voyageForm.mode) {
    uiStore.showToast('请选择侍妾与远航模式', 'warning');
    return;
  }
  showConfirm('开始远航', `确认派遣侍妾进行「${getVoyageModeLabel(voyageForm.mode)}」远航？`, async () => {
    loading.action = true;
    try {
      const resp = await concubineStartVoyage(voyageForm.concubineId!, voyageForm.mode!);
      if (resp.data?.code === 200) {
        uiStore.showToast(resp.data.message || '远航已开始', 'success');
        // 重置表单
        voyageForm.concubineId = null;
        voyageForm.mode = null;
        // 刷新列表与远航状态
        await Promise.all([loadList(), loadVoyageStatus()]);
      } else {
        uiStore.showToast(resp.data?.message || '远航开启失败', 'error');
      }
    } catch (e: any) {
      uiStore.showToast(e.message || '网络错误', 'error');
    } finally {
      loading.action = false;
    }
  });
}

/**
 * 远航归来
 * @param voyageId 远航 ID
 */
async function handleReturnVoyage(voyageId: number) {
  loading.action = true;
  try {
    const resp = await concubineReturnVoyage(voyageId);
    if (resp.data?.code === 200) {
      uiStore.showToast(resp.data.message || '远航归来', 'success');
      await Promise.all([loadList(), loadVoyageStatus()]);
    } else {
      uiStore.showToast(resp.data?.message || '归来失败', 'error');
    }
  } catch (e: any) {
    uiStore.showToast(e.message || '网络错误', 'error');
  } finally {
    loading.action = false;
  }
}

/**
 * 请侍妾护法
 * @param concubineId 侍妾 ID
 */
async function handleProtect(concubineId: number) {
  showConfirm('请侍妾护法', '确认请此侍妾护法？\n· 侍妾将进入护法状态\n· 可提升玩家修炼效率', async () => {
    loading.action = true;
    try {
      const resp = await concubineProtect(concubineId);
      if (resp.data?.code === 200) {
        uiStore.showToast(resp.data.message || '已开始护法', 'success');
        await loadList();
      } else {
        uiStore.showToast(resp.data?.message || '护法失败', 'error');
      }
    } catch (e: any) {
      uiStore.showToast(e.message || '网络错误', 'error');
    } finally {
      loading.action = false;
    }
  });
}

/**
 * 觉醒婉影
 * @param concubineId 侍妾 ID
 */
async function handleAwaken(concubineId: number) {
  showConfirm('觉醒婉影', '确认尝试觉醒此侍妾的婉影？\n· 觉醒后侍妾能力大幅提升\n· 觉醒过程消耗资源，且不保证成功', async () => {
    loading.action = true;
    try {
      const resp = await concubineAwaken(concubineId);
      if (resp.data?.code === 200) {
        uiStore.showToast(resp.data.message || '觉醒完成', 'success');
        await loadList();
      } else {
        uiStore.showToast(resp.data?.message || '觉醒失败', 'error');
      }
    } catch (e: any) {
      uiStore.showToast(e.message || '网络错误', 'error');
    } finally {
      loading.action = false;
    }
  });
}

// ============ 工具函数 ============

/**
 * 显示通用二次确认弹窗
 * @param title 标题
 * @param message 内容
 * @param onConfirm 确认回调
 */
function showConfirm(title: string, message: string, onConfirm: () => void) {
  confirmModal.title = title;
  confirmModal.message = message;
  confirmModal.onConfirm = onConfirm;
  confirmModal.show = true;
}

/**
 * 获取侍妾状态中文标签
 * @param status 状态值
 */
function getStatusLabel(status: string): string {
  const map: Record<string, string> = {
    idle: '空闲',
    placed: '已安置',
    voyaging: '远航中',
    protecting: '护法中'
  };
  return map[status] || status;
}

/**
 * 获取侍妾状态徽章样式
 * @param status 状态值
 */
function getStatusBadgeClass(status: string): string {
  const map: Record<string, string> = {
    idle: 'bg-stone-800 text-stone-300 border border-stone-700',
    placed: 'bg-emerald-950/60 text-emerald-300 border border-emerald-800',
    voyaging: 'bg-amber-950/60 text-amber-300 border border-amber-800',
    protecting: 'bg-purple-950/60 text-purple-300 border border-purple-800'
  };
  return map[status] || 'bg-stone-800 text-stone-300 border border-stone-700';
}

/**
 * 获取远航模式中文标签
 * @param mode 远航模式
 */
function getVoyageModeLabel(mode: string): string {
  const map: Record<string, string> = {
    safe: '稳妥（4h）',
    balanced: '均衡（8h）',
    risky: '冒险（12h）',
    moon_palace: '月殿寻痕（24h）'
  };
  return map[mode] || mode;
}

/**
 * 格式化时间显示（M/D HH:MM）
 * @param time ISO 时间字符串
 */
function formatTime(time: string | null | undefined): string {
  if (!time) return '-';
  const d = new Date(time);
  return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
}
</script>

<style scoped>
/* 局部淡入动画，与 CompanionPanel 保持一致 */
@keyframes fadeIn {
  from { opacity: 0; transform: translateY(-10px); }
  to { opacity: 1; transform: translateY(0); }
}
.animate-fade-in {
  animation: fadeIn 0.3s ease-out;
}
</style>

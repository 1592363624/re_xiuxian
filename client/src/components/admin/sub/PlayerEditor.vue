<template>
  <div class="space-y-3">
    <!-- 顶部：定位玩家 -->
    <div class="flex flex-wrap items-center gap-2">
      <input
        v-model="playerIdInput"
        placeholder="玩家 ID"
        class="w-32 px-2 py-1 bg-surface-sunken border border-line rounded-control text-fg-secondary text-sm focus-ring focus:border-gold-600 num"
      >
      <AppButton variant="primary" size="sm" @click="loadById">加载档案</AppButton>
      <AppButton v-if="profile" variant="ghost" size="sm" @click="refreshAll">刷新</AppButton>
      <span v-if="profile" class="text-sm text-fg-muted">
        <span class="text-gold-500">{{ profile.player.nickname }}</span>
        （{{ profile.player.username }} · ID {{ profile.player.id }} · {{ profile.player.realm }}）
      </span>
      <span v-else class="text-xs text-fg-faint">支持在「玩家数据」列表点「档案」直接进入</span>
    </div>

    <Tabs v-model="activeTab" :items="tabItems" />

    <!-- ========== 属性 ========== -->
    <div v-if="activeTab === 'attrs'" class="space-y-3">
      <LoadingBlock v-if="loadingProfile" text="加载玩家档案…" />
      <EmptyState v-else-if="!profile" text="请先加载一个玩家" />

      <template v-else>
        <div v-for="group in editableGroups" :key="group.key" class="border border-line-subtle rounded-control p-3">
          <h4 class="text-sm font-bold text-fg-secondary mb-2">{{ group.name }}</h4>
          <div class="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
            <div v-for="field in group.fields" :key="field.key">
              <label class="block text-xs text-fg-muted mb-1">{{ field.label }}</label>

              <!-- 带候选值的文本（境界/灵根）：走可检索下拉，避免手滑打错字 -->
              <SearchableSelect
                v-if="field.options && field.options.length"
                :model-value="String(formValues[group.key]?.[field.key] ?? '')"
                :options="field.options"
                :allow-empty="false"
                :list-height="240"
                @update:model-value="(v) => setField(group.key, field.key, v)"
              />

              <select
                v-else-if="field.type === 'enum'"
                :value="formValues[group.key]?.[field.key]"
                class="w-full bg-surface-sunken border border-line rounded-control px-2 py-1 text-fg-secondary text-sm focus-ring focus:border-gold-600"
                @change="(e) => setField(group.key, field.key, e.target.value)"
              >
                <option v-for="opt in field.options || []" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
              </select>

              <select
                v-else-if="field.type === 'boolean'"
                :value="formValues[group.key]?.[field.key] ? 'true' : 'false'"
                class="w-full bg-surface-sunken border border-line rounded-control px-2 py-1 text-fg-secondary text-sm focus-ring focus:border-gold-600"
                @change="(e) => setField(group.key, field.key, e.target.value === 'true')"
              >
                <option value="true">是</option>
                <option value="false">否</option>
              </select>

              <input
                v-else
                :type="field.type === 'number' ? 'number' : 'text'"
                :value="formValues[group.key]?.[field.key]"
                class="w-full bg-surface-sunken border border-line rounded-control px-2 py-1 text-fg-secondary text-sm focus-ring focus:border-gold-600 num"
                @change="(e) => setField(group.key, field.key, field.type === 'number' ? Number(e.target.value) : e.target.value)"
              >
            </div>
          </div>
        </div>

        <div class="flex items-center gap-2">
          <AppButton variant="primary" size="sm" :disabled="savingProfile" @click="saveProfile">
            {{ savingProfile ? '保存中…' : '保存改动' }}
          </AppButton>
          <span class="text-xs text-fg-faint">只提交与载入时不同的字段</span>
        </div>
      </template>
    </div>

    <!-- ========== 背包 ========== -->
    <div v-if="activeTab === 'bag'" class="space-y-3">
      <EmptyState v-if="!profile" text="请先加载一个玩家" />
      <template v-else>
        <!-- 新增物品 -->
        <div class="flex flex-wrap items-end gap-2 border border-line-subtle rounded-control p-3">
          <div class="min-w-[220px]">
            <label class="block text-xs text-fg-muted mb-1">物品</label>
            <SearchableSelect
              v-model="newItemKey"
              :options="itemOptions"
              :allow-empty="false"
              placeholder="选择物品…"
            />
          </div>
          <div>
            <label class="block text-xs text-fg-muted mb-1">数量</label>
            <input
              v-model.number="newItemQuantity"
              type="number"
              min="1"
              class="w-24 bg-surface-sunken border border-line rounded-control px-2 py-1 text-fg-secondary text-sm focus-ring focus:border-gold-600 num"
            >
          </div>
          <div>
            <label class="block text-xs text-fg-muted mb-1">方式</label>
            <select
              v-model="newItemMode"
              class="bg-surface-sunken border border-line rounded-control px-2 py-1 text-fg-secondary text-sm focus-ring focus:border-gold-600"
            >
              <option value="add">累加</option>
              <option value="set">设定为该数量</option>
            </select>
          </div>
          <AppButton variant="primary" size="sm" :disabled="!newItemKey" @click="submitAddItem">发放</AppButton>
          <AppButton variant="default" size="sm" @click="openBatchModal">批量发放</AppButton>
          <div class="ml-auto flex items-end gap-2">
            <select
              v-model="bagType"
              class="bg-surface-sunken border border-line rounded-control px-2 py-1 text-fg-secondary text-sm focus-ring focus:border-gold-600"
            >
              <option value="">全部类型</option>
              <option v-for="t in itemTypeOptions" :key="t" :value="t">{{ t }}</option>
            </select>
            <select
              v-model="bagQuality"
              class="bg-surface-sunken border border-line rounded-control px-2 py-1 text-fg-secondary text-sm focus-ring focus:border-gold-600"
            >
              <option value="">全部品质</option>
              <option v-for="q in itemQualityOptions" :key="q.value" :value="q.value">{{ q.label }}</option>
            </select>
            <input
              v-model="bagKeyword"
              placeholder="搜索物品名 / ID"
              class="px-2 py-1 bg-surface-sunken border border-line rounded-control text-fg-secondary text-sm focus-ring focus:border-gold-600"
              @keyup.enter="loadInventory"
            >
            <AppButton variant="ghost" size="sm" @click="loadInventory">搜索</AppButton>
            <AppButton variant="ghost" size="sm" @click="resetBagFilter">重置</AppButton>
            <AppButton variant="danger" size="sm" @click="confirmClearBag">清空背包</AppButton>
          </div>
        </div>

        <div class="flex items-center gap-3 text-xs text-fg-muted">
          <span>物品种类：<span class="num text-fg-secondary">{{ inventory.total_kinds }}</span></span>
          <span>总数量：<span class="num text-fg-secondary">{{ inventory.total_quantity }}</span></span>
          <span>储物袋上限：<span class="num text-fg-secondary">{{ inventory.capacity }}</span></span>
          <span class="text-fg-faint">（GM 发放默认绕过容量限制）</span>
        </div>

        <div class="overflow-x-auto border border-line-subtle rounded-control">
          <table class="w-full text-left text-sm text-fg-secondary">
            <thead class="bg-surface-raised text-fg-muted text-xs uppercase">
              <tr>
                <th class="px-3 py-2 whitespace-nowrap">ID</th>
                <th class="px-3 py-2 whitespace-nowrap">物品ID</th>
                <th class="px-3 py-2 whitespace-nowrap">名称</th>
                <th class="px-3 py-2 whitespace-nowrap">类型</th>
                <th class="px-3 py-2 whitespace-nowrap">品质</th>
                <th class="px-3 py-2 whitespace-nowrap">数量</th>
                <th class="px-3 py-2 whitespace-nowrap">元数据</th>
                <th class="px-3 py-2 whitespace-nowrap">操作</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-line-subtle">
              <tr v-for="row in inventory.items" :key="row.id" class="hover:bg-surface-hover">
                <td class="px-3 py-2 num text-fg-faint">{{ row.id }}</td>
                <td class="px-3 py-2 whitespace-nowrap">{{ row.item_key }}</td>
                <td class="px-3 py-2 whitespace-nowrap">
                  {{ row.item_name || '—' }}
                  <span v-if="row.config_missing" class="ml-1 text-[10px] text-orange-400">配置缺失</span>
                </td>
                <td class="px-3 py-2 whitespace-nowrap">{{ row.item_type || '—' }}</td>
                <td class="px-3 py-2 whitespace-nowrap">{{ row.item_quality || '—' }}</td>
                <td class="px-3 py-2">
                  <input
                    v-model.number="draftOf(row).quantity"
                    type="number"
                    min="0"
                    :max="inventory.max_quantity"
                    class="w-24 bg-surface-sunken border border-line rounded-control px-2 py-0.5 text-fg-secondary text-sm num focus-ring focus:border-gold-600"
                  >
                </td>
                <td class="px-3 py-2">
                  <input
                    v-model="draftOf(row).metadata"
                    placeholder="{}"
                    class="w-48 bg-surface-sunken border border-line rounded-control px-2 py-0.5 text-fg-secondary text-xs focus-ring focus:border-gold-600"
                  >
                </td>
                <td class="px-3 py-2 whitespace-nowrap">
                  <div class="flex gap-1">
                    <button type="button" class="focus-ring text-blue-400 hover:text-blue-300 text-xs px-1" @click="saveRow(row)">保存</button>
                    <button type="button" class="focus-ring text-red-400 hover:text-red-300 text-xs px-1" @click="confirmDeleteRow(row)">删除</button>
                  </div>
                </td>
              </tr>
              <tr v-if="!inventory.items.length">
                <td colspan="8" class="px-3 py-6 text-center text-fg-faint">背包是空的</td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>
    </div>

    <!-- ========== 装备 ========== -->
    <div v-if="activeTab === 'equipment'" class="space-y-3">
      <EmptyState v-if="!profile" text="请先加载一个玩家" />
      <template v-else>
        <div class="flex flex-wrap items-end gap-2 border border-line-subtle rounded-control p-3">
          <div>
            <label class="block text-xs text-fg-muted mb-1">槽位</label>
            <select
              v-model="newEquip.slot"
              class="bg-surface-sunken border border-line rounded-control px-2 py-1 text-fg-secondary text-sm focus-ring focus:border-gold-600"
            >
              <option v-for="slot in equipmentConfig.slots || []" :key="slot" :value="slot">{{ slotLabel(slot) }}</option>
            </select>
          </div>
          <div class="min-w-[220px]">
            <label class="block text-xs text-fg-muted mb-1">装备</label>
            <SearchableSelect v-model="newEquip.item_key" :options="itemOptions" :allow-empty="false" placeholder="选择装备…" />
          </div>
          <AppButton variant="primary" size="sm" :disabled="!newEquip.item_key" @click="submitEquip">强制穿戴</AppButton>
          <span class="text-xs text-fg-faint">同槽位已有装备时会被替换</span>
        </div>

        <div class="overflow-x-auto border border-line-subtle rounded-control">
          <table class="w-full text-left text-sm text-fg-secondary">
            <thead class="bg-surface-raised text-fg-muted text-xs uppercase">
              <tr>
                <th class="px-3 py-2 whitespace-nowrap">ID</th>
                <th class="px-3 py-2 whitespace-nowrap">槽位</th>
                <th class="px-3 py-2 whitespace-nowrap">装备</th>
                <th class="px-3 py-2 whitespace-nowrap">耐久</th>
                <th class="px-3 py-2 whitespace-nowrap">祭炼</th>
                <th class="px-3 py-2 whitespace-nowrap">属性倍率</th>
                <th class="px-3 py-2 whitespace-nowrap">本命</th>
                <th class="px-3 py-2 whitespace-nowrap">操作</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-line-subtle">
              <tr v-for="eq in equipment" :key="eq.id" class="hover:bg-surface-hover">
                <td class="px-3 py-2 num text-fg-faint">{{ eq.id }}</td>
                <td class="px-3 py-2 whitespace-nowrap">{{ slotLabel(eq.slot) }}</td>
                <td class="px-3 py-2 whitespace-nowrap">
                  {{ eq.item_name || eq.item_key }}
                  <span v-if="eq.config_missing" class="ml-1 text-[10px] text-orange-400">配置缺失</span>
                </td>
                <td class="px-3 py-2 num">{{ eq.durability }}/{{ eq.max_durability }}</td>
                <td class="px-3 py-2 num">{{ eq.refine_level }}</td>
                <td class="px-3 py-2 num">{{ eq.attr_multiplier }}</td>
                <td class="px-3 py-2">{{ eq.is_benming ? '是' : '否' }}</td>
                <td class="px-3 py-2 whitespace-nowrap">
                  <div class="flex gap-1">
                    <button type="button" class="focus-ring text-blue-400 hover:text-blue-300 text-xs px-1" @click="openEquipmentEditor(eq)">编辑</button>
                    <button
                      v-if="deepLineGroups.length"
                      type="button"
                      class="focus-ring text-purple-400 hover:text-purple-300 text-xs px-1"
                      @click="openDeepLineEditor(eq)"
                    >深线</button>
                    <button type="button" class="focus-ring text-red-400 hover:text-red-300 text-xs px-1" @click="confirmUnequip(eq)">卸下</button>
                  </div>
                </td>
              </tr>
              <tr v-if="!equipment.length">
                <td colspan="8" class="px-3 py-6 text-center text-fg-faint">没有穿戴任何装备</td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>
    </div>

    <!-- ========== 功法 ========== -->
    <div v-if="activeTab === 'techniques'" class="space-y-3">
      <EmptyState v-if="!profile" text="请先加载一个玩家" />
      <template v-else>
        <div class="flex flex-wrap items-end gap-2 border border-line-subtle rounded-control p-3">
          <div class="min-w-[220px]">
            <label class="block text-xs text-fg-muted mb-1">功法</label>
            <SearchableSelect v-model="newTech.technique_id" :options="techniqueOptions" :allow-empty="false" placeholder="选择功法…" />
          </div>
          <div>
            <label class="block text-xs text-fg-muted mb-1">层数</label>
            <input
              v-model.number="newTech.layer"
              type="number"
              min="1"
              class="w-20 bg-surface-sunken border border-line rounded-control px-2 py-1 text-fg-secondary text-sm num focus-ring focus:border-gold-600"
            >
          </div>
          <div>
            <label class="block text-xs text-fg-muted mb-1">熟练度</label>
            <input
              v-model.number="newTech.proficiency"
              type="number"
              min="0"
              class="w-24 bg-surface-sunken border border-line rounded-control px-2 py-1 text-fg-secondary text-sm num focus-ring focus:border-gold-600"
            >
          </div>
          <AppButton variant="primary" size="sm" :disabled="!newTech.technique_id" @click="submitGrantTechnique">授予</AppButton>
        </div>

        <div class="overflow-x-auto border border-line-subtle rounded-control">
          <table class="w-full text-left text-sm text-fg-secondary">
            <thead class="bg-surface-raised text-fg-muted text-xs uppercase">
              <tr>
                <th class="px-3 py-2 whitespace-nowrap">ID</th>
                <th class="px-3 py-2 whitespace-nowrap">功法</th>
                <th class="px-3 py-2 whitespace-nowrap">名称</th>
                <th class="px-3 py-2 whitespace-nowrap">层数</th>
                <th class="px-3 py-2 whitespace-nowrap">熟练度</th>
                <th class="px-3 py-2 whitespace-nowrap">装备槽</th>
                <th class="px-3 py-2 whitespace-nowrap">操作</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-line-subtle">
              <tr v-for="tech in techniques" :key="tech.id" class="hover:bg-surface-hover">
                <td class="px-3 py-2 num text-fg-faint">{{ tech.id }}</td>
                <td class="px-3 py-2 whitespace-nowrap">{{ tech.technique_id }}</td>
                <td class="px-3 py-2 whitespace-nowrap">
                  {{ tech.technique_name || '—' }}
                  <span v-if="tech.technique_grade" class="ml-1 text-[10px] text-fg-faint">{{ tech.technique_grade }}</span>
                  <span v-if="tech.config_missing" class="ml-1 text-[10px] text-orange-400">配置缺失</span>
                </td>
                <td class="px-3 py-2 num">{{ tech.layer }}</td>
                <td class="px-3 py-2 num">{{ tech.proficiency }}</td>
                <td class="px-3 py-2">{{ tech.equip_slot === 'main' ? '主修' : tech.equip_slot === 'auxiliary' ? '辅修' : '未装备' }}</td>
                <td class="px-3 py-2 whitespace-nowrap">
                  <div class="flex gap-1">
                    <button type="button" class="focus-ring text-blue-400 hover:text-blue-300 text-xs px-1" @click="openTechniqueEditor(tech)">编辑</button>
                    <button type="button" class="focus-ring text-red-400 hover:text-red-300 text-xs px-1" @click="confirmDeleteTechnique(tech)">删除</button>
                  </div>
                </td>
              </tr>
              <tr v-if="!techniques.length">
                <td colspan="7" class="px-3 py-6 text-center text-fg-faint">尚未习得任何功法</td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>
    </div>

    <!-- 装备编辑弹窗 -->
    <Modal :is-open="!!editingEquipment" :title="`编辑装备 #${editingEquipment?.id ?? ''}`" width="520px" @close="editingEquipment = null">
      <div v-if="editingEquipment" class="space-y-3">
        <div v-if="equipmentEditable.includes('item_key')">
          <label class="block text-xs text-fg-muted mb-1">装备</label>
          <SearchableSelect v-model="equipmentForm.item_key" :options="itemOptions" :allow-empty="false" />
        </div>
        <div class="grid grid-cols-2 gap-3">
          <div v-if="equipmentEditable.includes('slot')">
            <label class="block text-xs text-fg-muted mb-1">槽位</label>
            <select v-model="equipmentForm.slot" class="w-full bg-surface-sunken border border-line rounded-control px-2 py-1 text-fg-secondary text-sm focus-ring focus:border-gold-600">
              <option v-for="slot in equipmentConfig.slots || []" :key="slot" :value="slot">{{ slotLabel(slot) }}</option>
            </select>
          </div>
          <div v-if="equipmentEditable.includes('refine_level')">
            <label class="block text-xs text-fg-muted mb-1">祭炼等级</label>
            <input v-model.number="equipmentForm.refine_level" type="number" class="w-full bg-surface-sunken border border-line rounded-control px-2 py-1 text-fg-secondary text-sm num focus-ring focus:border-gold-600">
          </div>
          <div v-if="equipmentEditable.includes('durability')">
            <label class="block text-xs text-fg-muted mb-1">当前耐久</label>
            <input v-model.number="equipmentForm.durability" type="number" class="w-full bg-surface-sunken border border-line rounded-control px-2 py-1 text-fg-secondary text-sm num focus-ring focus:border-gold-600">
          </div>
          <div v-if="equipmentEditable.includes('max_durability')">
            <label class="block text-xs text-fg-muted mb-1">耐久上限</label>
            <input v-model.number="equipmentForm.max_durability" type="number" class="w-full bg-surface-sunken border border-line rounded-control px-2 py-1 text-fg-secondary text-sm num focus-ring focus:border-gold-600">
          </div>
          <div v-if="equipmentEditable.includes('attr_multiplier')">
            <label class="block text-xs text-fg-muted mb-1">属性倍率</label>
            <input v-model.number="equipmentForm.attr_multiplier" type="number" step="0.0001" class="w-full bg-surface-sunken border border-line rounded-control px-2 py-1 text-fg-secondary text-sm num focus-ring focus:border-gold-600">
          </div>
          <div v-if="equipmentEditable.includes('spirit_power')">
            <label class="block text-xs text-fg-muted mb-1">法力值</label>
            <input v-model.number="equipmentForm.spirit_power" type="number" class="w-full bg-surface-sunken border border-line rounded-control px-2 py-1 text-fg-secondary text-sm num focus-ring focus:border-gold-600">
          </div>
          <div v-if="equipmentEditable.includes('is_benming')">
            <label class="block text-xs text-fg-muted mb-1">本命法器</label>
            <select v-model="equipmentForm.is_benming" class="w-full bg-surface-sunken border border-line rounded-control px-2 py-1 text-fg-secondary text-sm focus-ring focus:border-gold-600">
              <option :value="true">是</option>
              <option :value="false">否</option>
            </select>
          </div>
          <div v-if="equipmentEditable.includes('is_summoned')">
            <label class="block text-xs text-fg-muted mb-1">已祭出</label>
            <select v-model="equipmentForm.is_summoned" class="w-full bg-surface-sunken border border-line rounded-control px-2 py-1 text-fg-secondary text-sm focus-ring focus:border-gold-600">
              <option :value="true">是</option>
              <option :value="false">否</option>
            </select>
          </div>
        </div>
      </div>
      <template #footer>
        <AppButton variant="ghost" size="sm" @click="editingEquipment = null">取消</AppButton>
        <AppButton variant="primary" size="sm" @click="submitEquipmentEdit">保存</AppButton>
      </template>
    </Modal>

    <!-- 功法编辑弹窗 -->
    <Modal :is-open="!!editingTechnique" :title="`编辑功法 #${editingTechnique?.id ?? ''}`" width="520px" @close="editingTechnique = null">
      <div v-if="editingTechnique" class="space-y-3">
        <div class="grid grid-cols-2 gap-3">
          <div v-if="techniqueEditable.includes('layer')">
            <label class="block text-xs text-fg-muted mb-1">层数</label>
            <input v-model.number="techniqueForm.layer" type="number" class="w-full bg-surface-sunken border border-line rounded-control px-2 py-1 text-fg-secondary text-sm num focus-ring focus:border-gold-600">
          </div>
          <div v-if="techniqueEditable.includes('proficiency')">
            <label class="block text-xs text-fg-muted mb-1">熟练度</label>
            <input v-model.number="techniqueForm.proficiency" type="number" class="w-full bg-surface-sunken border border-line rounded-control px-2 py-1 text-fg-secondary text-sm num focus-ring focus:border-gold-600">
          </div>
          <div v-if="techniqueEditable.includes('equip_slot')">
            <label class="block text-xs text-fg-muted mb-1">装备槽</label>
            <select v-model="techniqueForm.equip_slot" class="w-full bg-surface-sunken border border-line rounded-control px-2 py-1 text-fg-secondary text-sm focus-ring focus:border-gold-600">
              <option value="">未装备</option>
              <option value="main">主修</option>
              <option value="auxiliary">辅修</option>
            </select>
          </div>
          <div v-if="techniqueEditable.includes('fail_streak')">
            <label class="block text-xs text-fg-muted mb-1">连续失败次数</label>
            <input v-model.number="techniqueForm.fail_streak" type="number" class="w-full bg-surface-sunken border border-line rounded-control px-2 py-1 text-fg-secondary text-sm num focus-ring focus:border-gold-600">
          </div>
          <div v-if="techniqueEditable.includes('practice_count')">
            <label class="block text-xs text-fg-muted mb-1">累计修炼次数</label>
            <input v-model.number="techniqueForm.practice_count" type="number" class="w-full bg-surface-sunken border border-line rounded-control px-2 py-1 text-fg-secondary text-sm num focus-ring focus:border-gold-600">
          </div>
          <div v-if="techniqueEditable.includes('daily_practice_count')">
            <label class="block text-xs text-fg-muted mb-1">今日修炼次数</label>
            <input v-model.number="techniqueForm.daily_practice_count" type="number" class="w-full bg-surface-sunken border border-line rounded-control px-2 py-1 text-fg-secondary text-sm num focus-ring focus:border-gold-600">
          </div>
        </div>
        <div v-if="techniqueEditable.includes('comprehended_skills')">
          <label class="block text-xs text-fg-muted mb-1">已领悟神通（逗号分隔）</label>
          <input v-model="techniqueSkillsText" class="w-full bg-surface-sunken border border-line rounded-control px-2 py-1 text-fg-secondary text-sm focus-ring focus:border-gold-600" placeholder="skill_a, skill_b">
        </div>
      </div>
      <template #footer>
        <AppButton variant="ghost" size="sm" @click="editingTechnique = null">取消</AppButton>
        <AppButton variant="primary" size="sm" @click="submitTechniqueEdit">保存</AppButton>
      </template>
    </Modal>

    <!-- 批量发放弹窗：一次发多件，支持文本粘贴导入 -->
    <Modal :is-open="batchModal" title="批量发放物品" width="720px" @close="batchModal = false">
      <div class="space-y-3">
        <div>
          <label class="block text-xs text-fg-muted mb-1">粘贴导入（每行一条：<span class="num">物品ID 数量</span>，支持 <span class="num">:</span> / <span class="num">x</span> / <span class="num">*</span> / 逗号分隔；数量省略为 1）</label>
          <textarea
            v-model="batchText"
            rows="4"
            placeholder="ju_yuan_dan 10&#10;low_healing_pill:5&#10;spirit_stone x 999"
            class="w-full bg-surface-sunken border border-line rounded-control px-2 py-1 text-fg-secondary text-sm font-mono focus-ring focus:border-gold-600"
          ></textarea>
          <div class="mt-2 flex items-center gap-2">
            <AppButton variant="ghost" size="sm" @click="parseBatchText">解析为清单</AppButton>
            <select
              v-model="batchMode"
              class="bg-surface-sunken border border-line rounded-control px-2 py-1 text-fg-secondary text-sm focus-ring focus:border-gold-600"
            >
              <option value="add">累加</option>
              <option value="set">设定为该数量</option>
            </select>
            <span class="text-xs text-fg-faint">已添加 {{ batchRows.length }} / {{ batchMaxItems }} 条</span>
          </div>
        </div>

        <div class="max-h-64 overflow-y-auto scroll-thin border border-line-subtle rounded-control">
          <table class="w-full text-left text-sm text-fg-secondary">
            <thead class="bg-surface-raised text-fg-muted text-xs uppercase">
              <tr>
                <th class="px-3 py-2 whitespace-nowrap">物品</th>
                <th class="px-3 py-2 whitespace-nowrap">数量</th>
                <th class="px-3 py-2 whitespace-nowrap">方式</th>
                <th class="px-3 py-2 whitespace-nowrap">操作</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-line-subtle">
              <tr v-for="(row, idx) in batchRows" :key="idx">
                <td class="px-3 py-2 min-w-[240px]">
                  <SearchableSelect v-model="row.item_key" :options="itemOptions" :allow-empty="false" placeholder="选择物品…" />
                </td>
                <td class="px-3 py-2">
                  <input
                    v-model.number="row.quantity"
                    type="number"
                    min="1"
                    class="w-24 bg-surface-sunken border border-line rounded-control px-2 py-0.5 text-fg-secondary text-sm num focus-ring focus:border-gold-600"
                  >
                </td>
                <td class="px-3 py-2">
                  <select
                    v-model="row.mode"
                    class="bg-surface-sunken border border-line rounded-control px-2 py-0.5 text-fg-secondary text-sm focus-ring focus:border-gold-600"
                  >
                    <option value="">跟随默认</option>
                    <option value="add">累加</option>
                    <option value="set">设定</option>
                  </select>
                </td>
                <td class="px-3 py-2 whitespace-nowrap">
                  <button type="button" class="focus-ring text-red-400 hover:text-red-300 text-xs px-1" @click="removeBatchRow(idx)">移除</button>
                </td>
              </tr>
              <tr v-if="!batchRows.length">
                <td colspan="4" class="px-3 py-4 text-center text-fg-faint text-xs">清单为空：粘贴文本后点「解析为清单」，或点「新增一行」手动添加</td>
              </tr>
            </tbody>
          </table>
        </div>
        <AppButton variant="ghost" size="sm" :disabled="batchRows.length >= batchMaxItems" @click="addBatchRow">新增一行</AppButton>

        <!-- 逐条结果：失败的那几行要能被看见，而不是只报一个总数 -->
        <div v-if="batchResults.length" class="border border-line-subtle rounded-control p-2 max-h-40 overflow-y-auto scroll-thin">
          <div v-for="(r, idx) in batchResults" :key="idx" class="text-xs flex items-start gap-2 py-0.5">
            <span :class="r.ok ? 'text-green-400' : 'text-red-400'">{{ r.ok ? '✓' : '✕' }}</span>
            <span class="text-fg-secondary">{{ r.item_name || r.item_key }}</span>
            <span class="text-fg-faint num">{{ r.item_key }}</span>
            <span v-if="r.ok" class="text-fg-muted num">{{ r.mode === 'set' ? '设为' : '+' }}{{ r.quantity }}</span>
            <span v-else class="text-red-400">{{ r.message }}</span>
          </div>
        </div>
      </div>
      <template #footer>
        <AppButton variant="ghost" size="sm" @click="batchModal = false">关闭</AppButton>
        <AppButton variant="primary" size="sm" :disabled="!batchRows.length || batchSubmitting" @click="submitBatch">
          {{ batchSubmitting ? '发放中…' : '确认发放' }}
        </AppButton>
      </template>
    </Modal>

    <!-- 法宝深线子编辑器：按线分组逐字段编辑，不再整块贴 JSON -->
    <Modal
      :is-open="!!deepLineEquipment"
      :title="`法宝深线 · ${deepLineEquipment?.item_name || deepLineEquipment?.item_key || ''}`"
      width="680px"
      @close="deepLineEquipment = null"
    >
      <div v-if="deepLineEquipment" class="space-y-3">
        <Tabs v-model="activeDeepLine" :items="deepLineTabs" />

        <div v-if="currentDeepLine" class="space-y-2">
          <div class="flex items-center justify-between">
            <span class="text-xs text-fg-muted">
              {{ currentDeepLine.label }}
              <span class="ml-1 text-fg-faint">（{{ currentDeepLine.key }}）</span>
              <span v-if="!hasDeepLineState(currentDeepLine.key)" class="ml-2 text-orange-400">该装备当前没有这条线的状态</span>
            </span>
            <button
              type="button"
              class="focus-ring text-red-400 hover:text-red-300 text-xs px-1"
              @click="confirmClearDeepLine"
            >清空本条线</button>
          </div>

          <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div v-for="field in currentDeepLine.fields" :key="field.key">
              <label class="block text-xs text-fg-muted mb-1">{{ field.label }}</label>

              <select
                v-if="field.type === 'boolean'"
                v-model="deepLineForm[currentDeepLine.key][field.key]"
                class="w-full bg-surface-sunken border border-line rounded-control px-2 py-1 text-fg-secondary text-sm focus-ring focus:border-gold-600"
              >
                <option :value="true">是</option>
                <option :value="false">否</option>
              </select>

              <select
                v-else-if="field.type === 'enum'"
                v-model="deepLineForm[currentDeepLine.key][field.key]"
                class="w-full bg-surface-sunken border border-line rounded-control px-2 py-1 text-fg-secondary text-sm focus-ring focus:border-gold-600"
              >
                <option v-for="opt in field.options || []" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
              </select>

              <input
                v-else-if="field.type === 'date'"
                v-model="deepLineForm[currentDeepLine.key][field.key]"
                type="date"
                class="w-full bg-surface-sunken border border-line rounded-control px-2 py-1 text-fg-secondary text-sm num focus-ring focus:border-gold-600"
              >

              <input
                v-else-if="field.type === 'datetime'"
                :value="toDatetimeLocal(deepLineForm[currentDeepLine.key][field.key])"
                type="datetime-local"
                class="w-full bg-surface-sunken border border-line rounded-control px-2 py-1 text-fg-secondary text-sm num focus-ring focus:border-gold-600"
                @change="(e) => setDeepLineField(currentDeepLine.key, field.key, fromDatetimeLocal(e.target.value))"
              >

              <input
                v-else
                v-model.number="deepLineForm[currentDeepLine.key][field.key]"
                type="number"
                class="w-full bg-surface-sunken border border-line rounded-control px-2 py-1 text-fg-secondary text-sm num focus-ring focus:border-gold-600"
              >
            </div>
          </div>
        </div>
        <EmptyState v-else text="没有可编辑的法宝深线（配置 equipment.deep_lines 为空）" />
      </div>
      <template #footer>
        <AppButton variant="ghost" size="sm" @click="deepLineEquipment = null">取消</AppButton>
        <AppButton variant="primary" size="sm" @click="submitDeepLine">保存深线</AppButton>
      </template>
    </Modal>
  </div>
</template>

<script setup>
/**
 * 玩家档案编辑器（GM 后台）
 *
 * 背景：后台原先只能改昵称/境界/灵石等 7 个字段，背包、装备、功法一个都动不了。
 * 本页把玩家名下**全部资产**开放编辑，并且：
 *   - 可编辑字段清单来自后端 /schema（服务端读 admin_player_editor.json），加字段不用改前端；
 *   - 玩家属性改动走 PATCH（后端用 PlayerStateStore 锁内补丁写回），不会和玩家在线行为互相覆盖；
 *   - 背包/装备/功法都是独立表格，逐条编辑，操作全部落 GM 操作日志。
 */
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useUIStore } from '../../../stores/ui'
import AppButton from '../../ui/AppButton.vue'
import Tabs from '../../ui/Tabs.vue'
import Modal from '../../common/Modal.vue'
import EmptyState from '../../ui/EmptyState.vue'
import LoadingBlock from '../../ui/LoadingBlock.vue'
import SearchableSelect from '../../ui/SearchableSelect.vue'
import {
  getPlayerEditorSchema,
  getPlayerProfile,
  patchPlayerProfile,
  getPlayerInventory,
  addInventoryItem,
  batchGrantItems,
  updateInventoryItem,
  deleteInventoryItem,
  clearInventory,
  equipItem,
  updateEquipment,
  unequipItem,
  grantTechnique,
  updateTechnique,
  deleteTechnique,
  searchItemOptions,
  searchTechniqueOptions
} from '../../../api/admin_player_editor'

const props = defineProps({
  /** 外部（玩家列表点「档案」）指定的玩家 ID */
  playerId: { type: [Number, String], default: null }
})

const emit = defineEmits(['showConfirm'])
const uiStore = useUIStore()

/* ==================== 基础状态 ==================== */

const activeTab = ref('attrs')
const tabItems = [
  { key: 'attrs', label: '属性' },
  { key: 'bag', label: '背包' },
  { key: 'equipment', label: '装备' },
  { key: 'techniques', label: '功法' }
]

const playerIdInput = ref('')
const currentPlayerId = ref(null)
const loadingProfile = ref(false)
const savingProfile = ref(false)
const profile = ref(null)

/** 属性表单值：{ <分组key>: { 字段key: 值 } } */
const formValues = reactive({})
/** 载入时的快照，用于 diff 出真正改动过的字段 */
const formSnapshot = reactive({})

const inventory = ref({ items: [], total_kinds: 0, total_quantity: 0, capacity: 100, max_quantity: 999999 })
const equipment = ref([])
const techniques = ref([])

/** 背包行内编辑草稿：{ [id]: { quantity, metadata } } */
const rowDraft = reactive({})

const schema = ref(null)
const itemOptions = ref([])
const techniqueOptions = ref([])

/* ==================== 配置派生 ==================== */

/** 属性分组统一成 { key, name, column?, fields }，key 用于定位表单值 */
const editableGroups = computed(() => {
  if (!schema.value) return []
  const groups = []
  for (const g of schema.value.player_field_groups || []) {
    groups.push({ key: `player:${g.id}`, name: g.name, column: null, fields: g.fields || [] })
  }
  for (const g of schema.value.blob_field_groups || []) {
    groups.push({ key: `blob:${g.column}:${g.id}`, name: g.name, column: g.column, fields: g.fields || [] })
  }
  return groups
})

const equipmentConfig = computed(() => schema.value?.equipment || {})
const techniqueConfig = computed(() => schema.value?.techniques || {})
const equipmentEditable = computed(() => equipmentConfig.value.editable_fields || [])
const techniqueEditable = computed(() => techniqueConfig.value.editable_fields || [])

/** 背包筛选词表：类型与品质都由服务端下发，前端不另抄一份字典 */
const itemTypeOptions = computed(() => schema.value?.dictionaries?.item_types || [])
const itemQualityOptions = computed(() => schema.value?.dictionaries?.item_qualities || [])

/** 法宝深线分组（deep_line_state 的可视化编辑依据） */
const deepLineGroups = computed(() => equipmentConfig.value.deep_lines || [])
const deepLineTabs = computed(() => deepLineGroups.value.map(line => ({ key: line.key, label: line.label })))

/** 槽位中文名 */
const slotLabel = (slot) => ({
  weapon: '武器',
  armor: '护甲',
  accessory: '饰品',
  boots: '靴子',
  dharma: '法器'
}[slot] || slot || '—')

/* ==================== 数据加载 ==================== */

/**
 * 加载编辑器 schema 与物品/功法字典（只加载一次，之后复用）
 */
const loadSchema = async () => {
  try {
    const res = await getPlayerEditorSchema()
    schema.value = res.data.data
    const dict = schema.value.dictionaries || {}
    const [items, techs] = await Promise.all([
      searchItemOptions({ limit: dict.item_option_limit_max || 500 }),
      searchTechniqueOptions({ limit: dict.technique_option_limit_max || 500 })
    ])
    itemOptions.value = items.data.data.items || []
    techniqueOptions.value = techs.data.data.techniques || []
  } catch (error) {
    uiStore.showApiError(error, '加载编辑器配置失败')
  }
}

/**
 * 按分组把玩家档案铺进表单
 * 整块 JSON 列（attributes/stats/spirit_roots）在库里是 TEXT，后端 getter 已解析成对象
 */
const buildForm = () => {
  const player = profile.value?.player || {}
  for (const group of editableGroups.value) {
    const source = group.column ? (player[group.column] || {}) : player
    const values = {}
    for (const field of group.fields) {
      values[field.key] = source[field.key]
    }
    formValues[group.key] = values
    // 快照必须深拷贝：否则表单改动会同步改掉快照，diff 永远是空
    formSnapshot[group.key] = JSON.parse(JSON.stringify(values))
  }
}

const loadProfile = async (playerId) => {
  if (!playerId) return
  loadingProfile.value = true
  try {
    const res = await getPlayerProfile(playerId)
    profile.value = res.data.data
    currentPlayerId.value = playerId
    playerIdInput.value = String(playerId)
    inventory.value = profile.value.inventory
    equipment.value = profile.value.equipment || []
    techniques.value = profile.value.techniques || []
    resetRowDraft()
    buildForm()
  } catch (error) {
    uiStore.showApiError(error, '加载玩家档案失败')
    profile.value = null
  } finally {
    loadingProfile.value = false
  }
}

const loadById = async () => {
  const id = Number(playerIdInput.value)
  if (!Number.isInteger(id) || id <= 0) {
    uiStore.showToast('请输入合法的玩家 ID', 'warning')
    return
  }
  await loadProfile(id)
}

const refreshAll = async () => {
  if (currentPlayerId.value) await loadProfile(currentPlayerId.value)
}

/** 重建背包行内编辑草稿 */
const resetRowDraft = () => {
  for (const key of Object.keys(rowDraft)) delete rowDraft[key]
  for (const row of inventory.value.items || []) {
    rowDraft[row.id] = {
      quantity: row.quantity,
      metadata: row.metadata ? JSON.stringify(row.metadata) : ''
    }
  }
}

/**
 * 取某一行的编辑草稿（缺则按当前值补一份）
 * 直接读 rowDraft[row.id] 在"列表已刷新但草稿还没重建"的瞬间会拿到 undefined，
 * v-model 绑上去就是一个读不到属性的渲染错误，所以这里兜一层。
 */
const draftOf = (row) => {
  if (!rowDraft[row.id]) {
    rowDraft[row.id] = {
      quantity: row.quantity,
      metadata: row.metadata ? JSON.stringify(row.metadata) : ''
    }
  }
  return rowDraft[row.id]
}

const loadInventory = async () => {
  if (!currentPlayerId.value) return
  try {
    const res = await getPlayerInventory(currentPlayerId.value, {
      keyword: bagKeyword.value || undefined,
      type: bagType.value || undefined,
      quality: bagQuality.value || undefined
    })
    inventory.value = res.data.data
    resetRowDraft()
  } catch (error) {
    uiStore.showApiError(error, '加载背包失败')
  }
}

/** 清空筛选条件后重新拉一次（不直接改列表，保证和服务端口径一致） */
const resetBagFilter = async () => {
  bagKeyword.value = ''
  bagType.value = ''
  bagQuality.value = ''
  await loadInventory()
}

/* ==================== 属性保存 ==================== */

const setField = (groupKey, fieldKey, value) => {
  if (!formValues[groupKey]) formValues[groupKey] = {}
  formValues[groupKey][fieldKey] = value
}

/**
 * 提交属性改动
 * 只提交与快照不同的字段：既减少写库范围，也让 GM 日志里的 changes 准确反映"改了什么"
 */
const saveProfile = async () => {
  if (!currentPlayerId.value) return
  const columns = {}
  const blobs = {}

  for (const group of editableGroups.value) {
    const current = formValues[group.key] || {}
    const snapshot = formSnapshot[group.key] || {}
    const target = group.column ? (blobs[group.column] = blobs[group.column] || {}) : columns
    for (const [key, value] of Object.entries(current)) {
      if (JSON.stringify(value) === JSON.stringify(snapshot[key])) continue
      target[key] = value
    }
  }

  if (!Object.keys(columns).length && !Object.keys(blobs).length) {
    uiStore.showToast('没有改动需要保存', 'info')
    return
  }

  savingProfile.value = true
  try {
    const res = await patchPlayerProfile(currentPlayerId.value, { columns, blobs })
    uiStore.showToast(res.data.message || '已保存', 'success')
    await refreshAll()
  } catch (error) {
    uiStore.showApiError(error, '保存玩家档案失败')
  } finally {
    savingProfile.value = false
  }
}

/* ==================== 背包操作 ==================== */

const newItemKey = ref('')
const newItemQuantity = ref(1)
const newItemMode = ref('add')
const bagKeyword = ref('')
/** 背包筛选：类型与品质（空串 = 不过滤） */
const bagType = ref('')
const bagQuality = ref('')

const submitAddItem = async () => {
  if (!newItemKey.value) {
    uiStore.showToast('请选择物品', 'warning')
    return
  }
  try {
    const res = await addInventoryItem(currentPlayerId.value, {
      item_key: newItemKey.value,
      quantity: newItemQuantity.value,
      mode: newItemMode.value
    })
    uiStore.showToast(res.data.message || '发放成功', 'success')
    await loadInventory()
  } catch (error) {
    uiStore.showApiError(error, '发放物品失败')
  }
}

/** 保存单行改动（数量归零等价于回收该物品） */
const saveRow = async (row) => {
  const draft = rowDraft[row.id]
  if (!draft) return
  const payload = { quantity: Number(draft.quantity) }
  if (draft.metadata && draft.metadata.trim()) {
    try {
      payload.metadata = JSON.parse(draft.metadata)
    } catch {
      uiStore.showToast(`#${row.id} 的元数据不是合法 JSON`, 'warning')
      return
    }
  } else {
    payload.metadata = null
  }
  try {
    const res = await updateInventoryItem(currentPlayerId.value, row.id, payload)
    uiStore.showToast(res.data.message || '已保存', 'success')
    await loadInventory()
  } catch (error) {
    uiStore.showApiError(error, '保存背包物品失败')
  }
}

const confirmDeleteRow = (row) => {
  emit('showConfirm', '删除背包物品', `确定从背包移除 ${row.item_name || row.item_key} ×${row.quantity} 吗？`, async () => {
    try {
      const res = await deleteInventoryItem(currentPlayerId.value, row.id)
      uiStore.showToast(res.data.message || '已删除', 'success')
      await loadInventory()
    } catch (error) {
      uiStore.showApiError(error, '删除背包物品失败')
    }
  })
}

const confirmClearBag = () => {
  emit('showConfirm', '清空背包', `确定清空 ${profile.value?.player?.nickname || '该玩家'} 的整个背包吗？此操作不可撤销。`, async () => {
    try {
      const res = await clearInventory(currentPlayerId.value)
      uiStore.showToast(res.data.message || '已清空', 'success')
      await loadInventory()
    } catch (error) {
      uiStore.showApiError(error, '清空背包失败')
    }
  })
}

/* ==================== 批量发放 ==================== */

const batchModal = ref(false)
const batchText = ref('')
const batchMode = ref('add')
/** 每一行：{ item_key, quantity, mode }（mode 为空串 = 跟随弹窗里的默认方式） */
const batchRows = ref([])
const batchResults = ref([])
const batchSubmitting = ref(false)
const batchMaxItems = computed(() => schema.value?.inventory?.batch_max_items || 50)

const openBatchModal = () => {
  batchModal.value = true
  batchText.value = ''
  batchMode.value = 'add'
  batchRows.value = []
  batchResults.value = []
  addBatchRow()
}

const addBatchRow = () => {
  if (batchRows.value.length >= batchMaxItems.value) {
    uiStore.showToast(`单次最多 ${batchMaxItems.value} 条`, 'warning')
    return
  }
  batchRows.value.push({ item_key: '', quantity: 1, mode: '' })
}

const removeBatchRow = (idx) => {
  batchRows.value.splice(idx, 1)
}

/**
 * 解析一行粘贴文本为 { item_key, quantity }
 *
 * 分隔符按顺序试探（:/* → 空格 → x），而不是一把 replace 掉所有 x ——
 * 物品 ID 里带 x 很常见（xutian_cauldron / skyfire_sword），粗暴替换会把键名切坏。
 */
const parseBatchLine = (line) => {
  const text = String(line || '').trim()
  if (!text || text.startsWith('#')) return null
  const patterns = [
    /^(.+?)\s*[:*]\s*(\d+)$/,
    /^(.+?)\s+(\d+)$/,
    /^(.+?)\s*[xX]\s*(\d+)$/
  ];
  for (const re of patterns) {
    const m = text.match(re)
    if (m) return { item_key: m[1].trim(), quantity: Number(m[2]) || 1 }
  }
  return { item_key: text, quantity: 1 }
}

const parseBatchText = () => {
  const parsed = String(batchText.value || '')
    .split(/\r?\n/)
    .map(parseBatchLine)
    .filter(Boolean)
  if (!parsed.length) {
    uiStore.showToast('没有解析出任何物品', 'warning')
    return
  }
  const room = batchMaxItems.value - batchRows.value.length
  if (parsed.length > room) {
    uiStore.showToast(`只能再添加 ${room} 条，多余的行已忽略`, 'warning')
  }
  for (const item of parsed.slice(0, Math.max(room, 0))) {
    batchRows.value.push({ item_key: item.item_key, quantity: item.quantity, mode: '' })
  }
  // 空行占位（openBatchModal 建的初始行）清掉，避免提交一条空的
  batchRows.value = batchRows.value.filter(r => r.item_key)
  if (!batchRows.value.length) addBatchRow()
  uiStore.showToast(`已解析 ${parsed.length} 行`, 'success')
}

const submitBatch = async () => {
  const items = batchRows.value
    .filter(r => r.item_key)
    .map(r => ({
      item_key: r.item_key,
      quantity: Number(r.quantity) || 1,
      mode: r.mode || undefined
    }))
  if (!items.length) {
    uiStore.showToast('清单里没有物品', 'warning')
    return
  }
  batchSubmitting.value = true
  try {
    const res = await batchGrantItems(currentPlayerId.value, { items, mode: batchMode.value })
    batchResults.value = res.data.data.results || []
    uiStore.showToast(res.data.message || '批量发放完成', 'success')
    await loadInventory()
  } catch (error) {
    uiStore.showApiError(error, '批量发放失败')
  } finally {
    batchSubmitting.value = false
  }
}

/* ==================== 法宝深线（deep_line_state） ==================== */

const deepLineEquipment = ref(null)
const activeDeepLine = ref('')
/** 表单值：{ [线key]: { 字段key: 值 } } */
const deepLineForm = reactive({})
/** 载入快照，用于只提交改动过的字段 */
const deepLineSnapshot = reactive({})

const currentDeepLine = computed(() => deepLineGroups.value.find(l => l.key === activeDeepLine.value) || null)

/** 该装备当前是否已存在这条线的状态（没有的话保存即创建） */
const hasDeepLineState = (lineKey) => !!(deepLineEquipment.value?.deep_line_state?.[lineKey])

/** 时间转 datetime-local 输入框需要的本地时间串（YYYY-MM-DDTHH:mm） */
const toDatetimeLocal = (value) => {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** datetime-local 的值按本地时区转回 ISO 串交给后端 */
const fromDatetimeLocal = (text) => {
  if (!text) return null
  const date = new Date(text)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

/** 把库里的值收敛成控件能显示的形状（未设置时给各类型的中性值，避免控件拿到 undefined） */
const normalizeDeepLineValue = (field, raw) => {
  switch (field.type) {
    case 'boolean':
      return !!raw
    case 'number':
      return Number(raw) || 0
    case 'enum':
      return raw || field.options?.[0]?.value || ''
    case 'date':
      return raw ? String(raw).slice(0, 10) : ''
    case 'datetime':
      return raw ? new Date(raw).toISOString() : null
    default:
      return raw ?? ''
  }
}

const openDeepLineEditor = (eq) => {
  deepLineEquipment.value = eq
  const state = eq.deep_line_state || {}
  for (const line of deepLineGroups.value) {
    const source = state[line.key] || {}
    const values = {}
    for (const field of line.fields || []) {
      values[field.key] = normalizeDeepLineValue(field, source[field.key])
    }
    deepLineForm[line.key] = values
    deepLineSnapshot[line.key] = JSON.parse(JSON.stringify(values))
  }
  activeDeepLine.value = deepLineGroups.value[0]?.key || ''
}

const setDeepLineField = (lineKey, fieldKey, value) => {
  if (!deepLineForm[lineKey]) deepLineForm[lineKey] = {}
  deepLineForm[lineKey][fieldKey] = value
}

/**
 * 提交深线改动：只提交与快照不同的字段
 * 深线状态是四条线共用一个 JSON 列，整块回传会把别的线抹掉，所以必须键级补丁
 */
const submitDeepLine = async () => {
  if (!deepLineEquipment.value) return
  const patch = {}
  for (const line of deepLineGroups.value) {
    const current = deepLineForm[line.key] || {}
    const snapshot = deepLineSnapshot[line.key] || {}
    const linePatch = {}
    for (const field of line.fields || []) {
      let value = current[field.key]
      if (JSON.stringify(value) === JSON.stringify(snapshot[field.key])) continue
      // 输入框清空：数值按 0、时间按 null 提交（后端时间字段允许 null，数值不允许空）
      if (value === '' || value === null || value === undefined) {
        value = field.type === 'number' ? 0 : null
      }
      linePatch[field.key] = value
    }
    if (Object.keys(linePatch).length) patch[line.key] = linePatch
  }

  if (!Object.keys(patch).length) {
    uiStore.showToast('没有改动需要保存', 'info')
    return
  }

  try {
    const res = await updateEquipment(currentPlayerId.value, deepLineEquipment.value.id, { deep_line_state: patch })
    uiStore.showToast(res.data.message || '深线已保存', 'success')
    deepLineEquipment.value = null
    await refreshAll()
  } catch (error) {
    uiStore.showApiError(error, '保存法宝深线失败')
  }
}

/** 清空单条深线（传 null 即删掉这条线的整个子对象） */
const confirmClearDeepLine = () => {
  const lineKey = activeDeepLine.value
  const lineLabel = currentDeepLine.value?.label || lineKey
  emit('showConfirm', '清空法宝深线', `确定清空该装备的「${lineLabel}」全部状态吗？`, async () => {
    try {
      const res = await updateEquipment(currentPlayerId.value, deepLineEquipment.value.id, {
        deep_line_state: { [lineKey]: null }
      })
      uiStore.showToast(res.data.message || '已清空', 'success')
      deepLineEquipment.value = null
      await refreshAll()
    } catch (error) {
      uiStore.showApiError(error, '清空法宝深线失败')
    }
  })
}

/* ==================== 装备操作 ==================== */

const newEquip = reactive({ slot: 'weapon', item_key: '' })
const editingEquipment = ref(null)
const equipmentForm = reactive({})

const openEquipmentEditor = (eq) => {
  editingEquipment.value = eq
  Object.assign(equipmentForm, {
    item_key: eq.item_key,
    slot: eq.slot,
    durability: eq.durability,
    max_durability: eq.max_durability,
    refine_level: eq.refine_level,
    attr_multiplier: eq.attr_multiplier,
    spirit_power: eq.spirit_power,
    is_benming: !!eq.is_benming,
    is_summoned: !!eq.is_summoned
  })
}

const submitEquip = async () => {
  try {
    const res = await equipItem(currentPlayerId.value, { slot: newEquip.slot, item_key: newEquip.item_key })
    uiStore.showToast(res.data.message || '已穿戴', 'success')
    await refreshAll()
  } catch (error) {
    uiStore.showApiError(error, '穿戴装备失败')
  }
}

const submitEquipmentEdit = async () => {
  if (!editingEquipment.value) return
  try {
    const res = await updateEquipment(currentPlayerId.value, editingEquipment.value.id, { ...equipmentForm })
    uiStore.showToast(res.data.message || '已保存', 'success')
    editingEquipment.value = null
    await refreshAll()
  } catch (error) {
    uiStore.showApiError(error, '保存装备失败')
  }
}

const confirmUnequip = (eq) => {
  emit('showConfirm', '强制卸下装备', `确定卸下 ${eq.item_name || eq.item_key}（${slotLabel(eq.slot)}）吗？`, async () => {
    try {
      const res = await unequipItem(currentPlayerId.value, eq.id)
      uiStore.showToast(res.data.message || '已卸下', 'success')
      await refreshAll()
    } catch (error) {
      uiStore.showApiError(error, '卸下装备失败')
    }
  })
}

/* ==================== 功法操作 ==================== */

const newTech = reactive({ technique_id: '', layer: 1, proficiency: 0 })
const editingTechnique = ref(null)
const techniqueForm = reactive({})
const techniqueSkillsText = ref('')

const openTechniqueEditor = (tech) => {
  editingTechnique.value = tech
  Object.assign(techniqueForm, {
    layer: tech.layer,
    proficiency: tech.proficiency,
    equip_slot: tech.equip_slot || '',
    fail_streak: tech.fail_streak,
    practice_count: tech.practice_count,
    daily_practice_count: tech.daily_practice_count
  })
  techniqueSkillsText.value = Array.isArray(tech.comprehended_skills) ? tech.comprehended_skills.join(', ') : ''
}

const submitGrantTechnique = async () => {
  try {
    const res = await grantTechnique(currentPlayerId.value, {
      technique_id: newTech.technique_id,
      layer: newTech.layer,
      proficiency: newTech.proficiency
    })
    uiStore.showToast(res.data.message || '已授予', 'success')
    await refreshAll()
  } catch (error) {
    uiStore.showApiError(error, '授予功法失败')
  }
}

const submitTechniqueEdit = async () => {
  if (!editingTechnique.value) return
  const payload = { ...techniqueForm, equip_slot: techniqueForm.equip_slot || null }
  if (techniqueEditable.value.includes('comprehended_skills')) {
    payload.comprehended_skills = techniqueSkillsText.value
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
  }
  try {
    const res = await updateTechnique(currentPlayerId.value, editingTechnique.value.id, payload)
    uiStore.showToast(res.data.message || '已保存', 'success')
    editingTechnique.value = null
    await refreshAll()
  } catch (error) {
    uiStore.showApiError(error, '保存功法失败')
  }
}

const confirmDeleteTechnique = (tech) => {
  emit('showConfirm', '删除功法', `确定让该玩家遗忘 ${tech.technique_name || tech.technique_id} 吗？`, async () => {
    try {
      const res = await deleteTechnique(currentPlayerId.value, tech.id)
      uiStore.showToast(res.data.message || '已删除', 'success')
      await refreshAll()
    } catch (error) {
      uiStore.showApiError(error, '删除功法失败')
    }
  })
}

/* ==================== 生命周期 ==================== */

// 不用 immediate：schema 还没到位时建表单会拿到空分组，首屏交给 onMounted 顺序加载
watch(() => props.playerId, async (id) => {
  if (id) await loadProfile(Number(id))
})

onMounted(async () => {
  await loadSchema()
  if (props.playerId) await loadProfile(Number(props.playerId))
})

defineExpose({ loadProfile })
</script>

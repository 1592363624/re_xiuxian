<script setup>
import { ref } from 'vue'

const props = defineProps({
  serverStatus: String,
  dbStatus: String
})

const isExpanded = ref(false)
</script>

<template>
  <div class="fixed bottom-2 right-2 z-50">
    <!-- 折叠状态 -->
    <div 
      v-if="!isExpanded"
      @click="isExpanded = true"
      class="bg-gray-800 border border-gray-600 rounded-full w-8 h-8 flex items-center justify-center cursor-pointer hover:bg-gray-700 transition-colors"
      title="查看系统状态"
    >
      <div 
        class="w-3 h-3 rounded-full"
        :class="serverStatus?.includes('失败') || dbStatus?.includes('失败') ? 'bg-red-500 animate-pulse' : 'bg-green-500'"
      ></div>
    </div>

    <!-- 展开状态 -->
    <div 
      v-else 
      class="bg-gray-900 border border-gray-700 p-3 rounded shadow-lg text-xs"
    >
      <div class="flex justify-between items-center mb-2 border-b border-gray-700 pb-1">
        <span class="text-gray-400">系统状态</span>
        <button @click.stop="isExpanded = false" class="text-gray-500 hover:text-white">×</button>
      </div>
      <div class="space-y-1">
        <div class="flex items-center gap-2">
          <div class="w-2 h-2 rounded-full" :class="serverStatus?.includes('失败') ? 'bg-red-500' : 'bg-green-500'"></div>
          <span>API: {{ serverStatus }}</span>
        </div>
        <div class="flex items-center gap-2">
          <div class="w-2 h-2 rounded-full" :class="dbStatus?.includes('失败') ? 'bg-red-500' : 'bg-green-500'"></div>
          <span>DB: {{ dbStatus }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

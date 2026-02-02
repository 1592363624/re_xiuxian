<script setup>
import { ref, onMounted } from 'vue'
import axios from 'axios'
import { changelog, currentVersion } from '../../data/changelog'

const props = defineProps({
  isOpen: {
    type: Boolean,
    default: false
  }
})

const emit = defineEmits(['close'])

const close = () => {
  emit('close')
}

const currentLog = ref({
  version: currentVersion,
  date: new Date().toLocaleDateString(),
  sections: []
})
const isLoading = ref(false)
const hasCommits = ref(false)
const groupedCommits = ref([])
const fallbackLog = ref(null)

const fetchChangelog = async () => {
  isLoading.value = true
  try {
    const res = await axios.get('/api/system/changelog')
    const commits = res.data
    
    if (Array.isArray(commits) && commits.length > 0) {
      hasCommits.value = true
      
      // 按日期分组
      const groups = {}
      commits.forEach(commit => {
        const date = new Date(commit.date).toLocaleDateString()
        if (!groups[date]) groups[date] = []
        
        let type = 'other'
        let msg = commit.message
        
        // 简单类型判断
        if (msg.startsWith('feat') || msg.includes('新增')) type = 'feat'
        else if (msg.startsWith('fix') || msg.includes('修复')) type = 'fix'
        else if (msg.match(/refactor|perf|style|chore/) || msg.includes('优化')) type = 'improvement'
        
        // 移除前缀，只保留内容
        const cleanMsg = msg.replace(/^(feat|fix|refactor|perf|style|chore|docs|test|build|ci)(\([^\)]+\))?:\s*/, '').trim()

        groups[date].push({
          sha: commit.sha,
          message: cleanMsg || msg,
          author: commit.author,
          type
        })
      })
      
      // 转为数组并排序
      groupedCommits.value = Object.keys(groups)
        .sort((a, b) => new Date(b) - new Date(a))
        .map(date => ({
          date,
          commits: groups[date]
        }))
        
      currentLog.value.version = 'Latest Commits'
      currentLog.value.date = groupedCommits.value[0]?.date || new Date().toLocaleDateString()
      
    } else {
      // Fallback to local data
      fallbackLog.value = changelog.find(log => log.version === currentVersion) || changelog[0]
    }

  } catch (error) {
    console.error('Fetch changelog error:', error)
    // Fallback to local data
    fallbackLog.value = changelog.find(log => log.version === currentVersion) || changelog[0]
  } finally {
    isLoading.value = false
  }
}

onMounted(() => {
  fetchChangelog()
})
</script>

<template>
  <Transition name="fade">
    <div v-if="isOpen" class="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm" @click.self="close">
      <!-- Modal Container -->
      <div class="w-[1000px] max-h-[85vh] bg-[#1c1917] border border-stone-700/50 rounded-lg shadow-2xl flex flex-col overflow-hidden animate-slide-up">
        
        <!-- Header -->
        <div class="flex items-center justify-between px-6 py-4 border-b border-stone-800 bg-[#1c1917]">
          <h2 class="text-amber-500 font-bold text-lg tracking-wide">版本信息 <span class="text-stone-400 text-base font-normal ml-2">{{ currentLog.version.replace('v', '') }}</span></h2>
          <button @click="close" class="text-stone-500 hover:text-stone-300 transition-colors text-2xl leading-none">&times;</button>
        </div>

        <!-- Loading State -->
        <div v-if="isLoading" class="flex flex-col justify-center items-center h-64 text-stone-500">
          <div class="animate-spin rounded-full h-8 w-8 border-b-2 border-amber-500 mb-3"></div>
          <span class="text-sm">正在获取 GitHub 更新记录...</span>
        </div>

        <!-- Content (Scrollable) -->
        <div v-else class="flex-1 overflow-y-auto custom-scrollbar p-6 bg-[#1c1917]">
          
          <h3 class="text-amber-500/90 font-bold mb-4 text-lg">变更日志</h3>

          <!-- GitHub Commits Mode -->
          <div v-if="hasCommits" class="space-y-6">
            <div v-for="group in groupedCommits" :key="group.date" class="border border-stone-800 rounded-lg overflow-hidden bg-[#161413]/50">
              <!-- Date Header -->
              <div class="px-4 py-2 bg-stone-900/80 border-b border-stone-800 flex justify-between items-center">
                <span class="text-amber-500 font-bold font-mono">{{ group.date }}</span>
                <span class="text-stone-500 text-xs">{{ group.commits.length }} commits</span>
              </div>
              
              <!-- Commits List -->
              <div class="divide-y divide-stone-800/50">
                <div v-for="commit in group.commits" :key="commit.sha" class="p-3 flex gap-3 items-start hover:bg-stone-800/30 transition-colors">
                  <!-- Icon -->
                  <div class="mt-0.5 text-lg shrink-0" :title="commit.type">
                    <span v-if="commit.type === 'feat'">✨</span>
                    <span v-else-if="commit.type === 'fix'">🐛</span>
                    <span v-else-if="commit.type === 'improvement'">🔧</span>
                    <span v-else>📝</span>
                  </div>
                  
                  <div class="flex-1 min-w-0">
                    <p class="text-stone-300 text-sm leading-relaxed whitespace-pre-wrap">{{ commit.message }}</p>
                    <div class="flex items-center gap-2 mt-1.5">
                       <span class="text-[10px] text-stone-500 font-mono bg-stone-800 px-1.5 py-0.5 rounded border border-stone-700">{{ commit.sha.substring(0, 7) }}</span>
                       <span class="text-[10px] text-stone-600">by {{ commit.author }}</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- Fallback Mode -->
          <div v-else-if="fallbackLog" class="border border-stone-800 rounded-lg overflow-hidden bg-[#161413]/50">
            <!-- Version Header -->
            <div class="flex items-center justify-between px-4 py-3 bg-stone-900/80 border-b border-stone-800">
              <span class="text-amber-500 font-bold font-mono">{{ fallbackLog.version }}</span>
              <span class="text-stone-500 text-sm font-mono">{{ fallbackLog.date }}</span>
            </div>

            <!-- Sections -->
            <div class="p-5 space-y-8">
              <div v-for="(section, idx) in fallbackLog.sections" :key="idx" class="space-y-3">
                
                <!-- Section Title -->
                <div class="flex items-center gap-2">
                  <!-- Icons based on type -->
                  <div v-if="section.type === 'new'" class="text-xl">🎉</div>
                  <div v-else-if="section.type === 'improvement'" class="text-xl">🔧</div>
                  <div v-else-if="section.type === 'fix'" class="text-xl">🐛</div>
                  <div v-else class="text-xl">📝</div>
                  
                  <h4 class="text-stone-200 font-bold tracking-wide">{{ section.title }}</h4>
                </div>

                <!-- Items -->
                <ul class="space-y-2 pl-1">
                  <li v-for="(item, itemIdx) in section.items" :key="itemIdx" class="text-stone-400 text-sm leading-relaxed flex items-start gap-2">
                    <span class="text-stone-600 mt-1.5 w-1 h-1 rounded-full bg-stone-500 shrink-0"></span>
                    <span>{{ item }}</span>
                  </li>
                </ul>
              </div>
            </div>
          </div>

          <!-- Footer decoration -->
          <div class="mt-6 border-t border-stone-800 pt-4 text-center text-xs text-stone-600">
            --- 道法自然，版本迭代 ---
          </div>
        </div>

      </div>
    </div>
  </Transition>
</template>

<style scoped>
.custom-scrollbar::-webkit-scrollbar {
  width: 6px;
}
.custom-scrollbar::-webkit-scrollbar-track {
  background: #1c1917;
}
.custom-scrollbar::-webkit-scrollbar-thumb {
  background: #44403c;
  border-radius: 3px;
}
.custom-scrollbar::-webkit-scrollbar-thumb:hover {
  background: #57534e;
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.3s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

.animate-slide-up {
  animation: slideUp 0.3s cubic-bezier(0.16, 1, 0.3, 1);
}

@keyframes slideUp {
  from {
    opacity: 0;
    transform: translateY(20px) scale(0.98);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}
</style>

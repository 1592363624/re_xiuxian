<template>
  <div class="fixed inset-0 z-50 flex items-center justify-center p-4">
    <!-- Backdrop -->
    <div class="absolute inset-0 bg-black/80 backdrop-blur-sm" @click="$emit('close')"></div>
    
    <!-- Modal Content -->
    <div class="relative w-full max-w-md bg-[#141210] border border-stone-700 rounded-lg shadow-2xl flex flex-col max-h-[90vh] overflow-hidden animate-fade-in">
      <!-- Header -->
      <div class="flex items-center justify-between p-4 border-b border-stone-800 bg-[#1c1917]">
        <h2 class="text-xl font-bold text-amber-500 tracking-wider">设置</h2>
        <button @click="$emit('close')" class="text-stone-500 hover:text-stone-300 transition-colors">
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
        </button>
      </div>
      
      <!-- Body -->
      <div class="flex-1 overflow-y-auto p-6 space-y-8 custom-scrollbar">
        
        <!-- Game Management -->
        <section>
          <h3 class="flex items-center gap-2 text-stone-200 font-bold mb-3 text-lg">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18.36 6.64a9 9 0 1 1-12.73 0"></path><line x1="12" y1="2" x2="12" y2="12"></line></svg>
            重新开始游戏
          </h3>
          <div class="bg-[#1c1917] rounded border border-stone-800 p-4">
            <p class="text-stone-500 text-sm mb-4">清除所有本地缓存并退出登录，返回登录界面。</p>
            <button 
              @click="handleLogout"
              class="w-full flex items-center justify-center gap-2 py-3 bg-red-900/80 hover:bg-red-800 text-red-100 rounded border border-red-700/50 transition-all font-bold shadow-lg hover:shadow-red-900/20"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"></path><path d="M3 3v5h5"></path><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"></path><path d="M16 16l5-5"></path><path d="M21 21v-5h-5"></path></svg>
              重新开始游戏 (注销)
            </button>
          </div>
        </section>

        <!-- Shortcuts -->
        <section>
          <h3 class="flex items-center gap-2 text-stone-200 font-bold mb-3 text-lg">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>
            快捷键
          </h3>
          <div class="bg-[#1c1917] rounded border border-stone-800 overflow-hidden">
            <div class="flex items-center justify-between p-3 border-b border-stone-800/50 last:border-0 hover:bg-[#292524] transition-colors">
              <span class="text-stone-400">发送消息</span>
              <kbd class="px-2 py-1 bg-stone-800 rounded text-stone-300 text-xs font-mono border border-stone-700">Enter</kbd>
            </div>
            <div class="flex items-center justify-between p-3 border-b border-stone-800/50 last:border-0 hover:bg-[#292524] transition-colors">
              <span class="text-stone-400">关闭窗口</span>
              <kbd class="px-2 py-1 bg-stone-800 rounded text-stone-300 text-xs font-mono border border-stone-700">Esc</kbd>
            </div>
             <!-- Add more if needed -->
          </div>
          <p class="mt-2 text-xs text-stone-600">查看所有可用的键盘快捷键，提高操作效率</p>
        </section>

        <!-- About -->
        <section>
          <h3 class="flex items-center gap-2 text-stone-200 font-bold mb-3 text-lg">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>
            关于
          </h3>
          <div class="bg-[#1c1917] rounded border border-stone-800 p-4 space-y-3">
             <div class="flex justify-between items-center">
                <span class="text-stone-400">游戏版本</span>
                <span class="text-amber-500 font-mono">v0.0.1</span>
             </div>
             <div class="flex justify-between items-center text-xs text-stone-600">
                <span>最后更新</span>
                <span>2023-12-20</span>
             </div>
             
             <a href="https://github.com/1592363624/re_xiuxian" class="flex items-center justify-between p-3 bg-stone-800/50 rounded border border-stone-700/50 hover:bg-stone-800 hover:border-stone-600 text-stone-300 transition-all group">
                <div class="flex items-center gap-2">
                   <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22"></path></svg>
                   GitHub 仓库
                </div>
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-stone-500 group-hover:text-stone-300"><line x1="7" y1="17" x2="17" y2="7"></line><polyline points="7 7 17 7 17 17"></polyline></svg>
             </a>

             <a href="#" class="flex items-center justify-between p-3 bg-stone-800/50 rounded border border-stone-700/50 hover:bg-stone-800 hover:border-stone-600 text-stone-300 transition-all group">
                <div class="flex items-center gap-2">
                   <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><polyline points="10 9 9 9 8 9"></polyline></svg>
                   查看更新日志
                </div>
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-stone-500 group-hover:text-stone-300"><line x1="7" y1="17" x2="17" y2="7"></line><polyline points="7 7 17 7 17 17"></polyline></svg>
             </a>
          </div>
        </section>
      </div>
    </div>
  </div>
</template>

<script setup>
import { usePlayerStore } from '../../stores/player'

const emit = defineEmits(['close'])
const playerStore = usePlayerStore()

const handleLogout = () => {
  if (confirm('确定要注销当前账号吗？')) {
    playerStore.logout()
    window.location.reload()
  }
}
</script>

<style scoped>
.custom-scrollbar::-webkit-scrollbar {
  width: 6px;
}
.custom-scrollbar::-webkit-scrollbar-track {
  background: transparent;
}
.custom-scrollbar::-webkit-scrollbar-thumb {
  background: rgba(180, 83, 9, 0.2);
  border-radius: 3px;
}
.custom-scrollbar::-webkit-scrollbar-thumb:hover {
  background: rgba(180, 83, 9, 0.4);
}

@keyframes fade-in {
  from { opacity: 0; transform: scale(0.95); }
  to { opacity: 1; transform: scale(1); }
}
.animate-fade-in {
  animation: fade-in 0.2s ease-out;
}
</style>

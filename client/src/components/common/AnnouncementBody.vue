<template>
  <div class="space-y-2">
    <template v-for="(seg, index) in segments" :key="index">
      <p
        v-if="seg.type === 'text'"
        class="text-xs leading-relaxed whitespace-pre-line"
        :class="textClass"
      >{{ seg.text }}</p>
      <div v-else-if="seg.uploading" class="flex items-center gap-2 text-xs text-fg-faint border border-dashed border-line rounded px-3 py-4">
        <span class="inline-block w-3 h-3 rounded-full border border-current border-t-transparent animate-spin shrink-0" aria-hidden="true"></span>
        图片上传中…
      </div>
      <img
        v-else
        :src="seg.url"
        alt="公告配图"
        class="w-full max-h-64 object-contain rounded border border-line cursor-zoom-in"
        :class="imageClass"
        @click="openImage(seg.url)"
      >
    </template>
  </div>
</template>

<script setup>
/**
 * 公告正文渲染（图文混排）
 * 按 content 里的 ![图片](url) 标记原位展示；旧数据无标记时把 imageUrls 接在文末。
 */
import { computed } from 'vue'
import { parseAnnouncementSegments } from '../../utils/announcementContent'

const props = defineProps({
  content: { type: String, default: '' },
  /** 旧格式兜底配图（metadata.imageUrls） */
  imageUrls: { type: Array, default: () => [] },
  textClass: { type: String, default: 'text-fg-secondary' },
  imageClass: { type: String, default: '' }
})

const segments = computed(() => parseAnnouncementSegments(props.content, props.imageUrls))

const openImage = (url) => {
  if (url) window.open(url, '_blank', 'noopener')
}
</script>

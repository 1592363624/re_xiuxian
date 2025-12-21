<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { usePlayerStore } from '../../stores/player'
import { useUIStore } from '../../stores/ui'

const playerStore = usePlayerStore()
const uiStore = useUIStore()

const isTrying = ref(false)
const isPlaying = ref(false)
const animKey = ref(0)
const displayRealmName = ref('')
const displayTitle = ref('破境')

const canvasRef = ref(null)
let rafId = null
let offCanvas = null
let offCtx = null

const quality = ref('medium')
const pool = []
let maxPoolSize = 0

const canBreakthrough = computed(() => {
  const p = playerStore.player
  if (!p) return false

  if (p.can_breakthrough === true) return true

  const exp = BigInt(p.exp || 0)
  const cap = BigInt(p.exp_cap || p.exp_next || 0)
  return cap > 0n && exp >= cap && !!p.next_realm
})

const nextRealmName = computed(() => playerStore.player?.next_realm || '')

const clamp = (v, min, max) => Math.max(min, Math.min(max, v))
const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3)

const detectQuality = () => {
  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  if (reduceMotion) return 'low'

  const cores = navigator.hardwareConcurrency || 4
  const memory = navigator.deviceMemory || 4

  if (cores >= 8 && memory >= 8) return 'high'
  if (cores >= 4 && memory >= 4) return 'medium'
  return 'low'
}

const getLOD = () => {
  if (quality.value === 'high') return { particleCount: 220, blurMax: 10, scale: 1 }
  if (quality.value === 'medium') return { particleCount: 140, blurMax: 6, scale: 0.9 }
  return { particleCount: 80, blurMax: 0, scale: 0.8 }
}

const initPool = () => {
  maxPoolSize = 220
  pool.length = 0
  for (let i = 0; i < maxPoolSize; i++) {
    pool.push({
      active: false,
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      life: 0,
      ttl: 0,
      size: 0,
      hue: 0
    })
  }
}

const resizeCanvas = () => {
  const canvas = canvasRef.value
  if (!canvas) return
  const lod = getLOD()
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  const w = Math.floor(window.innerWidth * dpr * lod.scale)
  const h = Math.floor(window.innerHeight * dpr * lod.scale)
  canvas.width = w
  canvas.height = h
  canvas.style.width = '100%'
  canvas.style.height = '100%'

  if (!offCanvas) offCanvas = document.createElement('canvas')
  offCanvas.width = w
  offCanvas.height = h
  offCtx = offCanvas.getContext('2d')
}

const stopAnimation = () => {
  if (rafId) cancelAnimationFrame(rafId)
  rafId = null
  isPlaying.value = false
}

const playAnimation = (newRealm) => {
  stopAnimation()
  animKey.value++
  displayRealmName.value = newRealm || ''
  displayTitle.value = newRealm ? `突破·${newRealm}` : '破境'
  isPlaying.value = true

  const canvas = canvasRef.value
  const ctx = canvas?.getContext('2d')
  if (!canvas || !ctx) {
    isPlaying.value = false
    return
  }

  resizeCanvas()

  const lod = getLOD()
  const duration = 2550
  const start = performance.now()
  const cx = canvas.width / 2
  const cy = canvas.height / 2
  const particleCount = lod.particleCount
  const blurMax = lod.blurMax

  for (let i = 0; i < particleCount; i++) {
    const p = pool[i]
    const angle = Math.random() * Math.PI * 2
    const speed = (Math.random() * 0.8 + 0.2) * (canvas.width * 0.00065) * (quality.value === 'high' ? 1.2 : 1)
    p.active = true
    p.x = cx
    p.y = cy
    p.vx = Math.cos(angle) * speed * (0.8 + Math.random() * 1.2)
    p.vy = Math.sin(angle) * speed * (0.8 + Math.random() * 1.2)
    p.ttl = 0.9 + Math.random() * 0.5
    p.life = 0
    p.size = (Math.random() * 2.2 + 1.2) * (quality.value === 'low' ? 0.9 : 1)
    p.hue = 35 + Math.random() * 220
  }
  for (let i = particleCount; i < maxPoolSize; i++) {
    pool[i].active = false
  }

  const drawFrame = (now) => {
    const elapsed = now - start
    const t = clamp(elapsed / duration, 0, 1)
    const e = easeOutCubic(t)
    const pulse = Math.sin(Math.PI * clamp(t / 0.85, 0, 1))
    const blur = blurMax * pulse

    const drawCtx = blurMax > 0 && offCtx ? offCtx : ctx
    if (drawCtx !== ctx) {
      drawCtx.clearRect(0, 0, offCanvas.width, offCanvas.height)
    } else {
      ctx.clearRect(0, 0, canvas.width, canvas.height)
    }

    drawCtx.save()
    drawCtx.globalCompositeOperation = 'source-over'
    drawCtx.fillStyle = `rgba(0,0,0,${0.35 - 0.22 * e})`
    drawCtx.fillRect(0, 0, canvas.width, canvas.height)

    drawCtx.globalCompositeOperation = 'lighter'
    drawCtx.filter = blurMax > 0 ? `blur(${blur}px)` : 'none'

    const burstRadius = e * Math.min(canvas.width, canvas.height) * 0.38
    const g = drawCtx.createRadialGradient(cx, cy, 0, cx, cy, burstRadius)
    g.addColorStop(0, `rgba(255,226,128,${0.55 * (1 - t)})`)
    g.addColorStop(0.35, `rgba(168,85,247,${0.35 * (1 - t)})`)
    g.addColorStop(0.7, `rgba(56,189,248,${0.22 * (1 - t)})`)
    g.addColorStop(1, 'rgba(0,0,0,0)')
    drawCtx.fillStyle = g
    drawCtx.beginPath()
    drawCtx.arc(cx, cy, burstRadius, 0, Math.PI * 2)
    drawCtx.fill()

    for (let i = 0; i < particleCount; i++) {
      const p = pool[i]
      if (!p.active) continue
      p.life += 1 / 60
      const lt = clamp(p.life / p.ttl, 0, 1)
      const fade = (1 - lt) * (1 - 0.25 * t)
      p.x += p.vx
      p.y += p.vy
      p.vx *= 0.985
      p.vy *= 0.985

      const r = 210 + 35 * Math.sin((p.hue * Math.PI) / 180)
      const b = 180 + 65 * Math.cos((p.hue * Math.PI) / 180)
      drawCtx.fillStyle = `rgba(${Math.floor(r)},${Math.floor(170 + 55 * Math.cos(p.hue))},${Math.floor(b)},${0.85 * fade})`
      drawCtx.beginPath()
      drawCtx.arc(p.x, p.y, p.size * (1 + 0.8 * pulse), 0, Math.PI * 2)
      drawCtx.fill()
    }

    drawCtx.restore()

    if (drawCtx !== ctx) {
      ctx.save()
      ctx.globalCompositeOperation = 'source-over'
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      ctx.drawImage(offCanvas, 0, 0)
      ctx.restore()
    }

    if (t < 1) {
      rafId = requestAnimationFrame(drawFrame)
    } else {
      stopAnimation()
    }
  }

  rafId = requestAnimationFrame(drawFrame)
}

const handleBreakthroughClick = async () => {
  if (isTrying.value || !canBreakthrough.value) return

  isTrying.value = true
  try {
    const res = await playerStore.tryBreakthrough()
    if (!res) return

    if (res.success) {
      playAnimation(res.data?.new_realm || nextRealmName.value)
      uiStore.showToast(res.message || '突破成功', 'success')
    } else {
      uiStore.showToast(res.message || '突破失败', 'warning')
    }
  } catch (error) {
    const msg = error?.response?.data?.message || error?.response?.data?.error || '突破失败'
    uiStore.showToast(msg, 'error')
  } finally {
    isTrying.value = false
  }
}

watch(() => isPlaying.value, (val) => {
  if (val) return
  displayRealmName.value = ''
})

onMounted(() => {
  quality.value = detectQuality()
  initPool()
  resizeCanvas()
  window.addEventListener('resize', resizeCanvas)
})

onUnmounted(() => {
  stopAnimation()
  window.removeEventListener('resize', resizeCanvas)
})
</script>

<template>
  <div>
    <button
      v-if="playerStore.player && canBreakthrough"
      class="fixed right-6 bottom-24 z-50 px-5 py-3 rounded-xl border text-sm font-bold tracking-widest select-none
             text-amber-200 border-amber-400/80 bg-gradient-to-br from-amber-700/20 via-yellow-600/10 to-orange-500/10
             shadow-[0_0_20px_rgba(251,191,36,0.35),inset_0_0_12px_rgba(251,191,36,0.15)]
             hover:shadow-[0_0_28px_rgba(251,191,36,0.55),inset_0_0_14px_rgba(251,191,36,0.25)]
             hover:border-amber-300/90 hover:text-amber-100 hover:-translate-y-0.5 active:translate-y-0 active:scale-[0.98]
             transition-all duration-200"
      :disabled="isTrying || isPlaying"
      @click="handleBreakthroughClick"
    >
      <span class="inline-flex items-center gap-2">
        <span class="w-2.5 h-2.5 rounded-full bg-amber-300 shadow-[0_0_14px_rgba(251,191,36,0.9)] animate-pulse"></span>
        突破
      </span>
    </button>

    <Teleport to="body">
      <div
        v-if="isPlaying"
        :key="animKey"
        class="fixed inset-0 z-[70] flex items-center justify-center pointer-events-none overflow-hidden"
      >
        <div class="absolute inset-0 bg-black/70 backdrop-blur-[2px]"></div>
        <canvas ref="canvasRef" class="absolute inset-0 w-full h-full"></canvas>

        <div class="relative z-10 flex flex-col items-center justify-center">
          <div class="bt-ring"></div>
          <div class="mt-8 text-center">
            <div class="bt-title">{{ displayTitle }}</div>
            <div v-if="displayRealmName" class="bt-subtitle">气机翻涌，已入新境</div>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.bt-ring {
  width: min(48vw, 420px);
  height: min(48vw, 420px);
  border-radius: 9999px;
  border: 2px solid rgba(251, 191, 36, 0.35);
  box-shadow:
    0 0 40px rgba(251, 191, 36, 0.18),
    inset 0 0 30px rgba(168, 85, 247, 0.14);
  background: radial-gradient(circle at 50% 50%, rgba(251,191,36,0.15), rgba(168,85,247,0.06) 55%, rgba(0,0,0,0) 70%);
  filter: blur(0px);
  animation: btRing 2.55s ease-out both;
}

.bt-title {
  font-size: clamp(22px, 3.5vw, 46px);
  font-weight: 800;
  letter-spacing: 0.28em;
  color: rgba(255, 234, 170, 0.95);
  text-shadow:
    0 0 18px rgba(251, 191, 36, 0.25),
    0 0 32px rgba(168, 85, 247, 0.22);
  transform: translateY(8px);
  opacity: 0;
  animation: btTitle 2.55s ease-out both;
}

.bt-subtitle {
  margin-top: 10px;
  font-size: clamp(12px, 1.6vw, 16px);
  letter-spacing: 0.2em;
  color: rgba(216, 180, 254, 0.9);
  opacity: 0;
  animation: btSub 2.55s ease-out both;
}

@keyframes btRing {
  0% {
    transform: scale(0.55) rotate(0deg);
    opacity: 0;
    filter: blur(6px);
  }
  18% {
    opacity: 1;
    filter: blur(1px);
  }
  45% {
    transform: scale(1.02) rotate(38deg);
  }
  70% {
    transform: scale(1.08) rotate(86deg);
    opacity: 0.92;
  }
  100% {
    transform: scale(1.18) rotate(120deg);
    opacity: 0;
    filter: blur(10px);
  }
}

@keyframes btTitle {
  0% {
    opacity: 0;
    transform: translateY(12px) scale(0.98);
    filter: blur(8px);
  }
  22% {
    opacity: 1;
    transform: translateY(0px) scale(1);
    filter: blur(0px);
  }
  70% {
    opacity: 1;
  }
  100% {
    opacity: 0;
    transform: translateY(-10px) scale(1.02);
    filter: blur(6px);
  }
}

@keyframes btSub {
  0% {
    opacity: 0;
    transform: translateY(10px);
  }
  30% {
    opacity: 0.9;
    transform: translateY(0px);
  }
  85% {
    opacity: 0.75;
  }
  100% {
    opacity: 0;
    transform: translateY(-10px);
  }
}
</style>


/** @type {import('tailwindcss').Config} */

// 令牌以 RGB 通道三元组存放在 tokens.css，这里包一层以便 Tailwind
// 仍然支持 bg-surface-raised/60 这种透明度修饰符。
const token = (name) => `rgb(var(--${name}) / <alpha-value>)`

const surface = {
  sunken: token('surface-sunken'),
  canvas: token('surface-canvas'),
  base: token('surface-base'),
  raised: token('surface-raised'),
  hover: token('surface-hover'),
  active: token('surface-active'),
  'tint-gold': token('surface-tint-gold'),
  'tint-gold-strong': token('surface-tint-gold-strong'),
  'tint-jade': token('surface-tint-jade'),
  'tint-arcane': token('surface-tint-arcane'),
}

export default {
  content: [
    "./index.html",
    "./src/**/*.{vue,js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        surface,
        line: {
          subtle: token('line-subtle'),
          DEFAULT: token('line'),
          strong: token('line-strong'),
        },
        fg: {
          primary: token('fg-primary'),
          secondary: token('fg-secondary'),
          muted: token('fg-muted'),
          faint: token('fg-faint'),
        },
        gold: {
          200: token('gold-200'),
          300: token('gold-300'),
          400: token('gold-400'),
          500: token('gold-500'),
          600: token('gold-600'),
          700: token('gold-700'),
          800: token('gold-800'),
          900: token('gold-900'),
        },
        state: {
          success: token('state-success'),
          warning: token('state-warning'),
          danger: token('state-danger'),
          info: token('state-info'),
          arcane: token('state-arcane'),
        },
        // 兼容早期遗留命名，避免旧类名静默失效；新代码请用 surface-*
        'xiuxian-dark': '#0f172a',
        'xiuxian-gold': '#f59e0b',
        'xiuxian-text': '#e2e8f0',
      },
      fontFamily: {
        sans: ['var(--font-ui)'],
        serif: ['var(--font-display)'],
        mono: ['var(--font-num)'],
        display: ['var(--font-display)'],
        num: ['var(--font-num)'],
      },
      borderRadius: {
        panel: 'var(--radius-panel)',
        control: 'var(--radius-control)',
      },
      maxWidth: {
        dock: 'var(--dock-width-cap)',
      },
      // 层叠秩序。裸 z-50 / z-[60] 让面板、聊天、死亡遮罩挤在同一层，
      // 谁盖住谁只由渲染顺序决定；统一走这一套命名层级。
      zIndex: {
        nav: 'var(--z-nav)',
        floating: 'var(--z-floating)',
        panel: 'var(--z-panel)',
        companion: 'var(--z-companion)',
        system: 'var(--z-system)',
        dialog: 'var(--z-dialog)',
        toast: 'var(--z-toast)',
        lightbox: 'var(--z-lightbox)',
      },
    },
  },
  plugins: [],
}

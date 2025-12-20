/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{vue,js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        'xiuxian-dark': '#0f172a',
        'xiuxian-gold': '#f59e0b',
        'xiuxian-text': '#e2e8f0',
      }
    },
  },
  plugins: [],
}

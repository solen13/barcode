export default defineNuxtConfig({
  compatibilityDate: '2026-07-24',
  devtools: { enabled: true },
  build: {
    transpile: ['@zxing/browser', '@zxing/library', 'read-excel-file']
  },
  vite: {
    optimizeDeps: {
      exclude: ['@zxing/browser', '@zxing/library', 'read-excel-file']
    }
  }
})

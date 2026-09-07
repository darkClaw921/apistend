import { defineConfig } from 'vitest/config'
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    // Туннель поднимает настоящий сервер и настоящее приложение — это дольше юнитов.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Тесты трогают одну и ту же базу, параллельные файлы мешали бы друг другу.
    fileParallelism: false,
  },
})

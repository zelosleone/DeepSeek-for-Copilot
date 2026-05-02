import { defineConfig } from 'vitest/config';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      vscode: resolve(__dirname, 'src/test/vscode-stub.ts'),
    },
  },
  test: {
    include: ['src/test/**/*.test.ts'],
  },
});

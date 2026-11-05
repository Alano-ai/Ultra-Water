import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

// 构建产物会随附所用 npm 包的许可（licenses.md）以及改编代码的许可（THIRD_PARTY_NOTICES.md）
export default defineConfig({
  build: { license: { fileName: 'licenses.md' } },
  plugins: [{
    name: 'third-party-notices',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'THIRD_PARTY_NOTICES.md', source: readFileSync('THIRD_PARTY_NOTICES.md', 'utf8') });
    },
  }],
});

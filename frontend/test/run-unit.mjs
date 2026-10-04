// 单元测试入口：用 esbuild 把 TS 测试打包成 ESM 后直接跑，不引测试框架。
import { buildSync } from 'esbuild'
import { pathToFileURL } from 'node:url'

const outfile = new URL('./.plot-review.test.mjs', import.meta.url).pathname
buildSync({
  entryPoints: ['test/plot-review.test.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile,
  logLevel: 'warning',
})
await import(pathToFileURL(outfile).href)

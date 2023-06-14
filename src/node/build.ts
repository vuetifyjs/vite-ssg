/* eslint-disable no-console */
import { join } from 'node:path'
import fs from 'fs-extra'
import type { ResolvedConfig } from 'vite'
import { resolveConfig, build as viteBuild } from 'vite'
import type { RollupOutput } from 'rollup'
import chalk from 'chalk'
import type { ViteSSGOptions } from '../client'

export interface Manifest {
  [key: string]: string[]
}

export async function build(cliOptions: Partial<ViteSSGOptions> = {}) {
  const mode = process.env.MODE || process.env.NODE_ENV || cliOptions.mode || 'production'
  const config = await resolveConfig({}, 'build', mode)

  const cwd = process.cwd()
  const root = config.root || cwd
  const ssgOut = join(root, '.vite-ssg-temp')

  const {
    entry = await detectEntry(root),
    onAfterClientBuild,
  }: ViteSSGOptions = Object.assign({}, config.ssgOptions || {}, cliOptions)

  if (fs.existsSync(ssgOut))
    await fs.remove(ssgOut)

  // client
  console.log(`\n${chalk.gray('[vite-ssg]')} ${chalk.yellow('Build for client...')}`)
  await viteBuild({
    build: {
      ssrManifest: true,
      rollupOptions: {
        input: {
          app: join(root, './index.html'),
        },
      },
    },
    mode: config.mode,
  }) as RollupOutput
  onAfterClientBuild?.()

  // server
  console.log(`\n${chalk.gray('[vite-ssg]')} ${chalk.yellow('Build for server...')}`)
  process.env.VITE_SSG = 'true'
  const ssrEntry = await resolveAlias(config, entry)
  await viteBuild({
    build: {
      ssr: ssrEntry,
      outDir: ssgOut,
      minify: false,
      cssCodeSplit: false,
      rollupOptions: {
        output: {
          entryFileNames: '[name].mjs',
          format: 'esm',
        },
      },
    },
    mode: config.mode,
  })
}

async function detectEntry(root: string) {
  // pick the first script tag of type module as the entry
  const scriptSrcReg = /<script(?:.*?)src=["'](.+?)["'](?!<)(?:.*)\>(?:[\n\r\s]*?)(?:<\/script>)/img
  const html = await fs.readFile(join(root, 'index.html'), 'utf-8')
  const scripts = [...html.matchAll(scriptSrcReg)] || []
  const [, entry] = scripts.find((matchResult) => {
    const [script] = matchResult
    const [, scriptType] = script.match(/.*\stype=(?:'|")?([^>'"\s]+)/i) || []
    return scriptType === 'module'
  }) || []
  return entry || 'src/main.ts'
}

async function resolveAlias(config: ResolvedConfig, entry: string) {
  const resolver = config.createResolver()
  const result = await resolver(entry, config.root)
  return result || join(config.root, entry)
}

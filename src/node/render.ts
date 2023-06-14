/* eslint-disable no-console */
import { isAbsolute, join, parse } from 'node:path'
import inspector from 'node:inspector'
import os from 'node:os'
import chalk from 'chalk'
import fs from 'fs-extra'
import type { ResolvedConfig } from 'vite'
import { resolveConfig } from 'vite'
import type { VitePluginPWAAPI } from 'vite-plugin-pwa'
import Piscina from 'piscina'
import type { ViteSSGOptions } from '../client'
import { routesToPaths } from './utils'
import { getCritters } from './critical'
import type { CreateAppFactory, WorkerContext } from './renderWorker'

interface Manifest {
  [key: string]: string[]
}

function DefaultIncludedRoutes(paths: string[]) {
  // ignore dynamic routes
  return paths.filter(i => !i.includes(':') && !i.includes('*'))
}

export async function render(cliOptions: Partial<ViteSSGOptions> = {}) {
  const mode = process.env.MODE || process.env.NODE_ENV || cliOptions.mode || 'production'
  process.env.NODE_ENV = mode
  const config = await resolveConfig({}, 'build', mode)

  const cwd = process.cwd()
  const root = config.root || cwd
  const ssgOut = join(root, '.vite-ssg-temp')
  const outDir = config.build.outDir || 'dist'
  const out = isAbsolute(outDir) ? outDir : join(root, outDir)

  const {
    script = 'sync',
    mock = false,
    entry = await detectEntry(root),
    formatting = 'none',
    crittersOptions = {},
    includedRoutes = DefaultIncludedRoutes,
    // onBeforePageRender,
    // onPageRendered,
    onFinished,
    dirStyle = 'flat',
    includeAllRoutes = false,
  }: ViteSSGOptions = Object.assign({}, config.ssgOptions || {}, cliOptions)

  const ssrEntry = await resolveAlias(config, entry)
  const prefix = process.platform === 'win32' ? 'file://' : ''
  const ssrEntryPath = join(prefix, ssgOut, `${parse(ssrEntry).name}.mjs`)

  const { createApp } = await import(ssrEntryPath) as { createApp: CreateAppFactory }

  const { routes } = await createApp(false)

  let routesPaths = includeAllRoutes
    ? routesToPaths(routes)
    : await includedRoutes(routesToPaths(routes))

  // uniq
  routesPaths = Array.from(new Set(routesPaths))

  const critters = crittersOptions !== false ? await getCritters(outDir, crittersOptions) : undefined
  if (critters)
    console.log(`${chalk.gray('[vite-ssg]')} ${chalk.blue('Critical CSS generation enabled via `critters`')}`)

  if (mock) {
    /*
      remove manual `new VirtualConsole()`, as it did not forward the console correctly

      https://github.com/jsdom/jsdom#virtual-consoles:
      "By default, the JSDOM constructor will return an instance with a virtual console that forwards all its output to the Node.js console."
    */
    // const jsdom = new JSDOM('', { url: 'http://localhost' })
    // // @ts-ignore
    // global.window = jsdom.window
    // Object.assign(global, jsdom.window) // FIXME: throws an error when using esm

    // @ts-expect-error no types
    const jsdomGlobal = (await import('./jsdomGlobal')).default
    jsdomGlobal()
  }

  const ssrManifest: Manifest = JSON.parse(await fs.readFile(join(out, 'ssr-manifest.json'), 'utf-8'))
  const indexHTML = await fs.readFile(join(ssgOut, 'index.html'), 'utf-8')
    .catch(async () => {
      let indexHTML = await fs.readFile(join(out, 'index.html'), 'utf-8')
      indexHTML = rewriteScripts(indexHTML, script)
      await fs.writeFile(join(ssgOut, 'index.html'), indexHTML, 'utf-8')
      return indexHTML
    })

  const maxThreads = inspector.url() ? 1 : Math.max(1, Math.floor(Math.min(os.cpus().length / 2, os.freemem() / (1.1 * 1024 ** 3))))
  console.log(`\n${chalk.gray('[vite-ssg]')} ${chalk.yellow('Rendering')} ${chalk.blue(routesPaths.length)} ${chalk.yellow('pages...')} ${chalk.gray(`(${maxThreads} threads)`)}`)
  const pool = new Piscina({
    filename: new URL('./renderWorker.mjs', import.meta.url).pathname,
    niceIncrement: 10,
    maxThreads,
  })
  await Promise.all(
    routesPaths.map((route) => {
      return pool.run({
        route,
        dirStyle,
        outDir,
        indexHTML,
        formatting,
        out,
        ssrEntryPath,
        ssrManifest,
      } satisfies WorkerContext)
    }),
  )

  // await fs.remove(ssgOut)

  // when `vite-plugin-pwa` is presented, use it to regenerate SW after rendering
  const pwaPlugin: VitePluginPWAAPI = config.plugins.find(i => i.name === 'vite-plugin-pwa')?.api
  if (pwaPlugin?.generateSW) {
    console.log(`\n${chalk.gray('[vite-ssg]')} ${chalk.yellow('Regenerate PWA...')}`)
    await pwaPlugin.generateSW()
  }

  console.log(`\n${chalk.gray('[vite-ssg]')} ${chalk.green('Build finished.')}`)

  await onFinished?.()

  // ensure build process always exits
  const waitInSeconds = 15
  const timeout = setTimeout(() => {
    console.log(`${chalk.gray('[vite-ssg]')} ${chalk.yellow(`Build process still running after ${waitInSeconds}s. There might be something misconfigured in your setup. Force exit.`)}`)
    process.exit(0)
  }, waitInSeconds * 1000)
  timeout.unref() // don't wait for timeout
}

function rewriteScripts(indexHTML: string, mode?: string) {
  if (!mode || mode === 'sync')
    return indexHTML
  return indexHTML.replace(/<script type="module" /g, `<script type="module" ${mode} `)
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

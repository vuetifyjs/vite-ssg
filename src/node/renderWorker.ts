/* eslint-disable no-console */
import { dirname, join } from 'node:path'
import chalk from 'chalk'
import type { SSRContext } from 'vue/server-renderer'
import { renderToString } from 'vue/server-renderer'
import { JSDOM } from 'jsdom'
import fs from 'fs-extra'
import type { ViteSSGContext, ViteSSGOptions } from '../types'
import { renderPreloadLinks } from './preload-links'

export type CreateAppFactory = (client: boolean, routePath?: string) => Promise<ViteSSGContext<true> | ViteSSGContext<false>>

export interface WorkerContext {
  route: string
  dirStyle: ViteSSGOptions['dirStyle']
  outDir: string
  indexHTML: string
  formatting: ViteSSGOptions['formatting']
  out: string
  ssrEntryPath: string
  ssrManifest: Record<string, string[]>
}

export default async ({ route, dirStyle, outDir, indexHTML, formatting, out, ssrEntryPath, ssrManifest }: WorkerContext) => {
  try {
    const { createApp } = await import(ssrEntryPath) as { createApp: CreateAppFactory }

    const relativeRouteFile = `${(route.endsWith('/') ? `${route}index` : route).replace(/^\//g, '')}.html`
    const filename = dirStyle === 'nested'
      ? join(route.replace(/^\//g, ''), 'index.html')
      : relativeRouteFile

    console.log(
      `Page ${chalk.dim(`${outDir}/`)}${chalk.cyan(filename.padEnd(15, ' '))}`,
    )

    const appCtx = await createApp(false, route) as ViteSSGContext<true>
    const { app, router, head, initialState } = appCtx

    if (router) {
      await router.push(route)
      await router.isReady()
    }

    const transformedIndexHTML = /* (await onBeforePageRender?.(route, indexHTML, appCtx)) || */ indexHTML

    const ctx: SSRContext = {}
    const appHTML = await renderToString(app, ctx)

    // need to resolve assets so render content first
    const renderedHTML = renderHTML({ indexHTML: transformedIndexHTML, appHTML, initialState })

    // create jsdom from renderedHTML
    const jsdom = new JSDOM(renderedHTML)

    // render current page's preloadLinks
    renderPreloadLinks(jsdom.window.document, ctx.modules || new Set<string>(), ssrManifest)

    // render head
    head?.updateDOM(jsdom.window.document)

    const html = jsdom.serialize()
    const transformed = /* (await onPageRendered?.(route, html, appCtx)) || */ html
    // if (critters)
    //   transformed = await critters.process(transformed)

    const formatted = await format(transformed, formatting)

    await fs.ensureDir(join(out, dirname(filename)))
    await fs.writeFile(join(out, filename), formatted, 'utf-8')

    // cleanup
    delete (app as any).config.errorHandler
    delete (app as any).config.globalProperties
    delete (app as any)._context.provides
    delete (app as any)._context.components
    delete (app as any)._context.mixins
    delete (app as any)._context.config
    delete (app as any)._context
    delete (app as any)._component
  }
  catch (err: any) {
    console.error(`${chalk.gray('[vite-ssg]')} ${chalk.red(`Error on page: ${chalk.cyan(route)}`)}\n${err.stack}`)
  }
}

function renderHTML({ indexHTML, appHTML, initialState }: { indexHTML: string; appHTML: string; initialState: any }) {
  const stateScript = initialState
    ? `\n<script>window.__INITIAL_STATE__=${initialState}</script>`
    : ''
  return indexHTML
    .replace(
      '<div id="app"></div>',
      `<div id="app" data-server-rendered="true">${appHTML}</div>${stateScript}`,
    )
}

async function format(html: string, formatting: ViteSSGOptions['formatting']) {
  if (formatting === 'minify') {
    const htmlMinifier = await import('html-minifier')
    return htmlMinifier.minify(html, {
      collapseWhitespace: true,
      caseSensitive: true,
      collapseInlineTagWhitespace: false,
      minifyJS: true,
      minifyCSS: true,
    })
  }
  else if (formatting === 'prettify') {
    // @ts-expect-error untyped
    const prettier = (await import('prettier/esm/standalone.mjs')).default
    // @ts-expect-error untyped
    const parserHTML = (await import('prettier/esm/parser-html.mjs')).default

    return prettier.format(html, { semi: false, parser: 'html', plugins: [parserHTML] })
  }
  return html
}

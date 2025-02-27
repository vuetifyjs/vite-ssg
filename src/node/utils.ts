import type { RouteRecordRaw } from 'vue-router'

export function getSize(str: string) {
  return `${(str.length / 1024).toFixed(2)} KiB`
}

export function routesToPaths(routes?: RouteRecordRaw[]) {
  if (!routes)
    return ['/']

  const paths: Set<string> = new Set()

  const getPaths = (routes: RouteRecordRaw[], prefix = '') => {
    // remove trailing slash
    prefix = prefix.replace(/\/$/g, '')
    for (const route of routes) {
      let path = route.path
      // check for leading slash
      if (route.path) {
        path = prefix && !route.path.startsWith('/')
          ? `${prefix}/${route.path}`
          : route.path

        paths.add(path)
      }
      if (Array.isArray(route.children))
        getPaths(route.children, path)
    }
  }

  getPaths(routes)
  return [...paths]
}

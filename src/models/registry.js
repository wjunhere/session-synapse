/**
 * The model catalog, read from pi's own files.
 *
 * Context usage is a percentage of a model's context window, so the canvas
 * needs `provider/model-id → contextWindow`. pi keeps that in two places:
 *
 *   - `~/.pi/agent/models.json`        — user-declared providers (authoritative)
 *   - `~/.pi/agent/models-store.json`  — fetched catalog cache, keyed by provider
 *
 * Both are read once and cached. They are small JSON files (tens of KB) and
 * change rarely, so the cache is refreshed on an interval rather than watched.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const REFRESH_MS = 60_000

/** @typedef {{ window: number, provider: string, id: string, name: string|null }} ModelInfo */

/**
 * What `createModelRegistry` returns.
 *
 * Declared rather than left inferred: adapters accept a registry override and
 * a bare `object` there makes every `registry.contextWindow(...)` call report
 * as a missing property.
 *
 * @typedef {object} ModelRegistry
 * @property {(provider: string, id: string) => Promise<number|null>} contextWindow
 * @property {(provider: string, id: string) => Promise<ModelInfo|null>} lookup
 * @property {() => void} invalidate  test seam: reload on the next lookup
 */

/** @returns {ModelRegistry} */
export function createModelRegistry(agentDir, { refreshMs = REFRESH_MS } = {}) {
  /** @type {Map<string, ModelInfo>} */
  let catalog = new Map()
  let loading = null
  let loadedAt = 0

  const key = (provider, id) => `${provider ?? ''}\u0000${id}`

  async function readJson(path) {
    try {
      return JSON.parse(await readFile(path, 'utf8'))
    } catch {
      return null
    }
  }

  function collect(index, provider, defs) {
    for (const model of defs ?? []) {
      if (typeof model?.id !== 'string' || model.id === '') continue
      const owner = typeof model.provider === 'string' && model.provider !== '' ? model.provider : provider
      if (typeof model.contextWindow !== 'number' || !(model.contextWindow > 0)) continue
      index.set(key(owner, model.id), {
        window: model.contextWindow,
        provider: owner ?? '',
        id: model.id,
        name: typeof model.name === 'string' ? model.name : null,
      })
    }
  }

  async function load() {
    const index = new Map()
    // The fetched cache goes in first: it covers models the user config does
    // not mention. The user config is applied on top, so an explicit window in
    // models.json wins for a key both describe.
    const store = await readJson(join(agentDir, 'models-store.json'))
    for (const [provider, def] of Object.entries(store ?? {})) collect(index, provider, def?.models)
    const config = await readJson(join(agentDir, 'models.json'))
    for (const [provider, def] of Object.entries(config?.providers ?? {})) collect(index, provider, def?.models)
    catalog = index
    loadedAt = Date.now()
    return index
  }

  /** Ensure the catalog is loaded, at most once per refresh window. */
  function ensure() {
    if (Date.now() - loadedAt < refreshMs && catalog.size > 0) return Promise.resolve(catalog)
    loading ??= load().finally(() => { loading = null })
    return loading
  }

  return {
    /** The context window for a model, or null when unknown. */
    async contextWindow(provider, id) {
      if (typeof id !== 'string' || id === '') return null
      const index = await ensure()
      return index.get(key(provider, id))?.window ?? null
    },
    /** The full entry, for the card's hover detail. */
    async lookup(provider, id) {
      if (typeof id !== 'string' || id === '') return null
      const index = await ensure()
      return index.get(key(provider, id)) ?? null
    },
    /** Test seam: force a reload on the next lookup. */
    invalidate() { catalog = new Map(); loadedAt = 0; loading = null },
  }
}

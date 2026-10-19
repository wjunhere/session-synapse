export { WorkspaceStore, normalizeState, foldLegacyToolCards, noteProjection, titleFromText, workspaceTitle, MAX_PROJECTION_LENGTH, PROJECTION_TRUNCATED_SUFFIX, STATE_VERSION } from './store/workspace-store.js'
export { Synapse } from './synapse.js'
export { createPiAdapter, defaultAgentDir, defaultSessionsDir, defaultDataFile, listSessionFiles, cwdFromDirName, sessionIdFromFileName } from './adapters/pi.js'
export { createDshAdapter } from './adapters/dsh.js'
export { createPiWebActions, HostRequestError } from './adapters/pi-web-actions.js'
export { projectPiSession, projectPiEntry, activeBranch, parseSessionLines, splitSession } from './project/pi.js'
export { projectDshSession, projectDshEvent, dshEntryId, contextUsageOf } from './project/dsh.js'
export { contextUsage, estimateContextTokens, effectiveModel } from './project/context-usage.js'
export { createModelRegistry } from './models/registry.js'
export { acquireInstanceLock, InstanceLockError } from './store/instance-lock.js'
export { createApiHandler, createAssetHandler, isSynapsePath } from './server/routes.js'
export { createGuard } from './server/guard.js'
export { createProxy, startServer } from './server/proxy.js'
// DSH plugin face.
//
// The DSH loader mounts a plugin package by its BARE name, and its client-module
// graph only recognises bare names (`exactPackageSpecifier` rejects subpaths, but
// accepts a scoped `@scope/name`), so this package's main entry has to BE the
// plugin — the same shape dsh-synapse and dsh-skill-mcp-panel ship. The library
// exports above stay as they were, so `import { Synapse } from
// '@wjunhere/session-synapse'` keeps working.
//
// `cordis.patch.yml` mounts this by name; the client half is
// `exports["./client"]` (src/host/dsh/client.js), which the browser loads from
// `/plugins/@wjunhere/session-synapse/client.js`. The name appears in FOUR
// places that must agree character for character: package.json `name`,
// cordis.patch.yml `name`, the client bundle's `load({ id })`, and the
// profile's dependency key.
export { name, inject, apply } from './host/dsh/index.js'
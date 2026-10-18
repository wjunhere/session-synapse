/**
 * Host-specific wording for the canvas chrome.
 *
 * The canvas is one page under two hosts (pi-web through a proxy, DSH through
 * its own web server), and the only thing that differs is what the buttons
 * promise: "在 pi-web 中打开" makes no sense inside DSH. The adapter id from
 * `/synapse/api/status` picks the row, so the canvas never guesses from the URL
 * or from a build flag.
 *
 * Keep this a LEAF module with no imports: it is part of the canvas module
 * graph, and every entry stays a plain string.
 */

/**
 * @typedef {object} HostLabels
 * @property {string} name            how the host is named in a button
 * @property {string} openIn          "open this session in the host"
 * @property {string} openInShort     the same as a button label
 * @property {string} archiveHint     what archiving keeps available
 * @property {string} startHint       empty-canvas hint
 * @property {string} toolsPinnedBy   who pinned a session's tool set
 * @property {string} btwArchiveHint  where a side question gets archived
 */

/** @type {Record<string, HostLabels>} */
const HOSTS = {
  'pi-web': {
    name: 'pi-web',
    openIn: '在 pi-web 中打开',
    openInShort: 'pi-web',
    archiveHint: '可在 pi-web 内继续查看',
    startHint: '在 pi-web 中开始一个会话后，它会作为一张卡片出现在这里。',
    toolsPinnedBy: 'pi-web 为这个会话固定的工具集',
    btwArchiveHint: '自动归档到 pi-web 归档视图',
  },
  dsh: {
    name: 'DSH',
    openIn: '在 DSH 中打开',
    openInShort: 'DSH',
    archiveHint: '可在 DSH 内继续查看',
    startHint: '在 DSH 中开始一个会话后，它会作为一张卡片出现在这里。',
    toolsPinnedBy: 'DSH 为这个会话固定的工具集',
    btwArchiveHint: '自动归档到 DSH 归档视图',
  },
}

/**
 * Wording for one adapter id.
 *
 * Before `/synapse/api/status` answers there is no id at all, and the canvas
 * must not show a host's name it has not been told: it says 宿主 until then.
 * An adapter this build has never heard of gets its own id as the name, which
 * is true even when the wording is not tailored.
 *
 * @param {string|undefined} adapterId
 * @returns {HostLabels}
 */
export function hostLabels(adapterId) {
  const id = typeof adapterId === 'string' && adapterId !== '' ? adapterId : null
  if (id === null) return genericLabels('宿主')
  return HOSTS[id] ?? genericLabels(id)
}

/** @returns {HostLabels} */
function genericLabels(name) {
  return {
    name,
    openIn: `在 ${name} 中打开`,
    openInShort: name,
    archiveHint: `可在 ${name} 内继续查看`,
    startHint: `在 ${name} 中开始一个会话后，它会作为一张卡片出现在这里。`,
    toolsPinnedBy: `${name} 为这个会话固定的工具集`,
    btwArchiveHint: `自动归档到 ${name} 归档视图`,
  }
}

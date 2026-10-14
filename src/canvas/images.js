/**
 * The browser half of the image-attachment pipeline.
 *
 * Images mirror pi-web's own limits because the same prompt command validates
 * them server-side: 10 images per message, 10MB each, and anything over 1MB
 * (except GIF, which compression would ruin) is downscaled to a 1024px JPEG
 * before it is sent. A client that skips the downscale still works up to 10MB,
 * but wastes context: a raw screenshot can be tens of megabytes of base64 for a
 * picture the model reads at low resolution anyway.
 *
 * Anything that cannot be sent is refused with a specific reason rather than
 * silently dropped — an oversized image that just vanishes looks like a broken
 * paste, and the host would reject the whole prompt anyway. Deciding those
 * messages (and re-rendering) belongs to the caller; this module only turns
 * files into payloads.
 */
import { imageMarkers } from './format.js'

export const MAX_IMAGES = 10
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024
export const IMAGE_COMPRESS_THRESHOLD_BYTES = 1024 * 1024
export const IMAGE_MAX_SIDE = 1024
export const IMAGE_JPEG_QUALITY = 0.85

export function readImageFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const data = typeof reader.result === 'string' ? reader.result.split(',')[1] : undefined
      if (data === undefined || data === '') reject(new Error('读取图片失败'))
      else resolve({ data, mimeType: file.type })
    }
    reader.onerror = () => reject(new Error('读取图片失败'))
    reader.readAsDataURL(file)
  })
}

/**
 * Shrink a large image before it is sent, exactly as pi-web's own input does.
 *
 * Only when the re-encode actually helps (and never for GIF, which is animated),
 * because re-compressing a small PNG adds artefacts for no context saving.
 */
export async function compressImageFile(file) {
  const original = () => readImageFile(file)
  const shouldCompress = file.size > IMAGE_COMPRESS_THRESHOLD_BYTES && file.type !== 'image/gif'
  if (!shouldCompress || typeof createImageBitmap !== 'function') return original()
  const bitmap = await createImageBitmap(file).catch(() => null)
  if (bitmap === null) return original()
  try {
    const scale = Math.min(1, IMAGE_MAX_SIDE / Math.max(bitmap.width, bitmap.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(bitmap.width * scale))
    canvas.height = Math.max(1, Math.round(bitmap.height * scale))
    const context = canvas.getContext('2d')
    if (context === null) return original()
    context.fillStyle = '#fff'
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    const data = canvas.toDataURL('image/jpeg', IMAGE_JPEG_QUALITY).split(',')[1]
    return data !== undefined && data !== '' && data.length < Math.ceil(file.size / 3) * 4
      ? { data, mimeType: 'image/jpeg' }
      : original()
  } catch {
    return original()
  } finally {
    bitmap.close()
  }
}

/** Release the object URLs of a draft's previews once they can no longer be seen. */
export function releaseDraftImages(draft) {
  for (const image of draft?.images ?? []) {
    if (typeof image.previewUrl === 'string') URL.revokeObjectURL(image.previewUrl)
  }
}

/** The `images` field the host's prompt command accepts. */
export const promptImages = images => (images ?? []).map(image => ({ type: 'image', data: image.data, mimeType: image.mimeType }))

/**
 * The transcript a draft will produce, including its image markers.
 *
 * Used for the optimistic pending message and for the branch/btw title: an
 * image-only message has no typed text to name itself with.
 */
export const draftMessageText = (text, images) => {
  const markers = imageMarkers((images ?? []).length)
  if (text === '') return markers
  return markers === '' ? text : `${text}\n${markers}`
}

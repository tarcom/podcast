const STORAGE_KEY = 'podcast_device_id'

export function getDeviceId(): string {
  const existing = localStorage.getItem(STORAGE_KEY)
  if (existing) {
    return existing
  }

  const generated =
    'dev-' + Math.random().toString(36).slice(2) + Date.now().toString(36)
  localStorage.setItem(STORAGE_KEY, generated)
  return generated
}

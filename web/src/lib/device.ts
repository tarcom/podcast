// Single-user indtil vi laver rigtigt login: ÉN fast session-id på tværs af alle
// enheder (PC + mobil), så favoritter og hørt-tilstand er de samme overalt.
// Når login kommer, mapper det bare til et stabilt device_id/user_id her.
const FIXED_DEVICE_ID = 'allan-main'

export function getDeviceId(): string {
  // overskriv evt. gammelt tilfældigt pr-browser-id
  try {
    localStorage.setItem('podcast_device_id', FIXED_DEVICE_ID)
  } catch {
    /* ignore */
  }
  return FIXED_DEVICE_ID
}

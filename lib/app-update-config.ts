/**
 * Handmatige config voor /app-update.json (zie api/app-update.ts).
 *
 * `latest` staat hier bewust NIET — die komt live uit de App Store.
 * Wat hier staat zijn beslissingen van Robin:
 *   - on:      toon de wegklikbare update-kaart als er een nieuwere versie is
 *   - minimum: versies ouder dan dit krijgen de noodrem "Update required"
 *              (niet weg te klikken). "0" = noodrem uit.
 */

export const APP_STORE_ID = '6771131989';

export const APP_UPDATE_CONFIG = {
  ios: { on: true, minimum: '0' },
  macos: { on: true, minimum: '0' },
} as const;

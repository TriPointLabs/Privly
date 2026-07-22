/**
 * Build-time configuration injected via Vite env vars. Global and GCC clouds
 * share one Entra app registration; GCCH and DoD share another. CONSENT_URL
 * builds the admin-consent link shown on the sign-in page.
 */
export const GLOBALS = {
  CLIENT_ID: {
    GLOBAL:     import.meta.env.VITE_GLOBAL_CLIENT_ID     as string | undefined,
    GOVERNMENT: import.meta.env.VITE_GOVERNMENT_CLIENT_ID as string | undefined,
  },
  CONSENT_URL: {
    GLOBAL:     (id: string) =>
      `https://login.microsoftonline.com/organizations/adminconsent?client_id=${id}`,
    GOVERNMENT: (id: string) =>
      `https://login.microsoftonline.us/organizations/adminconsent?client_id=${id}`,
  },
} as const;

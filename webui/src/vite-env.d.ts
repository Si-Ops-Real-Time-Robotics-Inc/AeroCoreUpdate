/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Keycloak realm URL, e.g. https://id.rtrobotics.com/realms/aerotunnel.
   * The realm belongs to proxy_alpha and is shared with the rest of the
   * platform. It is the only way in — empty builds a UI that cannot sign anyone in,
   * because this server holds no account of its own.
   */
  readonly VITE_OIDC_ISSUER?: string;
  /** Public (PKCE) client registered on that realm for this admin UI. */
  readonly VITE_OIDC_CLIENT_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

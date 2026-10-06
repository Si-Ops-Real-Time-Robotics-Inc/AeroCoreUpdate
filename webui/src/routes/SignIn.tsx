import { useQuery } from "@tanstack/react-query";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { login, oidcConfigured } from "@/lib/auth";
import { signInState } from "@/lib/signin-state";

/**
 * One way in.
 *
 * There is no password form and no second option, because this server holds no
 * credential that opens it (Constitution I, 2.0.0). That makes the unreachable
 * case the important one: when the realm cannot be reached there is nothing else
 * to try, and the screen has to say so plainly rather than fail in a way that
 * looks like a broken page.
 *
 * Whether to offer sign-in at all is asked of the SERVER: the bundle only knows
 * what it was built with, while the server knows whether the issuer is answering
 * right now.
 */
export function SignIn() {
  const oidc = useQuery({
    queryKey: ["oidc-status"],
    queryFn: api.oidcStatus,
    // An outage shows up here, so never serve a cached "reachable" from before it.
    staleTime: 0,
    retry: false,
  });

  // The screen renders one of these and nothing else. The decision lives in
  // lib/signin-state.ts so it can be tested without a DOM — and so the branch
  // under test is the branch that runs.
  const state = signInState(oidcConfigured, oidc.data, {
    loading: oidc.isPending,
    failed: oidc.isError,
  });

  return (
    <div className="grid min-h-screen place-items-center px-6">
      <div className="w-full max-w-sm">
        <h1 className="mb-1 text-xl font-semibold text-ink">AeroCoreUpdate</h1>
        <p className="mb-6 text-sm text-muted">Sign in to publish firmware.</p>

        {state.kind === "checking" ? <p className="text-sm text-muted">Checking sign-in…</p> : null}

        {state.kind === "ready" ? (
          <Button className="w-full" onClick={() => void login("/")}>
            Sign in with Keycloak
          </Button>
        ) : null}

        {state.kind === "provider-down" ? (
          <Alert variant="danger">
            The identity provider cannot be reached, so nobody can sign in to this server
            until it is back. There is no alternative account here — this server does not
            hold one.
          </Alert>
        ) : null}

        {state.kind === "not-configured" ? (
          <Alert variant="danger">
            No identity provider is configured on this server, and there is no local account.
            Set KEYCLOAK_BASE_URL and KEYCLOAK_REALM.
          </Alert>
        ) : null}

        {state.kind === "bundle-missing-issuer" ? (
          <Alert variant="warning">
            This server has an identity provider configured, but this build of the UI was not
            given an issuer. Rebuild with VITE_OIDC_ISSUER set.
          </Alert>
        ) : null}

        {state.kind === "server-unreachable" ? (
          <Alert variant="danger">
            This server did not answer when asked how to sign in. It may be down.
          </Alert>
        ) : null}

      </div>
    </div>
  );
}

import {
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  Outlet,
  useNavigate,
} from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { applyTheme, storedTheme, type Theme } from "./lib/theme";
import { api } from "./lib/api";
import { completeLogin, currentUser, login, logout, oidcConfigured, onSessionLost } from "./lib/auth";
import { SignIn } from "./routes/SignIn";
import { Catalog } from "./routes/Catalog";
import { Publish } from "./routes/Publish";
import { Rollout } from "./routes/Rollout";
import { Fleet } from "./routes/Fleet";
import { Systems } from "./routes/Systems";
import { Security } from "./routes/Security";

/**
 * The six tabs the old UI had, as real routes.
 *
 * They were `data-tab` attributes on one page before, which meant the address
 * bar never named what was on screen: an operator could not send a colleague a
 * link to the rollout they were looking at, and a reload always landed back on
 * the catalog. Routing costs nothing here and buys both.
 */
const TABS = [
  { to: "/", label: "Catalog" },
  { to: "/publish", label: "Publish" },
  { to: "/rollout", label: "Rollout" },
  { to: "/fleet", label: "Fleet" },
  { to: "/systems", label: "Systems" },
  { to: "/security", label: "Security" },
] as const;

function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(() => storedTheme());
  useEffect(() => applyTheme(theme), [theme]);
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={theme === "dark" ? "Switch to light" : "Switch to dark"}
      onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
    >
      {theme === "dark" ? <Sun /> : <Moon />}
    </Button>
  );
}

function Shell() {
  const [signedIn, setSignedIn] = useState<boolean | null>(null);

  useEffect(() => {
    // One question, one answer. Until 2026-09-10 this also tried a local token and
    // then a server-side refresh, because a session could have come from either;
    // there is only one source of identity now, and oidc-client-ts holds it.
    void currentUser().then((user) => setSignedIn(Boolean(user)));
    return onSessionLost(() => setSignedIn(false));
  }, []);

  const me = useQuery({ queryKey: ["me"], queryFn: api.me, enabled: signedIn === true });

  if (signedIn === null) {
    return <div className="grid min-h-screen place-items-center text-muted">Loading…</div>;
  }

  // The Keycloak redirect lands on /admin/callback while we are still signed
  // out, so that route has to render before this gate, not behind it.
  if (window.location.pathname === "/admin/callback") return <Outlet />;

  if (!signedIn) return <SignIn />;

  return (
    <div className="min-h-screen bg-canvas">
      <header className="border-b border-line">
        <nav className="mx-auto flex w-full max-w-[1280px] items-center gap-1 px-6 py-3 max-md:px-4">
          <span className="mr-4 font-semibold text-ink">AeroCoreUpdate</span>
          {TABS.map((t) => (
            <Link
              key={t.to}
              to={t.to}
              className="rounded-md px-3 py-1.5 text-sm text-muted hover:text-ink"
              activeProps={{ className: "rounded-md px-3 py-1.5 text-sm text-ink font-medium" }}
              activeOptions={{ exact: t.to === "/" }}
            >
              {t.label}
            </Link>
          ))}
          <div className="ml-auto flex items-center gap-2">
            {me.data ? (
              <span className="text-sm text-muted">{me.data.username}</span>
            ) : null}
            <ThemeToggle />
            <Button variant="ghost" onClick={() => void logout()}>
              Sign out
            </Button>
          </div>
        </nav>
      </header>
      <Outlet />
    </div>
  );
}

/**
 * Where Keycloak sends the browser back to.
 *
 * Nothing renders here for long: it reads the code out of the URL, exchanges it
 * in the browser (PKCE, no client secret) and forwards to wherever sign-in
 * started from.
 */
function Callback() {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    completeLogin()
      .then((to) => {
        window.history.replaceState({}, "", to);
        window.location.reload();
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [navigate]);

  if (error) {
    return (
      <div className="grid min-h-screen place-items-center px-6">
        <div className="max-w-lg text-center">
          <p className="mb-4 text-ink">Sign-in did not complete: {error}</p>
          <Button onClick={() => void login("/")} disabled={!oidcConfigured}>
            Try again
          </Button>
        </div>
      </div>
    );
  }
  return <div className="grid min-h-screen place-items-center text-muted">Signing in…</div>;
}

const rootRoute = createRootRoute({ component: Shell });

const route = (path: string, component: () => JSX.Element) =>
  createRoute({ getParentRoute: () => rootRoute, path, component });

const routeTree = rootRoute.addChildren([
  createRoute({ getParentRoute: () => rootRoute, path: "/", component: Catalog }),
  route("/publish", Publish),
  route("/rollout", Rollout),
  route("/fleet", Fleet),
  route("/systems", Systems),
  route("/security", Security),
  route("/callback", Callback),
]);

/** Served from /admin/ by the Node server's static middleware, not from the root. */
export const router = createRouter({ routeTree, basepath: "/admin" });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

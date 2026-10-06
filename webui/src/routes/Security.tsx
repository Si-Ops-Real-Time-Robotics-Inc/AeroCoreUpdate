import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Page, PageHeader } from "@/components/ui/page";

/**
 * NOT PORTED YET. The working implementation is the previous admin UI, which ships alongside
 * this one at /admin/legacy.html precisely so this screen has somewhere real to send people.
 *
 * Publishing, Catalog, Systems and Rollout have been ported and no longer need it; this is one
 * of the two screens that still do.
 *
 * Still to bring across: users, API keys, the audit log, the signing key and TLS fingerprint panels, and the change-password form.
 */
export function Security() {
  return (
    <Page>
      <PageHeader title="Security" />
      <Alert variant="warning" className="mb-4">
        Not ported to this UI yet. The previous admin UI still does this, and it is signed in
        with the same session — nothing to log in to again.
      </Alert>
      <Button onClick={() => window.location.assign("/admin/legacy.html")}>
        Open the previous admin UI
      </Button>
    </Page>
  );
}

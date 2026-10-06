import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Page, PageHeader } from "@/components/ui/page";
import { Outcomes } from "@/components/rollout/Outcomes";
import { RecentReports } from "@/components/rollout/RecentReports";
import { api } from "@/lib/api";
import { summarise } from "@/lib/rollout";
import { canRead } from "@/lib/scopes";

/**
 * What the fleet did with a release.
 *
 * The distinction this screen is built around is SILENCE versus SUCCESS. A release nobody has
 * reported on and a release everybody installed cleanly both produce an empty failure list,
 * and an empty table reads as a clean pass — which is the exact opposite of what it means when
 * no device has been heard from. They are different sentences here, deliberately.
 */
export function Rollout() {
  const [version, setVersion] = useState<string>("");
  const me = useQuery({ queryKey: ["me"], queryFn: api.me });
  const catalog = useQuery({ queryKey: ["catalog"], queryFn: api.catalog });
  const reports = useQuery({
    queryKey: ["reports", version],
    queryFn: () => api.reports(version || undefined),
  });

  if (me.isPending) return <Page>Loading…</Page>;

  if (!canRead(me.data)) {
    return (
      <Page>
        <PageHeader title="Rollout" />
        <Alert variant="warning">
          This account cannot read the catalog. That needs the
          <span className="font-mono"> catalog:read </span>
          permission, which comes from a realm role an administrator grants.
        </Alert>
      </Page>
    );
  }

  if (reports.isPending) return <Page>Loading…</Page>;
  if (reports.error) {
    return (
      <Page>
        <Alert variant="danger">{(reports.error as Error).message}</Alert>
      </Page>
    );
  }

  const summary = summarise(reports.data.stats);
  // Version numbers, not releases: two systems may publish the same number, and the reports
  // this filters carry only the version a node moved to — so one button per number is all the
  // filter can honestly offer.
  const versions = [...new Set((catalog.data?.releases ?? []).map((r) => String(r.version)))];

  return (
    <Page>
      <PageHeader
        title="Rollout"
        lede="What the fleet reported back, and what it has not reported at all."
      />

      <div className="mb-6 flex flex-wrap items-center gap-2">
        <span className="text-caption text-muted">Release:</span>
        <Button variant={version === "" ? "default" : "ghost"} onClick={() => setVersion("")}>
          All
        </Button>
        {versions.slice(0, 10).map((v) => (
          <Button key={v} variant={version === v ? "default" : "ghost"} onClick={() => setVersion(v)}>
            {v}
          </Button>
        ))}
      </div>

      {summary.kind === "silent" ? (
        // Not "no failures". No reports at all — a rollout that never left the ground looks
        // exactly like one that went perfectly unless this is said in words.
        <Alert variant="warning">
          No device has reported on {version ? `${version}` : "any release"} yet. This is not
          the same as a clean rollout: a node reports after it applies an update, so silence
          means nothing has been applied — or nothing has checked in since it was.
        </Alert>
      ) : (
        <>
          <div className="mb-6 flex flex-wrap gap-6">
            <Figure label="Devices reporting" value={summary.total} />
            <Figure label="Succeeded" value={summary.succeeded} />
            <Figure
              label="Did not"
              value={summary.failed}
              tone={summary.failed > 0 ? "danger" : undefined}
            />
          </div>

          <section>
            <h2 className="mb-3 text-lg font-semibold text-ink">Outcomes</h2>
            <Outcomes groups={summary.groups} total={summary.total} />
          </section>
        </>
      )}

      <section className="mt-8">
        <h2 className="mb-3 text-lg font-semibold text-ink">Recent reports</h2>
        <RecentReports reports={reports.data.recent ?? []} />
      </section>
    </Page>
  );
}

function Figure({
  label, value, tone,
}: { label: string; value: number; tone?: "danger" }) {
  return (
    <div>
      <div className={tone === "danger" ? "text-2xl font-semibold text-danger" : "text-2xl font-semibold text-ink"}>
        {value}
      </div>
      <div className="text-caption text-muted">{label}</div>
    </div>
  );
}

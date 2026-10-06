import { Alert } from "@/components/ui/alert";
import { straysWorthShowing } from "@/lib/channels";
import type { Catalog } from "@/lib/channels";

/**
 * Nodes asking for a channel that does not exist for their system.
 *
 * They receive a correct `204 No Content` and no error, so nothing anywhere else in the system
 * ever mentions it: the devices are silently receiving no updates while every dashboard reads
 * green. This banner is the only place it becomes visible.
 *
 * All FOUR fields, deliberately. A list of names cannot answer the question an operator
 * actually has — is this a stale row from a decommissioned rig, or forty aircraft that have
 * been getting nothing since Tuesday? `nodes` and `last_seen` are that answer.
 */
export function StrayBanner({ catalog }: { catalog: Pick<Catalog, "stray_channels"> | undefined }) {
  const strays = straysWorthShowing(catalog);
  if (strays.length === 0) return null;

  const devices = strays.reduce((sum, s) => sum + (s.nodes ?? 0), 0);
  const mostRecent = strays
    .map((s) => s.last_seen)
    .filter((seen): seen is string => Boolean(seen))
    .sort()
    .at(-1);

  return (
    <Alert variant="warning" className="mb-6">
      <p>
        <strong>
          {devices} device{devices === 1 ? "" : "s"}
        </strong>{" "}
        {devices === 1 ? "is" : "are"} asking for {strays.length} channel
        {strays.length === 1 ? "" : "s"} that {strays.length === 1 ? "does" : "do"} not exist.
        They are being told there is nothing new, and will go on receiving no updates until a
        channel of that name exists or the devices are pointed elsewhere.
        {mostRecent ? (
          <> Most recent check-in {new Date(mostRecent).toLocaleString()}.</>
        ) : null}
      </p>

      <ul className="mt-2 space-y-1">
        {strays.map((stray) => (
          <li key={`${stray.system}/${stray.channel}`} className="text-caption">
            <span className="font-mono">
              {stray.system}/{stray.channel}
            </span>{" "}
            — {stray.nodes ?? 0} device{(stray.nodes ?? 0) === 1 ? "" : "s"}
            {stray.last_seen ? (
              <>, last seen {new Date(stray.last_seen).toLocaleString()}</>
            ) : null}
          </li>
        ))}
      </ul>
    </Alert>
  );
}

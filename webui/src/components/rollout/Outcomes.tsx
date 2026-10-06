import { Badge } from "@/components/ui/badge";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { errorText, isFailure } from "@/lib/rollout";
import type { RolloutStat } from "@/lib/rollout";

/**
 * What the fleet reported, grouped.
 *
 * Anything other than `success` counts against the release. Listing the known failure results
 * instead would silently pass any new one a node learns to send — the release would look clean
 * because the server got more specific, which is the wrong direction for a safety property.
 */
export function Outcomes({ groups, total }: { groups: RolloutStat[]; total: number }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Outcome</TableHead>
          <TableHead>What the node said</TableHead>
          <TableHead className="text-right">Devices</TableHead>
          <TableHead className="text-right">Share</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {groups.map((group) => {
          const count = group.count ?? 0;
          const detail = errorText(group);
          return (
            <TableRow key={`${group.result}-${group.error}`}>
              <TableCell label="Outcome">
                <Badge variant={isFailure(group) ? "danger" : "success"}>{group.result}</Badge>
              </TableCell>
              <TableCell label="What the node said">
                {detail ? (
                  <span className="font-mono text-caption">{detail}</span>
                ) : (
                  <span className="text-muted">—</span>
                )}
              </TableCell>
              <TableCell label="Devices" className="text-right">{count}</TableCell>
              <TableCell label="Share" className="text-right">
                {total > 0 ? `${Math.round((count / total) * 100)}%` : "—"}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

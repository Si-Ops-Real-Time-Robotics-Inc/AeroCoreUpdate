import { Badge } from "@/components/ui/badge";
import {
  Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { errorText } from "@/lib/rollout";
import type { NodeReport } from "@/lib/rollout";

/**
 * One row per device, most recently heard from first.
 *
 * BOTH timestamps, each labelled for whose clock it is. `at` is what the node says and node
 * clocks are not trustworthy — a device with a dead RTC reports 1970 — while `received_at` is
 * this server's own. Showing one unlabelled would mean an operator reading a time without
 * knowing whether to believe it.
 */
export function RecentReports({ reports }: { reports: NodeReport[] }) {
  const ordered = [...reports].sort((a, b) =>
    String(b.received_at ?? "").localeCompare(String(a.received_at ?? "")),
  );

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Device</TableHead>
          <TableHead>Moved</TableHead>
          <TableHead>Outcome</TableHead>
          <TableHead>Server received</TableHead>
          <TableHead>Device clock</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {ordered.length === 0 ? (
          <TableEmpty>No device has reported on this release.</TableEmpty>
        ) : null}

        {ordered.map((report) => {
          const detail = errorText(report);
          return (
            <TableRow key={report.id ?? `${report.serial}-${report.received_at}`}>
              <TableCell label="Device">
                <span className="font-mono">{report.serial}</span>
                {report.platform ? (
                  <span className="ml-2 text-caption text-muted">{report.platform}</span>
                ) : null}
              </TableCell>

              <TableCell label="Moved">
                <span className="font-mono text-caption">
                  {report.from_version ?? "—"} → {report.to_version ?? "—"}
                </span>
              </TableCell>

              <TableCell label="Outcome">
                <Badge variant={report.result === "success" ? "success" : "danger"}>
                  {report.result}
                </Badge>
                {detail ? (
                  <div className="mt-1 font-mono text-caption text-muted">{detail}</div>
                ) : null}
              </TableCell>

              <TableCell label="Server received">
                {report.received_at ? (
                  <time dateTime={report.received_at}>
                    {new Date(report.received_at).toLocaleString()}
                  </time>
                ) : (
                  <span className="text-muted">—</span>
                )}
              </TableCell>

              <TableCell label="Device clock">
                {report.at ? (
                  <time dateTime={report.at} className="text-muted">
                    {new Date(report.at).toLocaleString()}
                  </time>
                ) : (
                  <span className="text-muted">not reported</span>
                )}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

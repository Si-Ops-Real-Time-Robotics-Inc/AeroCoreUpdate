import { Fragment, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Page, PageHeader } from "@/components/ui/page";
import {
  Table,
  TableBody,
  TableCell,
  TableEmpty,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { RemovePanel, type RemovalTarget } from "@/components/catalog/RemovePanel";
import { StrayBanner } from "@/components/systems/StrayBanner";
import { api, ApiError, type ArtifactRemoved, type ReleaseRemoved } from "@/lib/api";
import { inUse, servedBy } from "@/lib/removal";
import { canRemove } from "@/lib/scopes";

/** Enough to tell a fleet bundle from a slim one at a glance. */
function size(bytes: number | undefined): string {
  if (bytes === undefined || bytes === null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function Catalog() {
  const queryClient = useQueryClient();
  const catalog = useQuery({ queryKey: ["catalog"], queryFn: api.catalog });
  const me = useQuery({ queryKey: ["me"], queryFn: api.me });

  // Which release's artifacts are listed, and which build the operator has asked to remove.
  const [open, setOpen] = useState<string | null>(null);
  const [removing, setRemoving] = useState<{ row: string; target: RemovalTarget } | null>(null);
  const [refusal, setRefusal] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Also how the operator declines: the question goes and no request is made (FR-006). The
  // mutation is only ever started by the panel's Remove button.
  const close = () => {
    setRemoving(null);
    setRefusal(null);
  };

  const ask = (row: string, target: RemovalTarget) => {
    setError(null);
    setNotice(null);
    setRefusal(null);
    setRemoving({ row, target });
  };

  const remove = useMutation({
    // Two operations with two result shapes; said once here so the mutation is not typed from
    // whichever branch the compiler happened to read first.
    mutationFn: (target: RemovalTarget): Promise<ReleaseRemoved | ArtifactRemoved> =>
      target.kind === "release" ? api.deleteRelease(target.system, target.version) : api.deleteArtifact(target.id),
    onSuccess: (_result, target) => {
      close();
      setNotice(
        target.kind === "release"
          ? `Removed ${target.version} and its ${target.artifactCount} artifact${target.artifactCount === 1 ? "" : "s"}.`
          : `Removed ${target.file} from ${target.version}.`,
      );
      void queryClient.invalidateQueries({ queryKey: ["catalog"] });
    },
    onError: (err, target) => {
      // The refusal is the current answer; the catalog on screen is only as fresh as its last
      // fetch. Show the channels the server named, not the ones this page thought it knew.
      const finding = inUse(err);
      if (finding) {
        setRefusal(finding.channels ?? []);
        return;
      }
      if (err instanceof ApiError && err.status === 404) {
        // Said at the top of the page, not in the panel: when the thing already gone is a whole
        // release, the refetch removes its row, and a message inside the row goes with it.
        close();
        setNotice(
          `${target.kind === "artifact" ? target.file : target.version} was already gone — `
          + "someone removed it after this page loaded. Nothing else changed.",
        );
        void queryClient.invalidateQueries({ queryKey: ["catalog"] });
        return;
      }
      close();
      setError(err instanceof ApiError ? err.message : String(err));
    },
  });

  if (catalog.isPending) return <Page>Loading…</Page>;
  if (catalog.error) {
    return (
      <Page>
        <Alert variant="danger">{(catalog.error as Error).message}</Alert>
      </Page>
    );
  }

  const releases = catalog.data.releases ?? [];
  // Presentation, not security: the server refuses regardless. It spares an operator a
  // button whose only outcome is a refusal, which reads as a broken page.
  const mayRemove = canRemove(me.data);

  return (
    <Page>
      <PageHeader title="Catalog" lede="Every release this server can serve, and where each one points." />

      {/* The same four-field banner as Systems. A list of names cannot say whether this is a
          stale row or forty aircraft getting nothing since Tuesday; it renders nothing when
          there is nothing to say. */}
      <StrayBanner catalog={catalog.data} />

      {error ? (
        <Alert variant="danger" className="mb-4">
          {error}
        </Alert>
      ) : null}
      {notice ? (
        <Alert variant="info" className="mb-4">
          {notice}
        </Alert>
      ) : null}
      {me.isSuccess && !mayRemove ? (
        <p className="mb-4 text-sm text-muted">
          Removing a build needs the <span className="font-mono">catalog:delete</span> permission,
          which only an administrator holds.
        </p>
      ) : null}

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Version</TableHead>
            <TableHead>System</TableHead>
            <TableHead>Channels</TableHead>
            <TableHead>Artifacts</TableHead>
            <TableHead>
              <span className="sr-only">Remove</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {releases.length === 0 ? (
            <TableEmpty>Nothing published yet.</TableEmpty>
          ) : (
            releases.map((r) => {
              const key = `${r.system}/${r.version}`;
              const version = String(r.version);
              const system = r.system ?? "";
              const served = servedBy(catalog.data, r);
              const artifacts = r.artifacts ?? [];
              const expanded = open === key;
              const acting = removing?.row === key;

              return (
                <Fragment key={key}>
                  <TableRow>
                    <TableCell className="font-medium">{version}</TableCell>
                    <TableCell>{system}</TableCell>
                    <TableCell>
                      {/* From the catalog's channel list. The per-release field this used to read
                          was declared in the contract and never sent, so every release showed as
                          "staged" — including the one stable was serving. */}
                      <div className="flex flex-wrap gap-1">
                        {served.length === 0 ? (
                          <span className="text-muted">staged</span>
                        ) : (
                          served.map((c) => (
                            <Badge key={c} variant={c === "stable" ? "success" : "default"}>
                              {c}
                            </Badge>
                          ))
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        aria-expanded={expanded}
                        onClick={() => setOpen(expanded ? null : key)}
                      >
                        {artifacts.length} artifact{artifacts.length === 1 ? "" : "s"}{" "}
                        {expanded ? "▾" : "▸"}
                      </Button>
                    </TableCell>
                    <TableCell className="text-right">
                      {mayRemove ? (
                        <Button
                          variant="ghost"
                          onClick={() =>
                            ask(key, { kind: "release", version, system, artifactCount: artifacts.length })}
                        >
                          Remove release
                        </Button>
                      ) : null}
                    </TableCell>
                  </TableRow>

                  {expanded || acting ? (
                    <tr>
                      <td colSpan={5} className="px-4 pb-4">
                        {expanded ? (
                          <ul className="mt-1 divide-y divide-hairline">
                            {artifacts.map((a) => {
                              const platforms = a.platform ? [a.platform] : (a.platforms ?? []);
                              return (
                                <li
                                  key={a.id}
                                  className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm"
                                >
                                  <span>
                                    <span className="font-mono">{a.file}</span>
                                    <span className="ml-2 text-muted">
                                      {a.kind} · {platforms.join(", ") || "—"} · {size(a.size)}
                                    </span>
                                  </span>
                                  {mayRemove ? (
                                    <Button
                                      variant="ghost"
                                      onClick={() =>
                                        ask(key, {
                                          kind: "artifact",
                                          id: Number(a.id),
                                          file: a.file ?? "",
                                          platforms,
                                          version,
                                        })}
                                    >
                                      Remove
                                    </Button>
                                  ) : null}
                                </li>
                              );
                            })}
                          </ul>
                        ) : null}

                        {acting && removing ? (
                          <RemovePanel
                            target={removing.target}
                            servedBy={served.map((c) => `${system}/${c}`)}
                            refusal={refusal}
                            busy={remove.isPending}
                            onConfirm={() => remove.mutate(removing.target)}
                            onCancel={close}
                          />
                        ) : null}
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })
          )}
        </TableBody>
      </Table>
    </Page>
  );
}

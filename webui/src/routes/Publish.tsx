import { useReducer, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Page, PageHeader } from "@/components/ui/page";
import { CommitPanel } from "@/components/publish/CommitPanel";
import { Dropzone } from "@/components/publish/Dropzone";
import { PlatformPrompt } from "@/components/publish/PlatformPrompt";
import { Progress } from "@/components/publish/Progress";
import { api, ApiError } from "@/lib/api";
import { sha256 } from "@/lib/hash";
import { isBusy, publishReducer, type PublishState } from "@/lib/publish-state";
import { canPublish } from "@/lib/scopes";
import { needsPlatforms, rollback, stageBundle } from "@/lib/upload";
import type { Finding } from "@/lib/upload";

/**
 * Publishing a release.
 *
 * Two steps by design: staging reads the bundle and describes it while storing
 * nothing, and only a person's confirmation writes anything. A release lands on
 * `beta` and reaches the fleet only when an admin promotes it from another
 * screen — this one has no way to move a channel, and must not grow one.
 */
export function Publish() {
  const [state, dispatch] = useReducer(publishReducer, { phase: "idle" } as PublishState);
  const [error, setError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // The backward-move refusal, held so the operator can answer it. Null until the
  // server says so — this screen never decides for itself that a move is backwards.
  const [backwards, setBackwards] = useState<Finding | null>(null);
  const queryClient = useQueryClient();
  const me = useQuery({ queryKey: ["me"], queryFn: api.me });

  async function stage(file: File, platforms?: string[]) {
    setError(null);
    setNotice(null);
    dispatch({ type: "hashing" });
    try {
      // Hashed before a byte is sent, so a corrupted transfer is refused rather
      // than stored and discovered later.
      const expectedSha256 = await sha256(file);
      const staged = await stageBundle(file, {
        expectedSha256,
        platforms,
        onProgress: (loaded, total) => dispatch({ type: "progress", loaded, total }),
      });
      dispatch({ type: "staged", staged });
    } catch (err) {
      // The one refusal the bundle cannot answer for itself. Detected by the
      // finding's `rule`, never by the message — the message is prose for a
      // person and may be reworded at any time.
      if (needsPlatforms(err)) {
        dispatch({ type: "needsPlatforms", message: (err as ApiError).message });
        return;
      }
      if (err instanceof ApiError) setError(err);
      else setError(new ApiError({ status: 0, code: "server_error", message: String(err) }));
      dispatch({ type: "failed" });
    }
  }

  const commit = useMutation({
    mutationFn: ({ token, allowRollback }: { token: string; allowRollback: boolean }) =>
      api.commitUpload(token, allowRollback),
    onSuccess: (result) => {
      setBackwards(null);
      dispatch({ type: "published", result });
      // The catalog screen is now out of date; let it refetch rather than show
      // a release that exists but is missing from the list.
      void queryClient.invalidateQueries({ queryKey: ["catalog"] });
    },
    onError: (err) => {
      // A commit names no channel, but it does move one, so it meets the same
      // backward-move guard as every other path. Offer the confirmation instead
      // of showing a refusal naming a flag this screen cannot send — the staged
      // bundle is still on the server, so answering costs nothing.
      const finding = rollback(err);
      if (finding) {
        setBackwards(finding);
        return;
      }
      setError(err instanceof ApiError ? err : null);
    },
  });

  const busy = isBusy(state) || commit.isPending;

  return (
    <Page>
      <PageHeader
        title="Publish"
        lede="Upload a bundle, look at what is in it, then confirm. Nothing is stored until you do."
      />

      {error ? (
        <Alert variant="danger" className="mb-4">
          {/* The server's own wording. A 413 states the limit, a refused bundle
              names the rule — replacing either with "upload failed" throws away
              the only part an operator can act on. */}
          {error.message}
          {error.status === 413 ? " — the bundle is larger than this server accepts." : ""}
        </Alert>
      ) : null}

      {notice ? (
        <Alert variant="info" className="mb-4">
          {notice}
        </Alert>
      ) : null}

      {state.phase === "published" ? (
        <Alert variant="info" className="mb-4">
          Published to <strong>beta</strong>. It is not on <strong>stable</strong> yet — an
          admin has to promote it before any aircraft is offered it.
        </Alert>
      ) : null}

      {me.isSuccess && !canPublish(me.data) ? (
        <Alert variant="warning">
          This account may read the catalog but not add to it. Publishing needs the
          <span className="font-mono"> artifact:write </span>
          permission, which comes from a realm role an administrator grants.
        </Alert>
      ) : null}

      {canPublish(me.data) && state.phase !== "staged" && state.phase !== "published" && state.phase !== "needsPlatforms" ? (
        <Dropzone
          onChoose={(file) => dispatch({ type: "choose", file })}
          disabled={busy}
          chosen={"file" in state ? state.file : null}
        />
      ) : null}

      {state.phase === "hashing" ? <Progress phase="Hashing" loaded={0} total={0} /> : null}
      {state.phase === "sending" ? (
        <Progress phase="Uploading" loaded={state.loaded} total={state.total} />
      ) : null}

      {state.phase === "chosen" ? (
        <div className="mt-4">
          <Button onClick={() => void stage(state.file)} disabled={busy}>
            Upload and inspect
          </Button>
        </div>
      ) : null}

      {state.phase === "needsPlatforms" ? (
        <PlatformPrompt
          message={state.message}
          busy={busy}
          onRetry={(platforms) => void stage(state.file, platforms)}
          onCancel={() => dispatch({ type: "clear" })}
        />
      ) : null}

      {state.phase === "staged" && backwards ? (
        <Alert variant="warning" className="mb-4">
          <p>
            <strong>beta</strong> is on <span className="font-mono">{backwards.from}</span>, and
            this bundle is <span className="font-mono">{backwards.to}</span> — older. Nodes that
            already updated will not go back, but a device provisioned after this would take it.
          </p>
          <div className="mt-3 flex gap-2">
            <Button
              variant="danger"
              disabled={commit.isPending}
              onClick={() =>
                commit.mutate({ token: state.staged.token, allowRollback: true })}
            >
              Publish it anyway
            </Button>
            <Button
              variant="secondary"
              disabled={commit.isPending}
              onClick={() => {
                // Nothing further is sent. The staged bundle is untouched on the
                // server and expires on its own.
                setBackwards(null);
                setNotice("Left as it was — nothing was published.");
              }}
            >
              Cancel
            </Button>
          </div>
        </Alert>
      ) : null}

      {state.phase === "staged" ? (
        <CommitPanel
          staged={state.staged}
          busy={commit.isPending}
          onCommit={() => commit.mutate({ token: state.staged.token, allowRollback: false })}
          onDiscard={() => {
            // No endpoint is called and none exists: nothing was stored, so
            // there is nothing to undo. The staged file is never referenced
            // again and the server sweeps it within the hour. Saying "deleted"
            // would claim an action this screen did not perform.
            dispatch({ type: "discard" });
            setNotice("Discarded — nothing was stored.");
          }}
        />
      ) : null}

      {state.phase === "published" ? (
        <Button className="mt-4" onClick={() => dispatch({ type: "clear" })}>
          Publish another
        </Button>
      ) : null}
    </Page>
  );
}

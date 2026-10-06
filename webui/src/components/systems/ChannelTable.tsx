import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import type { Channel } from "@/lib/channels";

/**
 * What each channel is serving right now.
 *
 * A channel pointing at nothing is the case worth designing for: it is not an empty cell, it
 * is a channel that answers every node with "nothing new" — which looks identical to a fleet
 * that is already up to date. Saying so in words is the difference between an operator seeing
 * a working rollout and seeing one that never started.
 */
export function ChannelTable({
  channels,
  canPromote,
  onPromote,
}: {
  channels: Channel[];
  canPromote: boolean;
  onPromote: (channel: Channel) => void;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Channel</TableHead>
          <TableHead>Serving</TableHead>
          <TableHead>Updated</TableHead>
          <TableHead className="text-right">Promote</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {channels.length === 0 ? (
          <TableEmpty>
            This system defines no channels yet. A channel is created the first time a release
            lands on it.
          </TableEmpty>
        ) : null}

        {channels.map((channel) => (
          <TableRow key={`${channel.system}/${channel.name}`}>
            <TableCell label="Channel">
              <span className="font-mono">{channel.name}</span>
              {channel.name === "stable" ? (
                <Badge variant="brand" className="ml-2">fleet</Badge>
              ) : null}
            </TableCell>

            <TableCell label="Serving">
              {channel.latest ? (
                <span className="font-mono">{channel.latest}</span>
              ) : (
                // Not an empty cell. Nodes following this channel are told there is nothing
                // new, which is indistinguishable from being up to date unless it is said.
                <span className="text-muted">
                  nothing — nodes here are offered no update at all
                </span>
              )}
            </TableCell>

            <TableCell label="Updated">
              {channel.updated_at ? (
                <time dateTime={channel.updated_at}>
                  {new Date(channel.updated_at).toLocaleString()}
                </time>
              ) : (
                <span className="text-muted">—</span>
              )}
            </TableCell>

            <TableCell label="Promote" className="text-right">
              {canPromote ? (
                <Button variant="ghost" onClick={() => onPromote(channel)}>
                  Point it somewhere
                </Button>
              ) : (
                <span className="text-muted text-caption">needs channel:write</span>
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

# Team Mode

Team Mode is Brigade's durable collaboration layer for work that needs more
than one agent. It turns a user objective into a room-scoped run containing a
task graph, executes ready tasks through Brigade's existing agent loop, and
returns every completed result to the graph so downstream agents can continue.

It is part of Brigade, not Tideline. It runs with either Brigade storage mode:

- **filesystem** (default): a locked, hash-chained, fsynced journal under the
  Brigade state directory;
- **Convex**: normalized collaboration tables and one optimistic-concurrency
  transaction per semantic command.

Switching storage modes with `brigade store migrate` carries Team rooms, runs,
messages, tasks, attempts, handoffs, approvals, artifacts, events, outbox rows,
command receipts, and room cursors with the rest of Brigade state.

## Room conversation model

A room is the durable group/channel boundary. It owns a title, configured agent
membership, public conversation, run history, and permissions. It is not itself
a run or a transcript: one room can hold many conversations and Team runs over
time. A thread is a relation between durable room messages, so replies retain
the same room permissions and reconnect history instead of becoming hidden
agent sessions.

Public room messages support replies and threads, explicit `@agent` mentions,
attachment references, edit and soft-delete history, reactions, pins, bounded
search, pagination, and authoritative room metrics. Mentions address members
and help agents find context; they never silently create work. The operation is
explicit:

- **message or mention**: communicate in the public room;
- **assignment/delegation**: create durable work owned by an agent;
- **consultation**: ask a child agent, then resume the caller with its result;
- **handoff**: transfer ownership of the current task after acceptance.

The room coordinator's visible replies are automatically persisted as public
messages, including hidden completion wake-ups recovered after a restart.
Leased workers can read the public room and post fenced attempt updates. A
browser can post only as the authenticated operator; it cannot impersonate an
agent or bypass a worker's active lease and fence.

## Execution model

Final review tasks may declare the fixed
`resultGate: { "kind": "review_verdict" }` contract. The worker receives this
requirement in the trusted execution envelope, and the shared authority accepts
only a result beginning with `REVIEW: PASS`. `REVIEW: FAIL`, ambiguous output,
and non-string results atomically fail the attempt, task, and run with
`RESULT_GATE_FAILED` in both filesystem and Convex storage modes.

Clients that negotiate `team.review-policy.independent-v1` may opt into the
stronger `resultGate: { "kind": "review_verdict", "policy": "independent-v1" }`
contract. The authority requires an explicitly assigned reviewer, one or more
direct dependencies with an `all` join, and a different explicit agent for
every direct, transitive, and dynamically delegated upstream contributor. It
rechecks persisted attempt identities at run start, handoff acceptance, and
review completion. A passing reply must use `REVIEW: PASS` on its first line and
an exact second line of `EVIDENCE: {"task-id":"sha256"}` containing every
direct dependency and no other keys. Digests are those returned by the lossless
result page API. Omitting `policy` deliberately retains the original
verdict-only behavior for existing clients and persisted runs.

Run status stays compact by truncating long result previews. Coordinators can
page one lossless result with `team({ action: "read_result", runId, taskId,
offset, limit })`, and gateway clients can use `team.tasks.result`. Leased
workers use the same page contract through `team_task` but may read only their
direct dependencies; the attempt lease/fence and room/run edge are checked
before any content is returned. Each page carries the complete encoded result's
SHA-256 and a `nextOffset` until `complete` is true.

```text
room
  └─ run (objective + budgets)
       ├─ task A ───────────────┐
       ├─ task B ───────────────┼─> task D (all / any / quorum join)
       └─ task C ───────────────┘
            └─ attempt (lease + fence + runtime turn)
```

The store is authoritative. A worker must atomically claim a ready task before
running an agent turn. Each claim receives a lease token and a monotonically
increasing fence; stale workers cannot complete, fail, hand off, approve, or
attach artifacts after their lease has been replaced. The gateway renews live
leases, reconciles expired work on restart, and aborts the matching Brigade
turn after durable cancellation.

Tasks support:

- `all`, `any`, and quorum dependency joins;
- optional cancellation of losing branches after an `any` or quorum join;
- bounded attempts, retry filters, and retry backoff;
- explicit operator retry of a failed task, which safely reopens its failed run
  and dependency-skipped descendants only when the room has no newer active run;
- per-run token, cost, elapsed-time, concurrency, and attempt budgets (a cost
  ceiling fails closed if a provider cannot report complete pricing);
- durable approvals, accepted/rejected handoffs, and attempt-scoped artifacts;
- attempt-scoped worker transcripts, with a separate stable room-and-agent
  reservation key so retries/tasks cannot silently contaminate one another
  while same-agent work in a room remains serialized.

The authority claims the scheduler's exact task and persists its resolved agent
identity in the attempt. That transaction-level check prevents another runtime
or a stale snapshot from redirecting an assigned claim to an unassigned task or
running the same agent workspace concurrently. Approval and handoff requests
expire after five minutes by default and are capped at 24 hours. Terminal
publication waits for provider usage attribution; an externally cancelled or
handed-off callback gets a bounded 30-second settlement grace before restart
reconciliation records its usage as unknown.

An agent's normal final reply becomes the durable result of its task attempt.
Dependency results and artifacts are inserted into the next task's execution
envelope. This is the completion path that makes multi-agent work converge back
into the run rather than ending as disconnected child chats.

When a run reaches a terminal state, the durable outbox starts one hidden,
trusted turn in the room coordinator's separate `team-chat` session with the
exact event notification as its input. It does not use the shared chat inbox,
so an operator message cannot consume or reorder a completion event. The
coordinator reads authoritative results with `team status`
and synthesizes them for the operator. This return path is runtime-owned; it
does not depend on a worker remembering to call a messaging tool. These wake-up
turns are marked as internal transcript records: they can trigger the model but
cannot be rendered as operator-authored chat. A failed wake is left in the
outbox for retry instead of being acknowledged and lost. If a configured
coordinator has since been removed, both the runtime and the tool authorization
path choose the same live room member rather than creating split-brain sessions.
Outbox delivery runs separately from scheduling, so a slow coordinator model or
transport cannot block gateway startup, task claims, cancellation, or lease
work. Stale terminal and decision rows are checked against current authority
state before a coordinator is woken, so a retried run is not later narrated as
failed.

## Agent tools

The owner-facing `team` tool creates, updates, and safely archives rooms; creates
runs; adds task graphs; starts or cancels work; inspects status (including
bounded durable results); retries tasks; and resolves pending approvals and
handoffs. It can also list, search, and post public room messages. Room updates
can change the title or configured membership, preserve
existing metadata when applying a patch, reject unknown agents, and cannot
remove an agent that still owns active work. In a `team-chat` session, room
operations default to and are restricted to that room. The preferred
conversational call is `delegate`, which validates and starts a complete DAG in
one idempotent authority transaction (`team.runs.delegate` on the wire). Invalid
graphs leave no partial run, events, outbox rows, or command receipt. The
lower-level sequence remains available for staged or unusually large graphs:

1. `create_room` with the participating Brigade agent IDs.
2. `create_run` with the objective and optional budgets.
3. `add_tasks` with stable task IDs, assignments, dependencies, and joins.
4. `start_run`.
5. Use `status` to inspect durable progress and answer pending decisions.

While executing a leased task, an agent receives only the workspace execution
tools (`read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`), read-only
research tools (`web_search`, `fetch_url` when configured), and the narrow
`team_task` tool. It can inspect its status, request and wait for approval,
offer and wait for an ownership handoff, register an artifact, or atomically
delegate one to four child tasks. It can also read room messages and post a
fenced public update tied to its attempt. Delegation is different from a handoff: the
source attempt yields its lease, the parent enters `waiting_children`, and the
runtime starts a fresh fenced parent attempt only after every direct child is
terminal and source usage is durably settled. The resumed prompt contains the
child results, failures, and artifacts. Request keys make retries semantic-
idempotent; lineage, nesting depth, total child count, membership, cycles, and
run budgets are authority-checked before any child is committed. Lease tokens,
owners, and fences are held in an execution-scoped capability and are never
exposed to the model or gateway run snapshots. Owner/global configuration and
credential management, memory, cross-session, interactive browser, other
extension, and generic sub-agent tools are removed from Team worker turns. Attempt
transcripts are hidden from ordinary session list/history/send/mutation APIs;
authorized inspection goes through Team run status. Team turns also use the non-owner
memory origin, so automatic owner-memory recall and post-turn owner-memory
extraction stay disabled.

A worker-to-worker question uses the same return path rather than a second,
lossy chat channel: the caller delegates one child with
`delegationKind: "consultation"`, yields its current attempt, and is resumed with
the consulted member's durable result. That makes “ask this agent and get back
to me” restart-safe, usage-accounted, recursively nestable, and visible in the
task lineage. Use a handoff only when the receiving member should own the
original task permanently.

This capability narrowing is not a hard operating-system sandbox. A Team
worker is currently a trusted local Brigade agent: file tools follow Brigade's
ordinary workspace policy, and an approved shell command runs with the gateway
process's host access. Do not use this phase to execute mutually untrusted
tenants in one gateway. A SaaS boundary requires isolated worker processes or
containers, task-scoped mounts, credential brokering, and an egress policy in
the later multi-tenant control plane.

## Gateway API for a room UI

The handshake advertises the `team.*` methods and Team capabilities. Relevant
methods include:

```text
team.rooms.list/create/update/archive/metrics
team.messages.list/search/post/edit/delete/react/pin
team.runs.list/create/delegate/start/get/cancel
team.tasks.list/result/add/cancel/retry
team.handoffs.list/respond
team.approvals.list/resolve
team.artifacts.list
team.events.list
team.resume
```

Failed requests retain the gateway's structured error envelope
(`code`, `message`, `retryable`, optional `retryAfterMs`, and `details`). Team
clients can branch on `TEAM_NOT_FOUND`, `TEAM_CONFLICT`,
`TEAM_BUDGET_EXHAUSTED`, and `TEAM_DOMAIN_ERROR`; invalid input continues to
use `INVALID_REQUEST`. Current Team domain failures are marked non-retryable,
so a client should refresh state or change the command instead of blindly
replaying it.

Subscribe explicitly after connecting; Team events never enter the legacy
agent/session firehose:

```json
{
  "type": "req",
  "id": "sub-1",
  "method": "subscribe",
  "params": { "roomId": "room-id", "includeProgress": true }
}
```

Gate reconnect-safe hydration on the `team.subscribe.snapshot` capability.
For `subscribe { roomId }`, the gateway installs live room routing first and
then returns that room's authoritative `TeamRoomListSummary` as the response
payload. Hydrate it immediately: anything committed before installation is in
the summary, while anything committed afterwards is eligible for the live
event lane. Reconcile a delayed summary by `headRoomSeq` and
`execApprovalRevision`, as it can arrive after a newer live frame. Legacy
agent/session-only subscriptions keep their payload-less success response.

There are four event lanes:

- `team-event` is a durable lifecycle transition. `roomSeq` is strictly
  monotonic per room and can be replayed. Public message posts, edits, deletes,
  reactions, and pins use this lane too, so every selected-room client converges.
- `team-progress` is live assistant/tool/heartbeat decoration. It is
  ordered only by `progressSeq` within an attempt, can be dropped under
  backpressure, and never advances the durable room cursor. Tool arguments and
  results are omitted from this lane to avoid leaking credentials or document
  content.
- `team-approval-request` routes a worker shell approval only to subscribers of
  its room. `team-approval-resolved` closes it for every subscribed client.
  Both events and `team.resume` carry a monotonically increasing process-local
  approval revision, so a delayed resume snapshot cannot erase a newer request
  or resurrect an already-resolved prompt. `team.resume` also includes every
  still-pending runtime approval so a reconnect cannot leave an active worker
  waiting behind an invisible prompt.

Raw worker Pi frames are private and are not broadcast, including to legacy
clients without subscriptions. Worker assignment envelopes therefore cannot
appear in the operator conversation; UIs receive only the redacted Team lanes.

After reconnecting, call `team.resume` with the last rendered `roomSeq`. The
response contains the current room/run snapshot, authoritative metrics, the 100
most recent public messages, and newer durable events. Page older conversation
with `team.messages.list`. Prefer `beforeMessageId`/`afterMessageId` over the
legacy timestamp cursors so messages created in the same millisecond cannot be
skipped; the cursor must name a message in the same room. Use
`team.messages.search` for bounded server-side search. If `replayComplete` is
false, render the returned snapshot as authority
instead of trying to reconstruct state from an incomplete event interval.

For UI state, key transient streams by `attemptId`, render durable task state
from `team-event`/`team.resume`, and treat `task.succeeded`, `task.failed`,
`task.handed_off`, or `task.cancelled` as the terminal replacement for any
in-progress decoration.

Brigade intentionally ships this as a headless collaboration backend. Product
clients should build against the versioned methods and negotiated capabilities,
commit an operator message before entering the coordinator's ordered `prompt`
lane, reconcile optimistic rows by stable message ID, and keep thread-only
replies from silently launching work. Use a stable room-scoped `team-chat`
session for coordinator conversation; the separate `team` attempt namespace
keeps worker assignment prompts out of that transcript. Subscribe to every room
for lightweight lifecycle updates, enable progress only for the selected room,
and reconcile reconnects using `team.resume` cursors and revisions. Do not infer
presence from configuration, force-scroll a reader during streaming, or hide
pending approval and handoff decisions outside the chronological room context.

Hidden completion and decision turns are restricted in code to one read-only
`team` status tool and skip post-turn memory extraction. That exact synthetic
shape may bypass workspace admission so a coordinator paused inside a Team task
can surface its own pending approval without self-deadlocking; no ordinary or
workspace-capable turn receives that bypass.

## Reliability boundary

Filesystem mode is intended for one Brigade gateway and survives process
crashes through its journal. Convex mode provides the same collaboration
semantics through the existing optional backend. The runtime is still
single-gateway: concurrency and per-session reservations are process-local, so
multiple gateways must not execute the same owner's runs concurrently.

Convex Team Mode is also a **single-owner Phase-1 scale profile**, not yet an
unbounded enterprise history store. One atomic delegation is capped at 512 KiB
before any authority state changes, leaving headroom for its durable command
receipt below Convex's per-document limit. More importantly, the current Convex
adapter hydrates all of an owner's rooms, runs, tasks, attempts, handoffs,
approvals, artifacts, and room cursors in one query before each semantic
mutation. The retained core state must therefore remain below Convex's 16 MiB
transaction read limit. Use filesystem mode for larger retained histories; the
lower-level staged graph API does not remove this cumulative Convex limit.

Removing that limit requires a revision-fenced paginated hydration change, not
only a larger constant:

1. Add a lightweight collaboration-revision query and cursor-paginated queries
   for each normalized collaboration collection in `convex/collaboration.ts`.
   Bound pages by both record count and encoded bytes.
2. In `src/storage/convex/collaboration-store.ts`, read the revision, hydrate all
   required pages, then read the revision again. Retry the read if it changed so
   the in-memory semantic store never receives a torn cross-page snapshot.
3. Keep the existing expected-revision commit fence, bounded command delta, and
   atomic receipt/event/outbox commit after semantic evaluation.
4. Route snapshot export, exact migration verification, and restart hydration
   through the same paginated reader. Add live-Convex tests with more than
   16 MiB of retained state and a mutation racing between pages before removing
   the Phase-1 label.

Neither mode makes Brigade a multi-tenant service, and the optional Convex
functions are not a tenant-authorization boundary. SaaS identity,
tenant-qualified authorization, quotas, cluster-wide admission, and network
isolation remain a separate platform layer. This lets Team Mode be completed
and used locally or on-prem without coupling it to the later SaaS control
plane.

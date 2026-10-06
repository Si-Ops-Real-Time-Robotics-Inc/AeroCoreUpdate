# Feature Specification: Closing the publish loop — promote, and see what came back

**Feature Branch**: `003-promote-and-rollout`

**Created**: 2026-09-10

**Status**: Draft

**Input**: User description: "Port the Systems and Rollout screens into the new admin UI, so an operator can complete the publish workflow without opening the previous one."

## Context

Publishing is two jobs done by two people. The new admin UI does the first: an engineer or
admin uploads a bundle and it lands on the test channel. The second — an admin reviewing what
the test channel is holding and deciding it may reach the fleet — exists only in the previous
admin UI. This feature moves it across, along with the evidence an admin needs to make that
decision: what the fleet reported about the release.

Promotion is the only action in this entire system that reaches an aircraft. Everything else
adds to a catalog nobody is served from. That asymmetry is why this screen is specified apart
from the upload screen, and why most of what follows is about care rather than capability.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Let a release reach the fleet (Priority: P1)

An admin has read the review, looked at what the test group reported, and decides the release
is ready. They point the fleet's channel at it. From that moment, devices asking what to run
are offered the new version.

**Why this priority**: It is the half of publishing that does not exist in the new UI, and
without it the workflow cannot be completed there at all.

**Independent Test**: Promote a release and confirm that a device asking what to run is
offered it, where before it was not.

**Acceptance Scenarios**:

1. **Given** an admin and a release on the test channel, **When** they promote it, **Then**
   the fleet's channel points at that release and devices are offered it.
2. **Given** the promotion is about to happen, **When** the operator is asked to confirm,
   **Then** the confirmation states which release is being replaced and by which — not merely
   "are you sure".
3. **Given** the operator is moving the channel BACKWARDS to an older release, **When** they
   confirm, **Then** they are warned that this is a rollback and told what it means, and the
   choice is theirs rather than refused outright.
4. **Given** the promotion succeeds, **When** the screen updates, **Then** it names any other
   channel this release was taken off, so nothing moves invisibly.

---

### User Story 2 - See what is being served right now (Priority: P1)

Before deciding anything, an operator sees each kind of device this server publishes for, and
what each of its two channels currently points at.

**Why this priority**: Shares P1 with the promotion because it is not possible to promote
responsibly without it. An operator who cannot see what the fleet is currently running is
guessing about the thing that reaches an aircraft.

**Independent Test**: Open the screen and read, for every kind of device, what the test
channel and the fleet channel each point at.

**Acceptance Scenarios**:

1. **Given** several kinds of device, **When** the operator opens the screen, **Then** each is
   listed with what its two channels point at, and a channel pointing at nothing says so.
2. **Given** a channel that points at a kind of device this server no longer defines, **When**
   the screen loads, **Then** it is surfaced as a problem needing attention.
3. **Given** devices are asking for a channel that does not exist for their kind, **When** the
   screen loads, **Then** the operator is told how many and which — those devices are being
   told they are up to date and will never update.

---

### User Story 3 - Read what the fleet said back (Priority: P2)

An operator looks at what devices reported after applying a release: how many succeeded, how
many did not, and what went wrong for the ones that did not.

**Why this priority**: It is the evidence for the P1 decision, but the decision can be made
without it — from the test group's silence, or from a build everyone already trusts. Lower
than promotion, and not much lower.

**Independent Test**: Publish a release, have devices report, and read the outcome on this
screen.

**Acceptance Scenarios**:

1. **Given** reports exist for a release, **When** the operator opens the screen, **Then**
   outcomes are grouped and counted, most common first, with anything other than success
   counting against the release.
2. **Given** no device has reported at all, **When** the screen loads, **Then** it says so
   plainly — an empty result must never read as a clean pass.
3. **Given** individual reports, **When** they are shown, **Then** each names the device, the
   versions it moved between, and distinguishes when the device says it happened from when
   this server received it.

---

### User Story 4 - Add or remove a kind of device (Priority: P3)

An operator defines a new kind of device this server publishes for, or removes one that is no
longer used.

**Why this priority**: Rare, and the previous UI remains available for it during the port.
Nothing about publishing an existing line depends on it.

**Independent Test**: Create one, see it appear with both its channels empty, and remove it.

**Acceptance Scenarios**:

1. **Given** a new name, **When** it is created, **Then** it appears with both channels
   pointing at nothing.
2. **Given** a kind of device with releases against it, **When** removal is attempted,
   **Then** the operator is told what removing it would affect before it happens.

---

### User Story 5 - See only the controls you may use (Priority: P3)

An operator who may read the catalog but not move a channel does not see a promote control.

**Why this priority**: Nothing unsafe happens without it — the server refuses regardless. It
decides whether a permission boundary reads as a boundary or as a broken page.

**Independent Test**: Sign in as an account that may upload but not promote, and confirm the
promote control is absent and the reason stated.

**Acceptance Scenarios**:

1. **Given** an account that may fill the catalog but not move channels, **When** they open
   the screen, **Then** they can read everything and the promote control is absent, with the
   reason given.
2. **Given** an account that may not create or remove kinds of device, **When** they open the
   screen, **Then** those controls are absent too, for the same stated reason.

### Edge Cases

- Two operators promote at the same time: the second sees the result of the first rather than
  silently overwriting it.
- A release is promoted while a device is mid-download of the previous one: the download
  continues; this feature must not be the reason a transfer breaks.
- The channel is pointed at a release that exists but covers none of the devices that follow
  the channel: the operator is told, because the promotion would otherwise appear to succeed
  and reach nobody.
- A kind of device with no releases at all: its channels read as empty rather than as an error.
- Reports arrive for a release that has since been replaced: they are still shown against the
  release they name.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST show every kind of device it publishes for, with what each of
  its two channels currently points at, and MUST say when a channel points at nothing.
- **FR-002**: Operators with permission MUST be able to point a channel at a release.
- **FR-003**: Promotion MUST require an explicit confirmation that names the release being
  replaced and the release replacing it.
- **FR-004**: A promotion that moves a channel backwards MUST be identified as a rollback and
  confirmed separately, and MUST remain possible.
- **FR-005**: After a promotion, the system MUST report any other channel the release was
  taken off.
- **FR-006**: The system MUST surface channels pointing at a kind of device that no longer
  exists, and devices asking for a channel their kind does not have.
- **FR-007**: The system MUST show, for a release, the outcomes devices reported, grouped and
  counted with the most common first.
- **FR-008**: The system MUST state plainly when no device has reported, rather than showing
  an empty list.
- **FR-009**: Individual reports MUST distinguish the time the device claims from the time
  this server recorded.
- **FR-010**: Operators MUST be able to create and remove a kind of device, with removal
  stating its consequences beforehand.
- **FR-011**: Controls MUST be offered only to accounts permitted to use them, and their
  absence MUST be explained.
- **FR-012**: Refusals MUST be reported with the server's stated reason, not a generic failure.

### Key Entities

- **Kind of device**: what this server publishes for; each has exactly two channels, a test
  one and the one the fleet follows.
- **Channel**: a pointer to one release, or to nothing. Moving the fleet's channel is the only
  action that reaches an aircraft.
- **Release**: a published version. Reachable by devices only while a channel points at it.
- **Report**: what one device said happened after applying a release — an outcome, an optional
  error, the versions it moved between, and two timestamps.
- **Stray channel**: a channel naming a kind of device that no longer exists. Serves nothing,
  silently.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A release can be taken from upload to the fleet entirely in the new admin UI,
  without opening the previous one.
- **SC-002**: No channel moves without a person confirming a statement that names both
  releases involved.
- **SC-003**: An operator can tell, from one screen, what every kind of device is currently
  being served.
- **SC-004**: A rollback is always distinguishable from a forward move before it happens, and
  is never silently prevented.
- **SC-005**: A release with no reports is never mistaken for a release that succeeded
  everywhere.
- **SC-006**: An account that may not promote is never shown a promote control.

## Assumptions

- The two channels per kind of device are fixed; this feature does not add, rename or remove
  channels. They are the same two feature 001 names directly: the test channel is `beta` and
  the channel the fleet follows is `stable`. The prose here describes them by their role
  because that is what a reader needs to judge the requirements, but they are not different
  things.
- The evidence for a promotion decision is what devices reported. This feature presents it and
  does not judge it — there is no automatic gate on a success rate.
- The previous admin UI stays available until every screen is ported, so a gap here is
  inconvenient rather than blocking.
- Promotion acts on one kind of device at a time. Moving several at once is out of scope.
- Report retention is whatever the server already keeps; this feature does not change it.

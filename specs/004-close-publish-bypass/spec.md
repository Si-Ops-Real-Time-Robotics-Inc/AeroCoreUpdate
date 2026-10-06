# Feature Specification: Uploading must not be able to ship

**Feature Branch**: `004-close-publish-bypass`

**Created**: 2026-09-10

**Status**: Draft

**Input**: User description: "Close a hole that lets an account which may only fill the catalog put a release in front of the entire fleet."

## Context

This project rests on one asymmetry, stated in its constitution: filling the catalog and
shipping to an aircraft are different rights, and no role but admin holds both. The promise
made in those words is that a leaked credential belonging to someone who may only upload
stages a file — it does not ship firmware.

That promise is currently not kept. The one-shot upload lets the caller name which channel to
point at the artifact, and it checks only the permission to upload. An account that may fill
the catalog and nothing more can therefore, in a single request, put a build in front of the
whole fleet.

**Verified on the running system on 2026-09-10.** A credential holding only the upload
permission was sent to the one-shot upload naming the fleet's channel. It passed the
permission check and was refused later by the archive reader, because the payload sent was
deliberately not a valid bundle. Nothing was stored and no channel moved — but the refusal
came from the wrong place, and that is the defect.

This specification is about restoring the promise, not about adding a new capability.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - An upload cannot reach the fleet (Priority: P1)

Someone who may add to the catalog uploads a build. It goes into the catalog. It does not
reach any aircraft, whatever the request asked for.

**Why this priority**: It is the defect. Everything else in this specification exists to make
sure fixing it does not break something that was working.

**Independent Test**: With a credential that may upload but not publish, upload a valid build
asking for it to land on the fleet's channel; confirm the build is refused or lands only where
that credential is allowed to put it, and that the fleet's channel does not move.

**Acceptance Scenarios**:

1. **Given** a credential that may upload but not publish, **When** it uploads while asking
   for the fleet's channel, **Then** the fleet's channel does not move.
2. **Given** the same credential, **When** it uploads without asking for any particular
   channel, **Then** the build lands where an ordinary upload lands and the catalog gains it.
3. **Given** a stolen copy of that credential, **When** it is used in every way the upload
   allows, **Then** no sequence of requests puts a build in front of an aircraft.

---

### User Story 2 - Publishing still works for those who may (Priority: P1)

An admin, and an automated caller holding the right permission, can still do everything they
could before — including landing a build on a chosen channel in one request.

**Why this priority**: Shares P1 because a fix that quietly removes a capability is a second
defect. The point is to require the right permission, not to withdraw the operation.

**Independent Test**: With a credential that may both upload and publish, repeat the one-shot
upload naming a channel and confirm it behaves exactly as before.

**Acceptance Scenarios**:

1. **Given** a credential that may upload and publish, **When** it uploads naming a channel,
   **Then** the build lands there as it did before this change.
2. **Given** the two-step publish used by the admin UI, **When** an operator uses it, **Then**
   nothing about it changes — it never named a channel and must keep not needing to.
3. **Given** an automated caller that names a channel on upload, **When** it holds the right
   permission, **Then** its existing scripts keep working unchanged.

---

### User Story 3 - A refusal explains itself (Priority: P2)

An operator refused for lack of permission is told which permission is missing and that
uploading itself was not the problem.

**Why this priority**: Nothing is unsafe without it. It decides whether the fix reads as a
boundary or as a broken upload, and an engineer whose upload suddenly fails will otherwise
assume the build is at fault.

**Independent Test**: Trigger the refusal and read the message.

**Acceptance Scenarios**:

1. **Given** a credential that may upload but not publish, **When** it asks for a channel it
   may not move, **Then** the refusal names the missing permission and says the upload itself
   is permitted.
2. **Given** that refusal, **When** an administrator looks for it later, **Then** the attempt
   is recorded, because a credential asking for more than it holds is worth knowing about.

---

### User Story 4 - Every move that reaches the fleet gets the same care (Priority: P3)

Whatever path is used, pointing a channel at an older release is treated the same way:
identified as a backward move and confirmed, rather than done silently.

**Why this priority**: Lower because the situation is narrower — it needs the right permission
first, so it is a mistake by someone entitled to make it rather than an escalation. But two
paths to the same act with different safety is how the careful one becomes decorative.

**Independent Test**: Move a channel backwards through each path and confirm both behave the
same.

**Acceptance Scenarios**:

1. **Given** a channel holding a newer release, **When** an upload would point it at an older
   one, **Then** it is identified as a backward move rather than applied silently.
2. **Given** the same situation through the ordinary publish path, **When** it is attempted,
   **Then** the behaviour is the same as above.

### Edge Cases

- An upload asks for the channel it would have landed on anyway: no additional permission is
  required, because nothing beyond an ordinary upload is being asked for.
- An upload explicitly asks to land nowhere: allowed for anyone who may upload; landing
  nowhere reaches nobody.
- An upload names a channel that does not exist: refused for that reason, not for permission,
  so the operator is not sent looking for the wrong problem.
- A credential holding both permissions: unaffected in every case.
- An upload that fails on its contents: refused for its contents, and the permission question
  never arises.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST NOT let an upload point a channel at the uploaded build unless
  the caller holds the permission to publish.
- **FR-002**: The system MUST continue to accept uploads from callers who hold only the
  permission to upload, landing them where an ordinary upload lands.
- **FR-003**: The system MUST continue to let callers who hold the permission to publish name
  a channel on upload, exactly as before.
- **FR-004**: The two-step publish MUST be unaffected, and MUST remain unable to name a
  channel of its own.
- **FR-005**: A refusal for lack of permission MUST name the missing permission and state that
  uploading itself is allowed.
- **FR-006**: An attempt to name a channel the caller may not move MUST be recorded.
- **FR-007**: Pointing a channel at an older release MUST be identified as a backward move on
  every path that can do it, not only on some.
- **FR-008**: No path MUST exist by which a caller holding only the permission to upload
  causes a build to be offered to a device.

### Key Entities

- **Permission to upload**: may add builds to the catalog. A build in the catalog reaches
  nobody until a channel points at it.
- **Permission to publish**: may point a channel at a build. The only right in this system
  that reaches an aircraft.
- **Channel**: a pointer to one build. Moving the one the fleet follows is what "shipping"
  means here.
- **Upload request**: may optionally name a channel to land on. That option is what this
  feature puts behind the second permission.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: No sequence of requests available to a credential holding only the upload
  permission results in a build being offered to any device.
- **SC-002**: Every capability an admin or an automated caller had before this change still
  works afterwards.
- **SC-003**: The two-step publish behaves identically before and after.
- **SC-004**: An operator refused by this change can tell, from the message alone, that the
  upload was fine and a permission was missing.
- **SC-005**: A backward channel move is identified as such regardless of which path caused it.
- **SC-006**: The guarantee stated in the project constitution — that a leaked upload
  credential stages a file rather than shipping firmware — is true and demonstrable.

## Assumptions

- The permission model itself is correct and unchanged. This feature enforces the boundary the
  model already describes; it does not redraw it.
- Existing automated callers hold the permission appropriate to what they do. If one turns out
  to name a channel while holding only the upload permission, it was relying on the defect and
  its credential needs the right permission rather than the defect preserved.
- Builds already in the catalog, and channels already pointing at them, are left as they are.
  This feature changes what may happen next, not what has happened.
- No new permission is introduced. Two already exist and the distinction between them is
  exactly the one being enforced.

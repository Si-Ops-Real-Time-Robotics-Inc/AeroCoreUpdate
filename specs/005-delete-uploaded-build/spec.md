# Feature Specification: Delete an uploaded build

**Feature Branch**: `005-delete-uploaded-build`

**Created**: 2026-09-11

**Status**: Draft

**Input**: User description: "thiếu chỗ xóa nhánh đã tải lên" — the new admin UI has no way to delete a build that was uploaded.

## Context

The previous admin UI let an administrator remove what had been uploaded: a whole release with
every file in it, or a single file of a release. The new admin UI's catalog lists releases and
offers neither. The capability still exists underneath — only the controls were lost in the
port — and because no specification ever described deletion, nothing noticed. Today an operator
who uploads a wrong or broken build has no way to take it back out from the screen they use.

**What "the uploaded branch" means here.** Channels in this system are fixed: every system has
exactly two, beta and stable, and none can be removed. So removing what was uploaded means
removing a **release**, or one **artifact** (one file) of a release. It never means removing a
channel.

**A defect found while checking this.** Removing a whole release is already refused while a
channel points at it, so a release a device is being offered cannot vanish from under it.
Removing a single artifact has no such protection. If the only artifact serving a platform is
removed from the release that stable points at, every device on stable on that platform is told
there is no update — a correct-looking answer, with no error and no warning anywhere. The fleet
stops updating and nothing says so.

That is the failure this project designs against most deliberately: something broken that looks
exactly like something working. It is the reason the stray-channel banner exists and the reason
the rollout view distinguishes silence from success. The brake on a bad release is pointing the
channel back at the previous one — not deleting its files.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Remove a build nobody is being offered (Priority: P1)

An administrator uploaded the wrong bundle, or a build that turned out to be broken before it
was promoted. They remove it — the whole release, or one file of it — from the screen where they
see the catalog.

**Why this priority**: It is the missing capability. Everything else in this specification makes
sure providing it cannot hurt the fleet.

**Independent Test**: Upload a build, move no channel onto it, remove it from the catalog screen;
confirm it is gone from the catalog and its files are gone.

**Acceptance Scenarios**:

1. **Given** a release no channel points at, **When** an administrator removes it and confirms,
   **Then** the release and every artifact in it disappear from the catalog, and their stored
   files are removed.
2. **Given** a release no channel points at, **When** an administrator removes one of its
   artifacts and confirms, **Then** that artifact disappears and the rest of the release is
   untouched.
3. **Given** either removal, **When** it completes, **Then** the catalog shown to the operator
   reflects it without them reloading the page.

---

### User Story 2 - Deleting cannot silently stop the fleet (Priority: P1)

Whatever an administrator removes, no device loses an update it is being offered because of it.
A build a channel is serving cannot be removed, in whole or in part, until that channel is
pointed somewhere else.

**Why this priority**: Shares P1 because providing US1 without it hands every administrator a
one-click way to stop the fleet updating with no visible sign. Shipping the control without the
protection is worse than not shipping the control.

**Independent Test**: Point stable at a release, then try to remove the release, and separately
each of its artifacts; confirm every attempt is refused, nothing is removed, and devices on
stable are still offered the release.

**Acceptance Scenarios**:

1. **Given** a release a channel points at, **When** an administrator tries to remove the
   release, **Then** it is refused and nothing is removed.
2. **Given** a release a channel points at, **When** an administrator tries to remove any one of
   its artifacts, **Then** it is refused and nothing is removed.
3. **Given** either refusal, **When** the operator reads it, **Then** it names every channel
   serving the release and says the channel has to be pointed elsewhere before the build can be
   removed.
4. **Given** the channel has since been pointed at a different release, **When** the
   administrator tries again, **Then** the removal goes ahead.

---

### User Story 3 - The operator knows what is about to go (Priority: P2)

Before anything is removed, the administrator is told exactly what: which version, of which
system, how many files, or which file for which platform — and that it cannot be undone.

**Why this priority**: Removal is permanent. A confirmation that says only "are you sure" is
asking about nothing, and the one moment an operator can catch removing the wrong build is
before it happens.

**Independent Test**: Start a removal, read the confirmation, decline it; confirm nothing was
removed.

**Acceptance Scenarios**:

1. **Given** an administrator starts removing a release, **When** the confirmation appears,
   **Then** it names the version and system, how many artifacts go with it, and that it cannot
   be undone.
2. **Given** an administrator starts removing an artifact, **When** the confirmation appears,
   **Then** it names the file, its platform, and the release it belongs to.
3. **Given** either confirmation, **When** the administrator declines, **Then** nothing is
   removed and nothing further is sent.

---

### User Story 4 - Only those who may remove builds are offered to (Priority: P3)

An account that may not remove builds sees no control to do so, and is told which permission it
would need.

**Why this priority**: Nothing unsafe happens without it — removal is refused regardless — but a
control whose only outcome is a refusal reads as a broken page rather than as a permission
nobody granted.

**Independent Test**: Open the catalog as a publisher and as a viewer.

**Acceptance Scenarios**:

1. **Given** an account that may upload but not remove, **When** it opens the catalog, **Then**
   no removal control is shown and the permission it would need is named.
2. **Given** an account that may only read, **When** it opens the catalog, **Then** the same.

### Edge Cases

- **A release served by both channels**: the refusal names both.
- **A channel moves onto the release while the confirmation is open**: the check made at the
  moment of removal is the one that counts; the removal is refused then, even though the screen
  showed the release as unserved a moment earlier.
- **Someone else removed it first**: reported as already gone, not as a failure, and the catalog
  refreshes to show the current state.
- **Removing the last artifact of an unserved release**: allowed. The release stays, with no
  artifacts, until it is removed on its own.
- **A device that learned of a version while it was still being offered, and asks for it after
  it was removed**: told it does not exist. That is a visible failure on the device, not a
  silent one, and it can only happen to a version no channel serves any more.
- **A build removed while a refusal message is on screen for it**: the next action shows the
  current state rather than acting on the stale one.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: An account holding the permission to remove builds MUST be able to remove a
  release, together with every artifact in it, from the catalog screen of the admin UI.
- **FR-002**: The same account MUST be able to remove a single artifact of a release from the
  catalog screen.
- **FR-003**: The system MUST refuse to remove a release while any channel points at it. This
  already holds and MUST keep holding.
- **FR-004**: The system MUST refuse to remove an artifact of a release while any channel points
  at that release.
- **FR-005**: A refusal under FR-003 or FR-004 MUST name every channel serving the release and
  state that the channel has to be pointed elsewhere before the build can be removed.
- **FR-006**: Before anything is removed, the operator MUST be shown what will be removed — for a
  release its version, system and number of artifacts; for an artifact its file, platform and
  release — and that removal cannot be undone. Nothing MUST be removed until the operator
  confirms, and declining MUST send nothing.
- **FR-007**: An account without the permission to remove builds MUST NOT be offered the
  control, and MUST be told which permission it needs.
- **FR-008**: Every removal MUST be recorded, with who removed what and when.
- **FR-009**: After a removal, the catalog shown to the operator MUST reflect it without a manual
  reload.
- **FR-010**: A removal of something already gone MUST be reported as already gone rather than
  as a failure.
- **FR-011**: The documented interface for removing builds MUST describe every outcome it can
  produce, including each kind of refusal.
- **FR-012**: Uploading, publishing, promoting a channel and rolling one back MUST behave exactly
  as before.

### Key Entities

- **Release**: one version of one system. May be pointed at by a channel, in which case devices
  on that channel are being offered it.
- **Artifact**: one stored file of a release, serving one or more platforms. Removing it removes
  the file.
- **Channel**: beta or stable of a system, fixed and not removable; points at one release or at
  nothing. Pointing it is what reaches devices.
- **Permission to remove builds**: held by administrators only. Distinct from the permission to
  upload and from the permission to move a channel.
- **Audit record**: who removed which build, and when.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An administrator can remove a wrongly uploaded build from the admin UI in under a
  minute, without opening the previous UI.
- **SC-002**: No sequence of removals, by any account, leaves a device on any channel told there
  is no update because of a removal — zero occurrences.
- **SC-003**: Every refused removal (100%) names the channel or channels serving the build and
  what must happen first.
- **SC-004**: No build is removed without the operator having confirmed a message that names it.
- **SC-005**: Publisher and viewer accounts are shown zero removal controls, and each is told
  which permission removal needs.
- **SC-006**: Every removal appears in the audit record.

## Assumptions

- **Removing any artifact of a served release is refused, not only the last one serving a
  platform.** A narrower rule — refuse only when a platform would be left with nothing — was
  considered and rejected: whether an artifact is the last one serving a platform depends on how
  the server is configured to fall back from one kind of artifact to another, so the rule would
  change meaning with configuration and be easy to get wrong. The broader rule is the one
  releases already follow, and it keeps the documented brake as the only brake: to stop a bad
  release reaching devices, point its channel back at the previous one, then remove it. This
  tightens behaviour an administrator could previously rely on, deliberately.
- The permission model is unchanged: only administrators may remove builds. No new permission is
  introduced.
- Removal is permanent. There is no recycle bin and no undo; that is out of scope.
- Removing the last artifact of a release leaves the release in place. Removing the release is a
  separate, deliberate act.
- One build is removed at a time. Bulk removal is out of scope.
- Channels remain fixed and cannot be removed; this feature does not change that.
- The previous admin UI remains the behavioural reference and is not modified.

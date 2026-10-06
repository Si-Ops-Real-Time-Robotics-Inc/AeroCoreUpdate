# Feature Specification: Publish a firmware bundle from the new admin UI

**Feature Branch**: `001-publish-bundle-upload`

**Created**: 2026-09-10

**Status**: Draft

**Input**: User description: "Port the Publish tab from the previous admin UI into the new admin UI, so an operator can upload a firmware update bundle again."

## Workflow context

Publishing is two jobs done by two people, and the split is the safety property.

1. **An engineer or an admin uploads a bundle.** It lands on `beta` and nowhere else.
   `beta` is followed only by devices an operator deliberately put there, so a mistaken
   upload reaches the test group rather than the fleet.
2. **An admin reviews what is on `beta` and promotes it to `stable`.** `stable` is what
   the fleet follows. This is a separate, deliberate act by a different level of
   authority — an engineer cannot do it.

**This feature is step 1 only.** Step 2 is the promote control, which lives on another
screen and is specified separately. Naming it here is what explains why publishing stops
where it does: an upload that could also move `stable` would collapse the two jobs into
one and remove the review that stands between a build and an aircraft.

The two channel names are fixed rather than configurable, and every system has exactly
these two.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Publish a release (Priority: P1)

An operator has built a firmware bundle and needs it in the catalog so the test group
starts receiving it. They open the admin UI, choose the file, watch it transfer, look at
what the server found inside it, and confirm. The release lands on the test channel; the
channel the fleet follows is untouched until somebody promotes it separately.

**Why this priority**: This is the capability the server exists for. Without it the new
admin UI cannot do the one job that matters, and every release has to go through the
previous UI instead.

**Independent Test**: Upload a known-good bundle and confirm it appears in the catalog on
the staging channel, with the fleet's channel still pointing where it did before.

**Acceptance Scenarios**:

1. **Given** an operator permitted to add to the catalog, **When** they choose a valid
   bundle and confirm it, **Then** the release appears in the catalog on the staging
   channel and the fleet's channel is unchanged.
2. **Given** a transfer in progress, **When** the operator watches the screen, **Then**
   they see how much has transferred and how much remains, rather than an unmoving screen.
3. **Given** the file was altered or truncated in transit, **When** it arrives, **Then**
   it is refused and nothing is stored.

---

### User Story 2 - Look before committing (Priority: P1)

Before anything is stored, the operator sees what the server found inside the bundle: what
it contains, which settings it carries and which of those a device has locked, which
plugins are inside and which product they belong to, any warnings, and what changes
against the release below it. They then either confirm or discard.

**Why this priority**: Shares P1 with the upload itself because the two-step review is the
safety property, not a convenience. A firmware release that reaches an aircraft cannot be
recalled, and the review is the last point where a person can still say no. An upload that
stored on arrival would remove it.

**Independent Test**: Upload a bundle, verify nothing is in the catalog yet, discard it,
and verify nothing was ever stored.

**Acceptance Scenarios**:

1. **Given** a bundle has transferred, **When** the review appears, **Then** it states
   plainly that nothing has been stored yet.
2. **Given** the operator discards it, **When** they look at the catalog, **Then** no
   release was created and no file was kept.
3. **Given** the bundle changes nothing against the release below it, **When** the review
   appears, **Then** it says so, rather than showing an empty list of changes.
4. **Given** the bundle carries settings a device has locked, **When** the review appears,
   **Then** locked and unlocked settings are shown apart, because the locked ones will not
   be applied.

---

### User Story 3 - Answer the one question a bundle cannot (Priority: P2)

Some bundles carry only settings and nothing that identifies which devices they are for.
The server cannot decide this and refuses. The operator is asked which devices the bundle
targets, picks them, and the upload proceeds.

**Why this priority**: Without it, this class of bundle is simply unpublishable from the
new UI and the operator is sent back to the previous one with no explanation of why.

**Independent Test**: Upload a settings-only bundle, confirm the prompt appears, choose
targets, and confirm the upload then succeeds.

**Acceptance Scenarios**:

1. **Given** a bundle that names no target devices, **When** it is refused for that
   reason, **Then** the operator is asked which devices it is for, rather than shown a
   generic failure.
2. **Given** the operator answers, **When** they retry, **Then** the upload proceeds
   without them having to choose the file again.

---

### User Story 4 - See only what you may do (Priority: P3)

An account permitted to read the catalog but not to add to it sees the publish screen
without controls that would be refused.

**Why this priority**: Lower because nothing unsafe happens without it — the server
refuses regardless. It is about not presenting a button whose only outcome is a refusal,
which reads as a broken page rather than as a permission nobody granted.

**Independent Test**: Sign in with a read-only account and confirm the upload control is
absent and the reason is stated.

**Acceptance Scenarios**:

1. **Given** a read-only account, **When** they open the publish screen, **Then** no
   upload control is offered and the screen says why.

### Edge Cases

- The operator navigates away while a transfer is in progress: nothing is stored, and the
  staged bundle does not linger as a half-finished release.
- The bundle is larger than the server accepts: refused with the limit stated, not a
  generic failure.
- The bundle omits a setting an earlier release established: the review surfaces this,
  because a device that skipped releases will never receive that setting and will report
  success anyway.
- Two operators stage uploads at the same time: each review reflects the bundle that
  operator sent.
- The staged bundle is confirmed twice: the second attempt does not create a second
  release.
- The operator loses their session between staging and confirming: they are told, rather
  than seeing the confirmation silently fail.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Operators MUST be able to choose a bundle either by dragging it onto the
  screen or by picking it from a file browser.
- **FR-002**: The system MUST verify the bundle arrived intact and refuse it otherwise,
  before anything is stored.
- **FR-003**: The system MUST show transfer progress while a bundle is being sent.
- **FR-004**: The system MUST NOT store anything until the operator confirms, and MUST
  state on the review screen that nothing has been stored yet.
- **FR-005**: Operators MUST be able to discard a staged bundle. Because nothing was stored,
  discarding MUST be reported as "nothing was stored" rather than as a deletion.
- **FR-006**: The review MUST show the bundle's contents, the settings it carries with
  locked ones distinguished from unlocked, the plugins it contains named with the product
  each belongs to, and any warnings the server raised.
- **FR-007**: The review MUST show what changes against the release below it, and MUST say
  explicitly when nothing changes.
- **FR-008**: When a bundle is refused because it does not identify its target devices,
  the system MUST ask the operator which devices it is for and allow the upload to be
  retried without re-choosing the file.
- **FR-009**: On confirmation, the release MUST land on `beta` only. `stable`, the channel
  the fleet follows, MUST NOT move as part of publishing — by any account, including an
  admin who holds the permission to move it elsewhere.
- **FR-012**: The screen MUST make clear, once a release is published, that it is on `beta`
  and that reaching the fleet needs a separate promotion. An operator who believes the job
  is finished is how a release sits unshipped for a week.
- **FR-010**: The system MUST offer the upload control only to accounts permitted to add
  to the catalog, and MUST state the reason when it is withheld.
- **FR-011**: Refusals MUST be reported with the server's stated reason, not a generic
  failure message.

### Key Entities

- **Bundle**: the file an operator uploads. Carries a version, the devices it targets, its
  contents, and the settings it establishes.
- **Staged upload**: a bundle the server has read and described but not stored. Identified
  by a token, and either confirmed or discarded. Not a release.
- **Release**: what a staged upload becomes once confirmed. Visible in the catalog, and
  reachable by devices only once a channel points at it.
- **Inspection**: what the server found inside a bundle — contents, settings, plugins,
  warnings.
- **Diff**: how a bundle differs from the release below it, including the case where it
  differs in nothing.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An operator can publish a release entirely from the new admin UI, without
  opening the previous one.
- **SC-002**: A corrupted or truncated bundle is refused every time, and never appears in
  the catalog.
- **SC-003**: No bundle is stored without an explicit confirmation from a person.
- **SC-004**: Publishing a release never changes what the fleet is currently being served;
  `stable` moves only through the separate promotion step.
- **SC-007**: An engineer can complete the whole publish flow without ever being able to
  ship to the fleet.
- **SC-005**: An operator can tell, from the review screen alone and without asking anyone,
  whether the bundle changes anything and whether it carries settings that will not apply.
- **SC-006**: A settings-only bundle, which the previous UI could publish, can be published
  here too.

## Assumptions

- The server's publish endpoints are unchanged; this feature moves the operator-facing part
  and adds nothing to the protocol.
- `beta` and `stable` are fixed names, not deployment settings, and every system has both.
  This feature offers no way to publish directly to `stable`.
- Bundle inspection, the settings comparison and the change summary are produced by the
  server. This feature presents them and does not re-derive them.
- Operators use a desktop browser. Publishing firmware from a handset is out of scope.
- The previous admin UI stays available until every screen is ported, so a gap here is
  inconvenient rather than blocking.

# Feature Specification: The identity provider becomes the only way in

**Feature Branch**: `002-remove-local-auth`

**Created**: 2026-09-10

**Status**: Draft

**Input**: User description: "Remove local password authentication entirely, so the identity provider hosted by proxy_alpha becomes the only way anyone signs in to this server."

## Context

This server is a microservice. Its owner decided that the platform's identity provider is the
guarantee, and that a second way in — a password account kept here for the provider's bad
days — is a second identity system rather than a safety net. Constitution principle I was
amended to say so before this specification was written.

The trade is recorded and is **not re-opened here**: while the provider is unreachable, this
server's operator API is unreachable too, including to stop a release that is going badly.
The answer to that is a more dependable provider, not a spare door in this repository.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - One way in (Priority: P1)

An operator opens the admin UI and signs in with their organisation account. There is no
password form, no second option, and nothing to choose between.

**Why this priority**: It is the feature. Everything else here is a consequence of it.

**Independent Test**: Open the sign-in screen and confirm the organisation account is the only
way in offered, and that it works end to end.

**Acceptance Scenarios**:

1. **Given** an operator with an organisation account that carries an operator role, **When**
   they sign in, **Then** they reach the admin UI with exactly the permissions that role
   grants.
2. **Given** the sign-in screen, **When** an operator looks at it, **Then** no username or
   password field is offered anywhere on it, by any means or address.
3. **Given** an operator with an organisation account carrying no operator role, **When** they
   sign in, **Then** they are refused with a message naming what they lack.

---

### User Story 2 - Nothing here opens this server (Priority: P1)

The server holds no credential that grants access to itself: no stored account, no signing
secret for sessions it mints, no generated password in a log.

**Why this priority**: Shares P1 because it is the actual goal. Removing the form while
leaving the account, the secret and the token machinery behind would change the screen and not
the system.

**Independent Test**: Search the running configuration and the database for anything that
could be presented to this server to obtain operator access; find nothing.

**Acceptance Scenarios**:

1. **Given** the deployed server, **When** its configuration is inspected, **Then** it holds no
   secret used to sign or verify a session it issued itself.
2. **Given** the database, **When** it is inspected, **Then** it holds no operator account and
   no operator session.
3. **Given** a fresh deployment, **When** it starts for the first time, **Then** it creates no
   account and prints no password.
4. **Given** someone who obtains a copy of this server's configuration, **When** they try to
   use it to reach the operator API, **Then** there is nothing in it that lets them.

---

### User Story 3 - The previous admin UI keeps working (Priority: P2)

The previous admin UI is still the only place to do four of the six operator jobs. Signing in
to it through the organisation account continues to work exactly as before.

**Why this priority**: Lower than the two above because it is preservation rather than change —
but it is not optional. Breaking it would take four capabilities offline until the port
finishes.

**Independent Test**: Sign in to the previous UI through the organisation account and complete
a publish.

**Acceptance Scenarios**:

1. **Given** the previous admin UI, **When** an operator signs in through the organisation
   account, **Then** they reach it and can use every screen it offers.
2. **Given** the previous admin UI, **When** an operator looks for the password form it used
   to have, **Then** it is gone and the screen says the organisation account is the way in.

---

### User Story 4 - An outage says so (Priority: P3)

When the identity provider cannot be reached, the sign-in screen states that plainly instead
of failing in a way that looks like a broken page.

**Why this priority**: Nothing is unsafe without it. It decides whether an outage costs an
operator thirty seconds or an hour of misdirected debugging.

**Independent Test**: Make the provider unreachable and confirm the screen names the cause.

**Acceptance Scenarios**:

1. **Given** the provider is unreachable, **When** an operator opens the sign-in screen,
   **Then** it says the provider cannot be reached and that sign-in is unavailable until it
   is — not "sign-in failed".
2. **Given** the provider is unreachable, **When** an operator looks for another way in,
   **Then** the screen states there is none, rather than leaving them to search.

### Edge Cases

- An operator is signed in through the old local mechanism when the change is deployed: their
  session stops working, and they are returned to the sign-in screen rather than left on a
  page whose every action is refused.
- Devices in the fleet are unaffected: their path into this server never involved any of this.
- The provider is reachable but the account carries no operator role: refused, and told which
  role is missing — this is not an outage and must not read like one.
- Someone restores an old database backup containing operator accounts: those rows grant
  nothing, because nothing reads them any more.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST accept operator identity only from the platform's identity
  provider.
- **FR-002**: The system MUST NOT offer any way to sign in with a username and password.
- **FR-003**: The system MUST NOT issue, store, rotate or verify sessions of its own making.
- **FR-004**: The system MUST NOT hold any secret whose purpose is to grant access to itself.
- **FR-005**: A fresh deployment MUST NOT create an operator account, and MUST NOT print a
  credential anywhere, including logs.
- **FR-006**: The system MUST remove stored operator accounts and their sessions, and MUST NOT
  read them if they are restored from a backup.
- **FR-007**: Sign-in through the identity provider MUST keep working on both admin UIs, with
  permissions still derived from the roles the provider reports.
- **FR-008**: Device authentication MUST be unchanged.
- **FR-009**: When the provider cannot be reached, the sign-in screen MUST name that as the
  cause and state that no alternative exists.
- **FR-010**: Settings that existed only to serve the removed path MUST be removed from
  configuration and from the documentation that describes it, so nothing documents a knob that
  does nothing.
- **FR-011**: Documentation describing the removed account MUST be corrected in the same
  change, not left to be found later.

### Key Entities

- **Operator account**: previously a row on this server; now exists only in the identity
  provider. This feature removes the local one.
- **Operator session**: previously issued and rotated by this server; now the provider's
  token is the whole of it.
- **Sign-in attempt record**: existed to slow down password guessing. With no password to
  guess, it has nothing to protect.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: The number of ways to obtain operator access to this server is exactly one.
- **SC-002**: No credential capable of granting operator access exists in this server's
  configuration, its database, or its logs.
- **SC-003**: An operator with the right role signs in and works exactly as before the change,
  through both admin UIs.
- **SC-004**: Device update traffic is unaffected: the same requests succeed before and after.
- **SC-005**: A first-time deployment completes with no account created and no credential
  printed.
- **SC-006**: Every setting the documentation describes still does something.

## Assumptions

- The identity provider is proxy_alpha's responsibility, including its availability. This
  feature does not add, monitor or work around that.
- Operators already have organisation accounts; no migration of local accounts is needed,
  and none is offered.
- Existing local sessions may be ended abruptly by the deployment. There is no requirement to
  keep them alive through the change.
- The previous admin UI remains deployed until its remaining screens are ported, so this
  feature must not break it.
- Removing the stored accounts is acceptable without an export: the accounts hold no
  information the platform's provider does not already have.

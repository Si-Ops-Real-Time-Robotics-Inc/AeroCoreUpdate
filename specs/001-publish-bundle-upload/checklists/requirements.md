# Specification Quality Checklist: Publish a firmware bundle from the new admin UI

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-09-10
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs)
- [x] Focused on user value and business needs
- [x] Written for non-technical stakeholders
- [x] All mandatory sections completed

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain
- [x] Requirements are testable and unambiguous
- [x] Success criteria are measurable
- [x] Success criteria are technology-agnostic (no implementation details)
- [x] All acceptance scenarios are defined
- [x] Edge cases are identified
- [x] Scope is clearly bounded
- [x] Dependencies and assumptions identified

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria
- [x] User scenarios cover primary flows
- [x] Feature meets measurable outcomes defined in Success Criteria
- [x] No implementation details leak into specification

## Notes

The feature description this came from was written in implementation terms — endpoint
paths, a hashing algorithm, a header name, a transport that can report progress. Those
were deliberately translated out: "verify the bundle arrived intact" rather than the
algorithm, "show transfer progress" rather than the mechanism. They are real constraints
and they belong in plan.md, not here, where naming them would fix the design before it has
been argued.

One term survives on purpose: a staged upload is "identified by a token". It is a domain
concept an operator's session actually depends on — the thing that is confirmed or
discarded — not a transport detail.

No clarification markers were raised. The two questions worth asking both had a defensible
default already established by the previous UI and by the server's own configuration: the
staging channel is a deployment setting rather than an operator choice, and permission to
publish is already modelled as a scope. Inventing new answers here would contradict a
system that is already running.

## Clarification recorded 2026-09-10

The publishing workflow was stated by the product owner and written into a Workflow context
section: an engineer or admin uploads and it lands on `beta`; an admin reviews and promotes
to `stable`; the fleet follows `stable`.

Verified against the running system rather than accepted on trust:

- `src/config/index.js` fixes `stagingChannel: 'beta'` and `releaseChannel: 'stable'` as
  literals, so these are not deployment settings and the spec says so.
- The promote route requires the `channel:write` scope, which the publisher role does not
  carry — checked live against the realm, where an engineer account resolves to
  `artifact:write`, `catalog:read`, `self` and nothing more.
- The catalog currently shows `HERA|beta|0.13.5` with `HERA|stable` empty, which is this
  workflow mid-flight: something uploaded and awaiting an admin's decision.

The clarification tightened FR-009, added FR-012 and SC-007, and moved the channel names
out of the Assumptions section, where they had been described as configurable.

# Specification Quality Checklist: Uploading must not be able to ship

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

The description this came from named a route, a query parameter, two permission strings and a
line of SQL. All of it was translated out — "the one-shot upload lets the caller name which
channel" rather than the parameter, "the permission to publish" rather than its identifier.
The evidence stayed, because a defect specification that cannot say how the defect was
demonstrated is asking to be taken on trust.

**A specification for a defect, not a capability.** Every user story after the first exists to
constrain the fix rather than to extend it: US2 says the operation must survive, US3 says the
refusal must be legible, US4 says the two paths must agree. A fix that quietly removes the
ability to land a build on a named channel would satisfy US1 and fail the feature.

**Deliberately out of scope, and stated as an assumption**: redrawing the permission model.
Two permissions already exist and the distinction between them is exactly the one being
enforced. Inventing a third here would turn a defect fix into a design change nobody asked
for, in the area of the system with the least room for improvisation.

**Also deliberate**: nothing is done about builds already in the catalog or channels already
pointing at them. The defect allowed a state to be reached; the state itself is not evidence
that anything wrong was done, and rolling channels back on suspicion would ship firmware in
its own right.

No clarification markers were raised. The one question worth asking — whether any existing
automated caller relies on the defect — is answered in the Assumptions as a matter of policy
rather than fact: a caller that names a channel while holding only the upload permission was
relying on the hole, and the answer is to give it the right permission, not to keep the hole.

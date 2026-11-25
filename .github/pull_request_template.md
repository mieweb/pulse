## Change

Describe the concrete problem and resulting behavior. Link the issue and any required predecessor.

## Scope and review

- [ ] This PR has one clear outcome; every changed file supports it.
- [ ] Implementation, tests, migrations and documentation needed to assess that outcome are included, with unrelated work excluded.
- [ ] The stated base and linked dependencies let a reviewer assess correctness without another unmerged PR.

## Validation

Record commands and results, the platform checked, evidence links, skipped coverage and remaining acceptance work.

## One-handed phone flow review

Choose one and explain:

- [ ] Applies: this PR changes a phone UI or flow.
- [ ] N/A: no phone UI or flow changes. Reason:

If applicable:

- [ ] Reviewed the complete affected flow, including entry, Back/Close/Cancel, primary actions, loading, errors, sheets and keyboard states.
- [ ] Required app-owned operations have lower-half controls and a reachable path for either hand, including button alternatives to required gestures.
- [ ] Reviewed safe areas, small screens, large text, RTL, accessibility labels/focus and conflicts with navigation, scrolling, recording and editing gestures.
- [ ] Attached before/after screenshots or a short clip and recorded the platform, device/simulator, text sizes and accessibility checks.
- [ ] Listed OS-owned controls and any app-owned exceptions below, with rationale, reachable fallback or linked follow-up. Unverified actual thumb reach is stated separately from simulator layout results.

Exceptions, follow-ups and remaining physical reach checks:

See [AGENTS.md](https://github.com/mieweb/pulse/blob/main/AGENTS.md#one-handed-phone-use) and
[the audit](https://github.com/mieweb/pulse/blob/main/docs/one-handed-navigation.md).

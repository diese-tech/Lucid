# UI Pattern Adoption from Ratatoskr — Planning Phase

**Status:** Planning (no implementation yet)

## Overview

Ratatoskr (the sibling bot in the same ecosystem) recently completed a UI refresh (PR #117, Sep 16) that shifts staff card rendering from pure markdown text to Discord embeds with color-coded status indicators. This issue documents patterns we can adopt in Lucid to reduce visual clutter, improve status recognition, and unify the user experience across both bots.

## Discovery: Ratatoskr's Embed Pattern

### Recent Changes (Commit 886362c)

Ratatoskr switched their operation cards from text-based to embed-based rendering:

```typescript
// Old (text-based)
content: `**✓ Svartalfheim Scout finished**\n<t:${setup.startAt}:t>`

// New (embed-based)
embeds: [{
  title: `✓ Svartalfheim Scout finished`,
  description: `<t:${setup.startAt}:t>`,
  color: 0x22c55e,  // Green for success
}]
```

### Color-Coding System by Status

Ratatoskr uses a consistent color scheme that translates to Discord's left-border visual indicator:

| Status | Hex Color | Meaning | Example |
|--------|-----------|---------|---------|
| **Success/Finished** | `0x22c55e` (Green) | Pickup complete | ✓ published and finished |
| **Ready** | `0x0d9488` (Teal) | Ready for action | Roster ready for review |
| **Active/Collecting** | `0x3b82f6` (Blue) | In progress | Collecting signups |
| **Warning/Action** | `0xf59e0b` (Amber) | Needs attention | Replacement needed |
| **Cancelled/Closed** | `0x6b7280` (Gray) | Terminated | Pickup cancelled |

### Visual Result

Users see Discord message cards with:
- **Colored left border** (status indicator at a glance)
- **Clean title** in the header (no markdown formatting needed)
- **Structured description** instead of inline markdown
- **Instant status recognition** without reading text

## Current Lucid Rendering (Status Quo)

**Signup post:** Plain markdown text (intentionally hand-written aesthetic)

**Staff cards (review/control/published):** Plain markdown with `## Headers` and `**bold**`

```typescript
// Current Lucid control card
## Pickup Open

**Start:** <t:1234567890:t> <t:1234567890:R>
**Role limit:** 2 roles
...
```

**Limitations:**
- No visual status indication (must read text)
- Markdown formatting is dense
- No distinction between card types at a glance
- Warnings inline with content (clutter)

## Proposed Changes

### Phase 1: Embed-Based Staff Cards

Convert staff cards to embed-based rendering while keeping public signup post as plain text:

#### 1.1 Control Card (Pickup Open)
```typescript
embeds: [{
  title: 'Pickup Open',
  description: `Start: <t:1234567890:F> • <t:1234567890:R>
Role limit: 2 roles
...
**Unseated eligible signups (8)**
<@user1> · Solo, Fill
<@user2> · Jungle
...`,
  color: 0x3b82f6,  // Blue — active
}]
```

#### 1.2 Review Card (Roster Ready)
```typescript
embeds: [{
  title: 'Pickup Ready',
  description: `Start: <t:...>

### Order
Solo: <@user1>
Jungle: OPEN
...`,
  color: 0x0d9488,  // Teal — ready
}]
```

#### 1.3 Compact Published Card
```typescript
embeds: [{
  title: '✓ Pickup Published',
  description: '<t:...>',
  color: 0x22c55e,  // Green — success
}]
```

#### 1.4 Expanded Published Card (with replacement needed)
```typescript
embeds: [{
  title: '⚠️ Replacement Needed',
  description: `Start: <t:...>
[Roster + candidates...]`,
  color: 0xf59e0b,  // Amber — warning
}]
```

#### 1.5 Finished Card
```typescript
embeds: [{
  title: '✓ Pickup Finished',
  description: `Started: <t:...>
Finished by @staff-user manually.`,
  color: 0x22c55e,  // Green — complete
}]
```

### Phase 2: Content Optimization

Adopt Ratatoskr's clutter-reduction techniques:

#### 2.1 Bounded Card Sections with Reserved Trailing Space

Replace `boundedLines()` with `appendBoundedCardSection()` that reserves space for trailing warnings:

```typescript
function appendBoundedCardSection(
  lines: string[],
  heading: string,
  entries: readonly string[],
  empty: string,
  omitted: (count: number) => string,
  reservedTrailingLines: readonly string[],
  contentLimit: number,
): void {
  // Ensures "Unseated eligible" section doesn't cut into warnings
  // by pre-allocating space for trailing content
}
```

**Impact:** Prevents roster display from truncating warnings on large benches.

#### 2.2 Eligibility Context Inline

Show *why* someone is ineligible next to their name:

```typescript
// Old
**Ineligible signups (2)**
<@user1>
<@user2>

⚠️ One or more players no longer hold an eligibility role.

// New
**Ineligible signups (2)**
<@user1> · Solo — missing <@&eligibility-role>
<@user2> · Jungle — missing <@&eligibility-role>
```

**Impact:** Single unified view; no separate warning block needed.

#### 2.3 Consolidate Warnings

Move warning context into the roster display itself:

```typescript
// Show directly in team block
Order
Solo: <@user1> ⚠️ replacement needed
Jungle: OPEN
Mid: <@user2> ⚠️ no longer eligible
```

**Impact:** All context in one place; easier to scan.

## Implementation Checklist

This is a **planning phase only.** No implementation begins until this is approved and scoped.

### Phase 1 Tasks (Embed Conversion)
- [ ] Audit all current card render functions
- [ ] Design `renderCardEmbed()` base function
- [ ] Convert `renderControlCard()` to embed
- [ ] Convert `renderReviewCard()` to embed
- [ ] Convert `renderCompactPublishedCard()` to embed
- [ ] Convert `renderExpandedPublishedCard()` to embed
- [ ] Convert `renderFinishedCard()` to embed
- [ ] Update `renderCancelledCard()` to embed
- [ ] Update all call sites in flows
- [ ] Update embed comparison in reconcile.ts
- [ ] Write embed-specific tests
- [ ] Verify colors against Discord rendering

### Phase 2 Tasks (Content Optimization)
- [ ] Implement `appendBoundedCardSection()` to replace `boundedLines()`
- [ ] Extract eligibility failure reasons (requires `eligibility.ts` audit)
- [ ] Update signup display to include eligibility context
- [ ] Consolidate warning rendering into roster display
- [ ] Update tests for new warning format
- [ ] Verify clutter reduction on large rosters (10+ unseated)

### Phase 3 Tasks (Polish & Validation)
- [ ] Update reconciliation logic for embed format
- [ ] Test embed edits (no unnecessary Discord API calls)
- [ ] Manual smoke test all card states
- [ ] Verify accessibility (color + text, not color alone)
- [ ] Document embed color scheme in code comments
- [ ] Commit, push, open PR

## Open Questions

1. **Keep signup post as text?** Yes — it intentionally looks hand-written. Public posts stay unchanged.

2. **Apply to notification cards?** Defer to separate PR. Notifications are simpler; address separately if needed.

3. **Color scheme final?** Ratatoskr's colors work well, but consider if any should differ for Lucid (e.g., brand colors).

4. **Backwards compatibility?** All staff cards are edited in place (existing logic); no breaking changes to player-facing surfaces.

5. **Test coverage impact?** Embed rendering tests will need updates; see Phase 1 checklist.

## References

- **Ratatoskr PR #117:** `feat(scout): render operations cards and alerts as embeds` (Sep 16, 2026)
- **Ratatoskr commit 886362c:** Actual implementation reference
- **Lucid current render:** `src/discord/render.ts` (634 lines)
- **Ratatoskr embed pattern:** `src/services/scoutCardLifecycle.ts` (lines 81–165)

## Success Criteria

- ✅ All staff cards render as embeds with consistent color-coding
- ✅ Status is recognizable at a glance (by color border)
- ✅ Content is not clipped due to warning space; warnings always visible
- ✅ Eligibility context is shown inline (no separate "ineligible" warning block)
- ✅ All tests pass; no regressions
- ✅ Manual testing confirms visual clarity improvement
- ✅ Code is consistent with Lucid's existing patterns (no new dependencies)

## Next Steps

1. **Review this plan** — feedback on scope, colors, priorities
2. **Approve planning phase** — confirm direction before implementation
3. **Open implementation PR** — track progress on Phase 1, 2, 3 tasks
4. **Ship incrementally** — embed conversion (Phase 1) can ship independently of content optimization (Phase 2)

---

**Issue Type:** Planning / Enhancement  
**Scope:** UI / Rendering  
**Effort:** Large (~3–4 PR cycles for full completion)  
**Priority:** Tier 2 (ships after core pickup workflows are stable)

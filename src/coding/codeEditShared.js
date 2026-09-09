// src/coding/codeEditShared.js
//
// Shared between continue-bridge.js (Continue's apply role) and the voice
// "edit the current file" path in discord/tools/sttsTools.js + Lily's
// generateFileEdit(). Both ultimately do the same job — take a file's
// original content plus a description of a change, and produce the
// complete new file content — so the system prompt and the safety checks
// that guard against a hallucinated/shrunk rewrite live here once instead
// of being duplicated (and drifting) across both call sites.

export const CODE_SYSTEM_PROMPT = `You are a code-merging engine. You will be given a file's original content and a set of proposed changes. Output ONLY the complete final file content with the changes correctly applied — nothing else. No explanations, no commentary, no markdown code fences, no "Here's the updated file" preamble. Every line of code not part of the change must be preserved exactly as-is.`

export const OVERWRITE_GUARD = {
    minOriginalLines: 40,      // only size-guard files bigger than this
    maxShrinkRatio: 0.5,       // block if new content < 50% of original size
    minStubHits: 1,            // any `{ ... }`-as-body is disqualifying
}

// Matches `{ ... }` (or `{...}`, `{  ...  }`, etc.) used as a body right
// after a function/method signature — never valid real code, and a
// near-unambiguous sign of a lazily-generated skeleton instead of a real
// implementation.
export const STUB_BODY_PATTERN = /\)\s*\{\s*\.\.\.\s*\}/g

/**
 * Returns a block reason string if newContent looks like a hallucinated
 * "simplified" rewrite of a real file, or null if it's fine.
 */
export function checkShrinkRatio(originalContent, newContent, label = "the file") {
    const originalLines = originalContent.split("\n").length
    if (originalLines < OVERWRITE_GUARD.minOriginalLines) return null
    if (!newContent) return null

    const shrinkRatio = newContent.length / Math.max(originalContent.length, 1)
    if (shrinkRatio < OVERWRITE_GUARD.maxShrinkRatio) {
        return (
            `BLOCKED: this would replace ${label} (${originalLines} lines, ` +
            `${originalContent.length} chars) with only ${newContent.length} chars — ` +
            `that's a ${Math.round((1 - shrinkRatio) * 100)}% reduction, which looks like ` +
            `a hallucinated/simplified rewrite rather than a real edit.`
        )
    }
    return null
}

/**
 * Returns a block reason string if text contains a `{ ... }` used as a
 * literal stand-in for a real function/method body, or null if it's fine.
 */
export function checkStubBodies(text, label = "the file") {
    const hits = (text.match(STUB_BODY_PATTERN) ?? []).length
    if (hits >= OVERWRITE_GUARD.minStubHits) {
        return (
            `BLOCKED: ${label} contains ${hits} function/method bodies written as literal ` +
            `"{ ... }" instead of real code — that would delete the actual implementation.`
        )
    }
    return null
}
export function stripCodeFence(text) {
    if (!text) return text
    const trimmed = text.trim()
    const match = trimmed.match(/^```[a-zA-Z0-9_+-]*\n([\s\S]*?)\n?```$/)
    return match ? match[1] : trimmed
}
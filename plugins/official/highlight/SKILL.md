---
name: highlight
description: Visual outlining helpers that highlight matching elements and clear applied outlines.
when_to_use: ["Visually identifying matched elements before interaction", "Debugging selectors on complex pages", "Clearing temporary visual outlines after inspection"]
helper_prefix: hl
helpers: ["hl__highlight", "hl__clearHighlights"]
helper_aliases: ["highlight", "clearHighlights"]
tools: []
---

## hl__highlight(selector, color?)
Visually highlight matching elements with a colored outline. Default color: red.
Returns the number of elements highlighted.

Example: `await hl__highlight('button.submit', 'blue')`

## hl__clearHighlights()
Remove all outlines added by `hl__highlight()`. Returns count of elements cleared.

Backward-compatible aliases:
- `highlight()` -> `hl__highlight()`
- `clearHighlights()` -> `hl__clearHighlights()`

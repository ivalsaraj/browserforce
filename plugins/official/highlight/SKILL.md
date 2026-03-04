---
name: highlight
description: Visual outlining helpers that highlight matching elements and clear applied outlines.
when_to_use: ["Visually identifying matched elements before interaction", "Debugging selectors on complex pages", "Clearing temporary visual outlines after inspection"]
helpers: ["highlight", "clearHighlights"]
tools: []
---

## highlight(selector, color?)
Visually highlight matching elements with a colored outline. Default color: red.
Returns the number of elements highlighted.

Example: `await highlight('button.submit', 'blue')`

## clearHighlights()
Remove all outlines added by highlight(). Returns count of elements cleared.

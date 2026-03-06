const helpers = {
  hl__highlight: async (page, ctx, state, selector, color = 'red') => {
    if (!page) throw new Error('hl__highlight() requires an active page');
    return page.evaluate(({ selector, color }) => {
      const els = [...document.querySelectorAll(selector)];
      for (const el of els) el.style.outline = `3px solid ${color}`;
      return els.length;
    }, { selector, color });
  },
  hl__clearHighlights: async (page, ctx, state) => {
    if (!page) throw new Error('hl__clearHighlights() requires an active page');
    return page.evaluate(() => {
      const els = [...document.querySelectorAll('[style*="outline"]')];
      for (const el of els) el.style.outline = '';
      return els.length;
    });
  },
};

// Backward-compatible aliases.
helpers.highlight = helpers.hl__highlight;
helpers.clearHighlights = helpers.hl__clearHighlights;

export default {
  name: 'highlight',
  description: 'Highlight elements with CSS outline',
  version: '1.0.0',
  helpers,
};

export const name = 'highlight';
export const description = 'Highlight elements with CSS outline';
export const version = '1.0.0';
export const helpers = {
  highlight: async (page, ctx, state, selector, color = 'red') => {
    if (!page) throw new Error('highlight() requires an active page');
    return page.evaluate(({ selector, color }) => {
      const els = [...document.querySelectorAll(selector)];
      for (const el of els) el.style.outline = `3px solid ${color}`;
      return els.length;
    }, { selector, color });
  },
  clearHighlights: async (page, ctx, state) => {
    if (!page) throw new Error('clearHighlights() requires an active page');
    return page.evaluate(() => {
      const els = [...document.querySelectorAll('[style*="outline"]')];
      for (const el of els) el.style.outline = '';
      return els.length;
    });
  },
};

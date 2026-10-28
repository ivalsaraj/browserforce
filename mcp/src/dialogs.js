const MAX_DIALOG_RECORDS = 100;
const MAX_DIALOG_MESSAGE_LENGTH = 240;
const statesByContext = new WeakMap();

export function createDialogState() {
  const pages = new WeakSet();
  const armedByPage = new Map();
  const records = [];
  const notices = [];

  function clearArm(page, arm) {
    if (armedByPage.get(page) !== arm) return;
    armedByPage.delete(page);
    arm.signal?.removeEventListener('abort', arm.cancel);
  }

  function setupPage(page) {
    if (!page?.on || pages.has(page)) return;
    pages.add(page);
    page.on('close', () => {
      const arm = armedByPage.get(page);
      if (arm) clearArm(page, arm);
    });
    page.on('dialog', async (dialog) => {
      const record = {
        type: dialog.type(), message: dialog.message(), defaultValue: dialog.defaultValue(),
        url: page.url(), at: new Date().toISOString(),
      };
      records.push(record);
      if (records.length > MAX_DIALOG_RECORDS) records.shift();
      let response;
      if (record.type === 'confirm' || record.type === 'prompt') {
        const arm = armedByPage.get(page);
        if (arm) {
          clearArm(page, arm);
          if (!arm.signal?.aborted) response = arm;
        }
      }
      const shouldAccept = record.type === 'alert' || record.type === 'beforeunload' || response?.accept === true;
      try {
        if (shouldAccept) await dialog.accept(response?.promptText);
        else await dialog.dismiss();
        record.action = shouldAccept ? 'accepted' : 'dismissed';
      } catch (error) {
        record.action = 'failed';
        record.error = error.message || String(error);
      }
      notices.push({ ...record });
      if (notices.length > MAX_DIALOG_RECORDS) notices.shift();
    });
  }

  return {
    setupPage,
    armDialog(page, options, signal) {
      if (!options || typeof options.accept !== 'boolean') throw new Error('armDialog requires { accept: boolean, promptText?: string }');
      if (options.promptText !== undefined && typeof options.promptText !== 'string') throw new Error('armDialog promptText must be a string');
      signal?.throwIfAborted();
      setupPage(page);
      const previous = armedByPage.get(page);
      if (previous) clearArm(page, previous);
      const arm = { accept: options.accept, promptText: options.promptText, signal };
      arm.cancel = () => clearArm(page, arm);
      armedByPage.set(page, arm);
      signal?.addEventListener('abort', arm.cancel, { once: true });
      return { armed: true };
    },
    releaseRun(signal) {
      for (const [page, arm] of armedByPage) if (arm.signal === signal) clearArm(page, arm);
    },
    getDialogs: () => records.map((record) => ({ ...record })),
    takeNotices: () => notices.splice(0),
    reset() {
      for (const [page, arm] of armedByPage) clearArm(page, arm);
      records.length = 0;
      notices.length = 0;
    },
  };
}

export function installDialogState(context, state = statesByContext.get(context) || createDialogState()) {
  if (!context || (typeof context !== 'object' && typeof context !== 'function')) return state;
  if (statesByContext.get(context) !== state) {
    statesByContext.set(context, state);
    context.on?.('page', state.setupPage);
  }
  if (typeof context.on === 'function') {
    for (const page of context.pages?.() || []) state.setupPage(page);
  }
  return state;
}

export function withDialogNotices(result, dialogs = []) {
  if (!dialogs.length) return result;
  if (result?._bf_type === 'dialog_result') return { ...result, dialogs: [...result.dialogs, ...dialogs] };
  return { _bf_type: 'dialog_result', result, dialogs };
}

export function formatDialogNotices(dialogs) {
  return dialogs.map((dialog) => {
    const message = dialog.message.length > MAX_DIALOG_MESSAGE_LENGTH
      ? `${dialog.message.slice(0, MAX_DIALOG_MESSAGE_LENGTH)}…` : dialog.message;
    const action = dialog.action === 'failed' ? `could not be handled: ${dialog.error}` : `was ${dialog.action}`;
    const hint = dialog.action === 'dismissed' && (dialog.type === 'confirm' || dialog.type === 'prompt')
      ? ' — call armDialog({accept:true}) before the action in the same exec to accept it.' : '';
    return `⚠️ Dialog (${dialog.type}) ${JSON.stringify(message)} ${action}${hint}`;
  }).join('\n');
}

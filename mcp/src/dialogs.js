import { AsyncLocalStorage } from 'node:async_hooks';

const MAX_DIALOG_RECORDS = 100;
const MAX_DIALOG_MESSAGE_LENGTH = 240;
const statesByContext = new WeakMap();

export function createDialogState() {
  const pages = new WeakSet();
  const armedByPage = new Map();
  const runs = new Map();
  const runScope = new AsyncLocalStorage();
  const contexts = new WeakSet();
  const connections = new WeakSet();
  let drivenPages = new WeakSet();
  const pendingByPage = new Map();
  const records = [];
  const notices = [];

  function clearArm(page, arm) {
    if (armedByPage.get(page) !== arm) return;
    armedByPage.delete(page);
    arm.signal?.removeEventListener('abort', arm.cancel);
  }

  function isActive(run) {
    return run && runs.get(run.signal) === run && !run.signal.aborted;
  }

  function ownsPage(run, page) {
    return isActive(run) && (run.pages.has(page) || run.activePage?.() === page);
  }

  async function handleDialog(page, dialog, useArm = true) {
    const record = {
      type: dialog.type(), message: dialog.message(), defaultValue: dialog.defaultValue(),
      url: page.url(), at: new Date().toISOString(),
    };
    records.push(record);
    if (records.length > MAX_DIALOG_RECORDS) records.shift();
    let response;
    if (useArm && (record.type === 'confirm' || record.type === 'prompt')) {
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
  }

  function drivePage(run, page) {
    if (!page || !isActive(run)) return;
    run.pages.add(page);
    drivenPages.add(page);
    const dialog = pendingByPage.get(page);
    if (dialog) {
      pendingByPage.delete(page);
      // A response armed in this run must not answer a dialog from an earlier run.
      return handleDialog(page, dialog, false);
    }
  }

  function setupPage(page) {
    if (!page?.on || pages.has(page)) return;
    pages.add(page);
    page.on('close', () => {
      pendingByPage.delete(page);
      const arm = armedByPage.get(page);
      if (arm) clearArm(page, arm);
      for (const run of runs.values()) run.pages.delete(page);
    });
    page.on('dialog', (dialog) => {
      for (const run of runs.values()) {
        if (ownsPage(run, page)) {
          drivenPages.add(page);
          return handleDialog(page, dialog);
        }
      }
      // Keep the listener even for foreign pages: removing it makes Playwright dismiss.
      if (drivenPages.has(page)) {
        pendingByPage.set(page, dialog);
        if (pendingByPage.size > MAX_DIALOG_RECORDS) pendingByPage.delete(pendingByPage.keys().next().value);
      }
    });
  }

  function setupContext(context) {
    if (contexts.has(context)) return;
    contexts.add(context);
    context.on?.('page', setupPage);
    if (typeof context.newPage === 'function') {
      const newPage = context.newPage;
      context.newPage = async function (...args) {
        const run = runScope.getStore();
        const page = await newPage.apply(this, args);
        setupPage(page);
        await drivePage(run, page);
        return page;
      };
    }
    const connection = context._connection;
    if (!connection || connections.has(connection)) return;
    connections.add(connection);
    const send = connection.sendMessageToServer;
    // Playwright 1.60 routes raw Page, Frame/Locator, and input APIs here. Observe
    // before sending, without proxying identity-sensitive Page/Context handles.
    connection.sendMessageToServer = async function (object, ...args) {
      const page = object._type === 'Page' ? object : object._page || object._frame?._page;
      if (pages.has(page) && object._type !== 'Dialog' && args[0] !== 'updateSubscription') {
        await drivePage(runScope.getStore(), page);
      }
      return send.call(this, object, ...args);
    };
  }

  return {
    setupPage,
    setupContext,
    async withRun(signal, { page, activePage }, callback) {
      signal.throwIfAborted();
      const run = { signal, pages: new Set(), activePage };
      runs.set(signal, run);
      const cancel = () => this.releaseRun(signal);
      signal.addEventListener('abort', cancel, { once: true });
      try {
        return await runScope.run(run, async () => {
          await drivePage(run, page);
          await drivePage(run, activePage?.());
          signal.throwIfAborted();
          return callback();
        });
      } finally {
        signal.removeEventListener('abort', cancel);
        this.releaseRun(signal);
      }
    },
    armDialog(page, options, signal) {
      if (!options || typeof options.accept !== 'boolean') throw new Error('armDialog requires { accept: boolean, promptText?: string, page?: Page }');
      if (options.promptText !== undefined && typeof options.promptText !== 'string') throw new Error('armDialog promptText must be a string');
      signal?.throwIfAborted();
      if (!page || typeof page.on !== 'function' || typeof page.isClosed !== 'function' || page.isClosed()) throw new Error('armDialog page must be an open Page');
      setupPage(page);
      const run = runs.get(signal);
      if (!isActive(run)) throw new Error('armDialog requires an active exec');
      run.pages.add(page);
      drivenPages.add(page);
      const previous = armedByPage.get(page);
      if (previous) clearArm(page, previous);
      const arm = { accept: options.accept, promptText: options.promptText, signal };
      arm.cancel = () => clearArm(page, arm);
      armedByPage.set(page, arm);
      signal?.addEventListener('abort', arm.cancel, { once: true });
      return { armed: true };
    },
    releaseRun(signal) {
      runs.delete(signal);
      for (const [page, arm] of armedByPage) if (arm.signal === signal) clearArm(page, arm);
    },
    getDialogs: () => records.map((record) => ({ ...record })),
    takeNotices: () => notices.splice(0),
    clearPending: () => pendingByPage.clear(),
    reset() {
      runs.clear();
      pendingByPage.clear();
      drivenPages = new WeakSet();
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
    state.setupContext(context);
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
      ? ' — call armDialog({accept:true, page}) before the action in the same exec to accept it (omit page for the active page).' : '';
    return `⚠️ Dialog (${dialog.type}) ${JSON.stringify(message)} ${action}${hint}`;
  }).join('\n');
}

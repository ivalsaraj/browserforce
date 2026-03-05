import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

const js = fs.readFileSync('extension/agent-panel.js', 'utf8');

test('sendMessage validates run creation response status', () => {
  assert.match(js, /async function sendMessage[\s\S]*if \(!res\.ok\)/);
  assert.match(js, /Failed to send message/);
  assert.match(js, /messages: existing/);
});

test('submit handler preserves draft on send failure', () => {
  assert.match(js, /chatFormEl\.addEventListener\('submit'/);
  assert.match(js, /try\s*\{\s*await sendMessage\(text\);[\s\S]*chatInputEl\.value = '';/);
  assert.match(js, /catch\s*\(\w+\)\s*\{[\s\S]*chatInputEl\.value = text;/);
});

test('sidepanel auto-attaches current tab and sends browserContext with runs', () => {
  assert.match(js, /async function ensureCurrentTabAttached\(\)/);
  assert.match(js, /runtimeMessage\(\{\s*type:\s*'attachCurrentTab'\s*\}\)/);
  assert.match(js, /runtimeMessage\(\{\s*type:\s*'getStatus'\s*\}\)/);
  assert.match(js, /chrome\.tabs\.onActivated\.addListener/);
  assert.match(js, /attachCurrentTabBtn\.addEventListener\('click'/);
  assert.match(js, /await ensureCurrentTabAttached\(\);/);
  assert.match(js, /const browserContext = await getActiveTabContext\(\);/);
  assert.match(js, /JSON\.stringify\(\{\s*sessionId,\s*message:\s*text,\s*browserContext\s*\}\)/);
});

test('enter key submits composer and shift+enter keeps newline', () => {
  assert.match(js, /chatInputEl\.addEventListener\('keydown'/);
  assert.match(js, /if\s*\(\s*event\.key\s*!==\s*'Enter'\s*\|\|\s*event\.shiftKey\s*\)\s*return;/);
  assert.match(js, /event\.preventDefault\(\);/);
  assert.match(js, /chatFormEl\.requestSubmit\(\);/);
});

test('session labels fall back to session id when title is default', () => {
  assert.match(js, /function isDefaultSessionTitle\(title\)/);
  assert.match(js, /new session/);
  assert.match(js, /new chat/);
  assert.match(js, /function formatSessionDisplayName\(session\)/);
  assert.match(js, /session\.sessionId/);
});

test('session popover supports inline rename and saves via session patch endpoint', () => {
  assert.match(js, /data-session-edit-btn/);
  assert.match(js, /data-session-edit-form/);
  assert.match(js, /async function updateSessionTitle/);
  assert.match(js, /\/v1\/sessions\/\$\{encodeURIComponent\(sessionId\)\}/);
  assert.match(js, /method:\s*'PATCH'/);
  assert.match(js, /JSON\.stringify\(\{\s*title\s*:\s*title/);
});

test('session popover renders per-session timestamp metadata', () => {
  assert.match(js, /function formatSessionTimestamp/);
  assert.match(js, /updatedAt|createdAt/);
  assert.match(js, /toLocaleString/);
});

test('in-flight thinking state keeps inline timeline visible above the thinking bubble', () => {
  assert.match(js, /if \(run && !run\.done\)/);
  assert.match(js, /function renderRunTimeline\(run, fallbackText = ''\)/);
  assert.match(js, /renderRunTimeline\(run, run\.text \|\| ''\)/);
  assert.match(js, /class="thinking-bubble"/);
});

test('assistant transcript prefers ordered run timeline over grouped run steps', () => {
  assert.match(js, /function normalizeRunTimeline\(run, fallbackText = ''\)/);
  assert.match(js, /if \(Array\.isArray\(run\.timeline\) && run\.timeline\.length > 0\)/);
  assert.match(js, /const timelineHtml = renderRunTimeline\(messageRun, msg\.text \|\| ''\)/);
});

test('assistant transcript renders message bodies with markdown block renderer', () => {
  assert.match(js, /renderMarkdownContent/);
  assert.match(js, /function renderContent\(value\)\s*\{\s*return renderMarkdownContent\(value\);\s*\}/);
  assert.match(js, /<div class="bubble-assistant">\$\{renderContent\(entry\.text \|\| ''\)\}<\/div>/);
});

test('local screenshot markdown images hydrate through authenticated chatd fetch', () => {
  assert.match(js, /function loadLocalImageBlobUrl\(localPath\)/);
  assert.match(js, /\/v1\/local-file\?path=/);
  assert.match(js, /authorization:\s*`Bearer \$\{state\.auth\.token\}`/);
  assert.match(js, /URL\.createObjectURL\(blob\)/);
  assert.match(js, /function hydrateLocalImagePreviews\(\)/);
  assert.match(js, /img\.inline-local-image\[data-local-path\]/);
  assert.match(js, /hydrateLocalImagePreviews\(\);/);
});

test('context usage renderer hides element when unavailable and only shows formatted values', () => {
  assert.match(js, /function renderContextUsageChip\(\)/);
  assert.match(js, /latestUsageBySession/);
  assert.match(js, /const note = formatted \? `Context: \$\{formatted\}` : '';/);
  assert.match(js, /contextUsageEl\.classList\.toggle\('hidden', !note\)/);
  assert.match(js, /contextUsageEl\.textContent = note/);
  assert.doesNotMatch(js, /Context:\s*unavailable/);
});

test('init opens smoothly by starting tab attach asynchronously', () => {
  assert.match(js, /function startInitialTabAttach\(\)/);
  assert.match(js, /async function initializePanel\(\)[\s\S]*startInitialTabAttach\(\);/);
  const initMatch = js.match(/\(async function init\(\)[\s\S]*?\n}\)\(\);/);
  assert.ok(initMatch, 'init block should be present');
  const initBlock = initMatch[0];
  assert.doesNotMatch(initBlock, /await ensureCurrentTabAttached\(\);/);
});

test('popup open-agent request can force a fresh session on panel init', () => {
  assert.match(js, /BROWSERFORCE_AGENT_OPEN_REQUEST_KEY/);
  assert.match(js, /function normalizeAgentOpenRequest\(/);
  assert.match(js, /async function consumePendingAgentOpenRequest\(/);
  assert.match(js, /async function initializePanel\(\)[\s\S]*consumePendingAgentOpenRequest\(\)/);
  assert.match(js, /if \(shouldStartFreshSession \|\| !state\.value\.activeSessionId\)\s*\{\s*await createSession\(\);/);
});

test('panel watches open-agent request changes and starts a fresh session when already open', () => {
  assert.match(js, /function bindAgentOpenRequestWatcher\(/);
  assert.match(js, /chrome\.storage\.onChanged\.addListener/);
  assert.match(js, /changes\?\.\[BROWSERFORCE_AGENT_OPEN_REQUEST_KEY\]/);
  assert.match(js, /startFreshSessionFromOpenRequest\(change\.newValue\)/);
  assert.match(js, /if \(!state\.auth\)\s*\{[\s\S]*state\.pendingAgentOpenRequest = request;/);
});

test('tab-attach banner shows progress during initial auto-attach and suppresses not-connected state', () => {
  assert.match(js, /function getTabAttachInProgressState\(\)/);
  assert.match(js, /text:\s*'Currently attaching active tab\.\.\.'/);
  assert.match(js, /busy:\s*true/);
  assert.match(js, /async function refreshTabAttachBanner\(\)[\s\S]*getTabAttachInProgressState\(\)/);
  assert.match(js, /setTabAttachBannerState\(inProgressState\);/);
  assert.match(js, /function startInitialTabAttach\(\)[\s\S]*setTabAttachBannerState\(getTabAttachInProgressState\(\) \|\| undefined\);/);
});

test('initial tab attach waits 2 seconds before attaching', () => {
  const fnMatch = js.match(/function startInitialTabAttach\(\)[\s\S]*?\n}\n\nasync function getActiveTabContext/);
  assert.ok(fnMatch, 'startInitialTabAttach function block should be present');
  const fnBlock = fnMatch[0];
  assert.match(fnBlock, /window\.setTimeout\(\(\)\s*=>\s*\{/);
  assert.match(fnBlock, /},\s*2000\)/);
});

test('initial async attach always refreshes banner state after completion', () => {
  const fnMatch = js.match(/function startInitialTabAttach\(\)[\s\S]*?\n}\n\nasync function getActiveTabContext/);
  assert.ok(fnMatch, 'startInitialTabAttach function block should be present');
  const fnBlock = fnMatch[0];
  assert.match(fnBlock, /\.finally\(\(\)\s*=>\s*\{[\s\S]*scheduleTabAttachRefresh\(0\);[\s\S]*\}\)/);
});

test('tool-call timeline entries render collapsed toggle rows with click-to-expand details', () => {
  assert.match(js, /data-step-key=/);
  assert.match(js, /class="step-details"/);
  assert.match(js, /closest\('button\[data-step-key\]'\)/);
});

test('text deltas are chunked into paced stream updates for visible incremental rendering', () => {
  assert.match(js, /STREAM_CHUNK_TARGET_CHARS/);
  assert.match(js, /STREAM_CHUNK_INTERVAL_MS/);
  assert.match(js, /function splitDeltaForDisplayStreaming\(delta\)/);
  assert.match(js, /state\.streamEventQueue/);
  assert.match(js, /flushStreamEventsForRun\(evt\.sessionId, evt\.runId\)/);
  assert.match(js, /scheduleStreamEventPump\(\)/);
});

test('reasoning titles render strategy icon and fixed-height commentary body blocks', () => {
  assert.match(js, /function classifyReasoningTitleIcon\(label\)/);
  assert.match(js, /function renderReasoningTitleIcon\(iconName/);
  assert.match(js, /function collectReasoningBodyText\(timeline, startIndex\)/);
  assert.match(js, /reasoning-step/);
  assert.match(js, /class="reasoning-body/);
  assert.match(js, /data-reasoning-streaming=/);
});

test('timeline normalization skips derived commentary heading when a reasoning step already exists above the text', () => {
  assert.match(js, /const previousSource = source\[index - 1\]/);
  assert.match(js, /previousSource\?\.type === 'step'/);
  assert.match(js, /String\(previousSource\.kind \|\| ''\)\.toLowerCase\(\) === 'reasoning'/);
});

test('done tool-call icon renders animated svg check markup', () => {
  assert.match(js, /function renderRunStepIcon\(icon\)/);
  assert.match(js, /run-step-icon-done-svg/);
  assert.match(js, /run-step-icon-done-ring/);
  assert.match(js, /run-step-icon-done-check/);
});

test('composer toggles single-line and multiline visual state from textarea height', () => {
  assert.match(js, /const composerBoxEl = chatFormEl\.querySelector\('\.composer-box'\)/);
  assert.match(js, /function syncComposerLayoutState\(\)/);
  assert.match(js, /composerBoxEl\.classList\.toggle\('is-multiline', isMultiline\)/);
  assert.match(js, /autoResizeInput\(\);[\s\S]*syncComposerLayoutState\(\);/);
});

test('send and stop buttons are mutually exclusive based on run state', () => {
  assert.match(js, /composerBoxEl\.classList\.toggle\('is-thinking', enabled && runInProgress\)/);
  assert.match(js, /stopRunBtn\.hidden\s*=\s*!runInProgress/);
  assert.match(js, /sendBtn\.hidden\s*=\s*runInProgress/);
});

test('stale run pointer is reconciled from loaded messages so stop does not stay visible forever', () => {
  assert.match(js, /function reconcileSessionRunState\(sessionId\)/);
  assert.match(js, /if \(!run \|\| run\.done\)/);
  assert.match(js, /state\.currentRunBySession = clearSessionRunId\(state\.currentRunBySession, sessionId, runId\)/);
  assert.match(js, /async function loadMessages\(sessionId\)[\s\S]*reconcileSessionRunState\(sessionId\)/);
});

test('init maps relay/chatd boot failures into explicit startup issues', () => {
  assert.match(js, /function normalizeStartupError\(code = '', fallbackMessage = 'Unable to connect to BrowserForce Agent'\)/);
  assert.match(js, /agent_not_running/);
  assert.match(js, /extension_not_connected/);
  assert.match(js, /relay_unreachable/);
  assert.match(js, /browserforce agent start/);
  assert.match(js, /browserforce serve/);
  assert.match(js, /state\.startupIssue = normalizeStartupError\(error\?\.code, error\?\.message\)/);
});

test('chatd-url auth bootstrap reports specific failure codes before generic daemon unavailable', () => {
  assert.match(js, /async function loadAuth\(\)/);
  assert.match(js, /if \(res\.status === 404 && relayError\.includes\('chatd not running'\)\)/);
  assert.match(js, /if \(res\.status === 503 && relayError\.includes\('extension not connected'\)\)/);
  assert.match(js, /error\.code = 'daemon_unavailable'/);
});

test('collapsed BrowserForce execute rows infer helper calls and render branch preview', () => {
  assert.match(js, /function extractExecuteHelperCalls\(/);
  assert.match(js, /function renderExecuteHelperTreePreview\(/);
  assert.match(js, /isBrowserForceExecuteStep/);
  assert.match(js, /step-branch-preview/);
  assert.match(js, /class="step-branch-node"/);
  assert.match(js, /class="step-branch-call"/);
});

test('startup error card supports retry and refresh connection actions', () => {
  assert.match(js, /function refreshExtensionConnection\(/);
  assert.match(js, /function retryStartup\(/);
  assert.match(js, /data-startup-action=/);
  assert.match(js, /key:\s*'retry'/);
  assert.match(js, /key:\s*'refresh-connection'/);
  assert.match(js, /msgAction === 'retry'/);
  assert.match(js, /msgAction === 'refresh-connection'/);
  assert.match(js, /runtimeMessage\(\{\s*type:\s*'updateRelayUrl'/);
});

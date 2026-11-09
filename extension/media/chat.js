(function(){
  const vscode = acquireVsCodeApi();
  const messages = [];
  let nextMessageId = 0;

  const messagesEl = document.getElementById('messages');
  const recipientEl = document.getElementById('recipient');
  const inputEl = document.getElementById('input');
  const sendBtn = document.getElementById('send');
  const statusEl = document.getElementById('connection-status');
  const emptyStateEl = document.getElementById('empty-state');
  const copyKeyBtn = document.getElementById('copy-key');
  const connectionNoticeEl = document.getElementById('connection-notice');
  const connectionNoticeTextEl = document.getElementById('connection-notice-text');
  const retryBtn = document.getElementById('retry-connection');
  const errorNoticeEl = document.getElementById('error-notice');
  const errorNoticeTextEl = document.getElementById('error-notice-text');
  const dismissErrorBtn = document.getElementById('dismiss-error');

  function statusLabel(status) {
    return status === 'sent' ? 'Sent' : status === 'failed' ? 'Failed' : 'Sending';
  }

  function createMessageNode(m) {
    const wrap = document.createElement('div');
    wrap.className = 'message' + (m.author === 'You' ? ' you' : '');
    wrap.dataset.id = m.id;

    const meta = document.createElement('div');
    meta.className = 'meta';
    const statusHtml = m.author === 'You'
      ? '<span class="msg-status" data-status="' + escapeHtml(m.status || 'pending') + '" title="' + escapeHtml(m.reason || statusLabel(m.status)) + '">' + statusLabel(m.status) + '</span>'
      : '';
    meta.innerHTML = '<span class="author">' + escapeHtml(m.author) + '</span>'
      + '<span class="time">' + escapeHtml(m.time) + '</span>'
      + statusHtml;

    const body = document.createElement('div');
    body.className = 'body';
    body.textContent = m.text;

    wrap.appendChild(meta);
    wrap.appendChild(body);
    return wrap;
  }

  function render() {
    if (!messagesEl) return;
    if (emptyStateEl) emptyStateEl.hidden = messages.length > 0;
    messagesEl.innerHTML = '';
    messages.forEach(m => messagesEl.appendChild(createMessageNode(m)));
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  /** Update just the status indicator of a single message node. */
  function updateMessageStatus(id, status, reason) {
    const message = messages.find(item => item.id === id && item.author === 'You');
    if (message) { message.status = status; message.reason = reason; }
    if (!messagesEl) return;
    const indicator = messagesEl.querySelector('[data-id="' + id + '"] .msg-status');
    if (indicator) { indicator.dataset.status = status; indicator.title = reason || statusLabel(status); indicator.textContent = statusLabel(status); }
  }

  function showError(message) {
    if (!errorNoticeEl || !errorNoticeTextEl) return;
    errorNoticeTextEl.textContent = message;
    errorNoticeEl.hidden = false;
  }

  function updateConnectionState(state) {
    if (!statusEl) return;
    statusEl.textContent = state;
    statusEl.dataset.state = state;
    if (connectionNoticeEl) connectionNoticeEl.hidden = state !== 'error' && state !== 'disconnected';
    if (connectionNoticeTextEl) connectionNoticeTextEl.textContent = state === 'error' ? 'Could not connect to the relay.' : 'Not connected to the relay.';
    if (retryBtn) retryBtn.textContent = state === 'error' ? 'Retry' : 'Connect';
  }

  // ---- Receive messages from the extension host ----
  window.addEventListener('message', (event) => {
    const msg = event.data;
    switch (msg.command) {
      case 'messageAck':
        updateMessageStatus(msg.id, msg.status, msg.reason);
        if (msg.status === 'failed' && msg.reason) showError(msg.reason);
        break;
      case 'receiveMessage':
        messages.push(msg.message);
        render();
        break;
      case 'connectionState':
        updateConnectionState(msg.state);
        break;
      case 'errorNotice':
        showError(msg.message);
        break;
      case 'publicKeyCopied':
        if (copyKeyBtn) {
          copyKeyBtn.textContent = 'Copied';
          setTimeout(() => { copyKeyBtn.textContent = 'Copy key'; }, 2000);
        }
        break;
    }
  });

  // ---- Send path ----
  sendBtn.addEventListener('click', () => {
    const text = (inputEl.value || '').trim();
    const to = (recipientEl.value || '').trim();
    if (!text) return;
    if (!to) { showError('Enter the recipient\'s public key.'); return; }
    const msg = {
      id: Date.now().toString() + '-' + nextMessageId++,
      author: 'You',
      text,
      time: new Date().toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'}),
      status: 'pending'
    };
    messages.push(msg);
    render();
    inputEl.value = '';
    vscode.postMessage({ command: 'sendMessage', text: msg.text, id: msg.id, to });
  });

  if (copyKeyBtn) copyKeyBtn.addEventListener('click', () => vscode.postMessage({ command: 'copyPublicKey' }));
  if (retryBtn) retryBtn.addEventListener('click', () => vscode.postMessage({ command: 'retryConnection' }));
  if (dismissErrorBtn) dismissErrorBtn.addEventListener('click', () => { errorNoticeEl.hidden = true; });

  inputEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendBtn.click(); });

  function escapeHtml(s){ return String(s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":"&#39;"})[c]); }

  render();
  vscode.postMessage({ command: 'webviewReady' });
})();

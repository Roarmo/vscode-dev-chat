(function(){
  const vscode = acquireVsCodeApi();
  const messages = [];

  const messagesEl = document.getElementById('messages');
  const recipientEl = document.getElementById('recipient');
  const inputEl = document.getElementById('input');
  const sendBtn = document.getElementById('send');
  const statusEl = document.getElementById('connection-status');
  const emptyStateEl = document.getElementById('empty-state');
  const copyKeyBtn = document.getElementById('copy-key');

  function createMessageNode(m) {
    const wrap = document.createElement('div');
    wrap.className = 'message' + (m.author === 'You' ? ' you' : '');
    wrap.dataset.id = m.id;

    const meta = document.createElement('div');
    meta.className = 'meta';
    const statusHtml = m.author === 'You'
      ? '<span class="msg-status" data-status="' + escapeHtml(m.status || 'pending') + '" title="' + escapeHtml(m.status || 'pending') + '"></span>'
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
  function updateMessageStatus(id, status) {
    const message = messages.find(item => item.id === id && item.author === 'You');
    if (message) message.status = status;
    if (!messagesEl) return;
    const indicator = messagesEl.querySelector('[data-id="' + id + '"] .msg-status');
    if (indicator) { indicator.dataset.status = status; indicator.title = status; }
  }

  function updateConnectionState(state) {
    if (!statusEl) return;
    statusEl.textContent = state;
    statusEl.dataset.state = state;
  }

  // ---- Receive messages from the extension host ----
  window.addEventListener('message', (event) => {
    const msg = event.data;
    switch (msg.command) {
      case 'messageAck':
        updateMessageStatus(msg.id, msg.status);
        break;
      case 'receiveMessage':
        messages.push(msg.message);
        render();
        break;
      case 'connectionState':
        updateConnectionState(msg.state);
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
    if (!text || !to) return;
    const msg = {
      id: Date.now().toString(),
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

  inputEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendBtn.click(); });

  function escapeHtml(s){ return String(s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":"&#39;"})[c]); }

  render();
})();

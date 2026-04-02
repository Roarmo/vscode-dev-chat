(function(){
  const vscode = acquireVsCodeApi();
  const messages = [
    { id: '1', author: 'Alice', text: 'Hello from Alice', time: '10:00' },
    { id: '2', author: 'Bob', text: 'Hi Alice, this is a mock message', time: '10:01' }
  ];

  const messagesEl = document.getElementById('messages');
  const inputEl = document.getElementById('input');
  const sendBtn = document.getElementById('send');

  function createMessageNode(m) {
    const wrap = document.createElement('div');
    wrap.className = 'message' + (m.author === 'You' ? ' you' : '');

    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.innerHTML = '<span class="author">' + escapeHtml(m.author) + '</span>' + '<span class="time">' + escapeHtml(m.time) + '</span>';

    const body = document.createElement('div');
    body.className = 'body';
    body.textContent = m.text;

    wrap.appendChild(meta);
    wrap.appendChild(body);
    return wrap;
  }

  function render() {
    if (!messagesEl) return;
    messagesEl.innerHTML = '';
    messages.forEach(m => messagesEl.appendChild(createMessageNode(m)));
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  sendBtn.addEventListener('click', () => {
    const text = (inputEl.value || '').trim();
    if (!text) return;
    const msg = { id: Date.now().toString(), author: 'You', text, time: new Date().toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'}) };
    messages.push(msg);
    render();
    inputEl.value = '';
    vscode.postMessage({ command: 'sendMessage', text: msg.text, id: msg.id });
  });

  inputEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendBtn.click(); });

  // Simple HTML-escape to be safe
  function escapeHtml(s){ return String(s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":"&#39;"})[c]); }

  render();
})();

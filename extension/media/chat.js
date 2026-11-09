(function(){
  const vscode = acquireVsCodeApi();
  let contacts = [];
  let conversations = [];
  let messages = [];
  let activePublicKey = null;
  let nextMessageId = 0;

  const conversationListEl = document.getElementById('conversation-list');
  const conversationListEmptyEl = document.getElementById('conversation-list-empty');
  const unreadTotalEl = document.getElementById('unread-total');
  const conversationTitleEl = document.getElementById('conversation-title');
  const conversationKeyLabelEl = document.getElementById('conversation-key-label');
  const messagesEl = document.getElementById('messages');
  const inputEl = document.getElementById('input');
  const sendBtn = document.getElementById('send');
  const statusEl = document.getElementById('connection-status');
  const emptyStateEl = document.getElementById('empty-state');
  const copyKeyBtn = document.getElementById('copy-key');
  const contactSelectEl = document.getElementById('contact-select');
  const contactNameEl = document.getElementById('contact-name');
  const contactPublicKeyEl = document.getElementById('contact-public-key');
  const contactFingerprintRowEl = document.getElementById('contact-fingerprint-row');
  const contactFingerprintEl = document.getElementById('contact-fingerprint');
  const saveContactBtn = document.getElementById('save-contact');
  const removeContactBtn = document.getElementById('remove-contact');
  const connectionNoticeEl = document.getElementById('connection-notice');
  const connectionNoticeTextEl = document.getElementById('connection-notice-text');
  const retryBtn = document.getElementById('retry-connection');
  const errorNoticeEl = document.getElementById('error-notice');
  const errorNoticeTextEl = document.getElementById('error-notice-text');
  const dismissErrorBtn = document.getElementById('dismiss-error');
  let selectedContactKey = null;

  function statusLabel(status) {
    if (status === 'sent') return 'Sent';
    if (status === 'failed') return 'Failed';
    if (status === 'unknown') return 'Unknown';
    return 'Sending';
  }

  function createMessageNode(message, contactName) {
    const wrap = document.createElement('div');
    wrap.className = 'message' + (message.direction === 'outgoing' ? ' you' : '');
    wrap.dataset.id = message.id;

    const meta = document.createElement('div');
    meta.className = 'meta';
    const author = document.createElement('span');
    author.className = 'author';
    author.textContent = message.direction === 'outgoing' ? 'You' : contactName;
    meta.appendChild(author);

    if (message.direction === 'incoming' && typeof message.verified === 'boolean') {
      const trust = document.createElement('span');
      trust.className = 'trust';
      trust.dataset.verified = String(message.verified);
      trust.title = 'Fingerprint: ' + (message.fingerprint || 'unknown') +
        (message.verified ? '' : '. Run "Dev Chat: Verify Contact Fingerprint" to verify.');
      trust.textContent = message.verified ? 'Verified' : 'Not verified';
      meta.appendChild(trust);
    }

    const time = document.createElement('span');
    time.className = 'time';
    time.textContent = new Date(message.sentAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    meta.appendChild(time);

    if (message.direction === 'outgoing') {
      const status = document.createElement('span');
      status.className = 'msg-status';
      status.dataset.status = message.status || 'pending';
      status.title = message.reason || statusLabel(message.status);
      status.textContent = statusLabel(message.status);
      meta.appendChild(status);
    }

    const body = document.createElement('div');
    body.className = 'body';
    body.textContent = message.text;
    wrap.appendChild(meta);
    wrap.appendChild(body);
    return wrap;
  }

  function renderConversationList() {
    conversationListEl.innerHTML = '';
    let unreadTotal = 0;
    conversations.forEach(conversation => {
      unreadTotal += conversation.unreadCount;
      const item = document.createElement('button');
      item.className = 'conversation-item';
      item.type = 'button';
      item.setAttribute('aria-current', conversation.publicKey === activePublicKey ? 'true' : 'false');
      item.addEventListener('click', () => {
        vscode.postMessage({ command: 'selectConversation', publicKey: conversation.publicKey });
      });

      const content = document.createElement('span');
      content.className = 'conversation-item-content';
      const name = document.createElement('span');
      name.className = 'conversation-item-name';
      name.textContent = conversation.name;
      const preview = document.createElement('span');
      preview.className = 'conversation-item-preview';
      preview.textContent = conversation.preview || 'No messages yet';
      content.appendChild(name);
      content.appendChild(preview);

      const unread = document.createElement('span');
      unread.className = 'unread-badge';
      unread.textContent = conversation.unreadCount > 99 ? '99+' : String(conversation.unreadCount);
      unread.hidden = conversation.unreadCount === 0;
      unread.title = conversation.unreadCount + ' unread message' + (conversation.unreadCount === 1 ? '' : 's');

      item.appendChild(content);
      item.appendChild(unread);
      conversationListEl.appendChild(item);
    });
    conversationListEmptyEl.hidden = conversations.length > 0;
    unreadTotalEl.textContent = unreadTotal ? unreadTotal + ' unread' : '';
  }

  function syncContactSelection(publicKey) {
    const contact = contacts.find(item => item.publicKey === publicKey);
    selectedContactKey = contact ? contact.publicKey : null;
    contactSelectEl.value = selectedContactKey || '';
    if (contact) {
      contactNameEl.value = contact.name;
      contactPublicKeyEl.value = contact.publicKey;
      contactFingerprintEl.textContent = contact.fingerprint;
      contactFingerprintRowEl.hidden = false;
      saveContactBtn.textContent = 'Update contact';
      removeContactBtn.disabled = false;
    } else {
      contactNameEl.value = '';
      contactPublicKeyEl.value = '';
      contactFingerprintEl.textContent = '';
      contactFingerprintRowEl.hidden = true;
      saveContactBtn.textContent = 'Add contact';
      removeContactBtn.disabled = true;
    }
  }

  function renderConversation() {
    const activeConversation = conversations.find(item => item.publicKey === activePublicKey);
    conversationTitleEl.textContent = activeConversation ? activeConversation.name : 'Select a conversation';
    conversationKeyLabelEl.textContent = activeConversation ? activeConversation.publicKey : '';
    messagesEl.innerHTML = '';
    const hasMessages = Boolean(activeConversation) && messages.length > 0;
    if (emptyStateEl) {
      emptyStateEl.hidden = hasMessages;
      emptyStateEl.querySelector('.empty-title').textContent = activeConversation
        ? 'Your conversation starts here'
        : 'Select a conversation to view messages';
      emptyStateEl.querySelector('.empty-subtitle').textContent = activeConversation
        ? 'No messages yet'
        : 'Choose a conversation from the list';
    }
    if (activeConversation) {
      messages.forEach(message => messagesEl.appendChild(createMessageNode(message, activeConversation.name)));
    }
    messagesEl.scrollTop = messagesEl.scrollHeight;
    inputEl.disabled = !activeConversation;
    sendBtn.disabled = !activeConversation;
    inputEl.placeholder = activeConversation ? 'Write a message' : 'Select a conversation to write a message';
  }

  function renderState(state) {
    if (!state || !Array.isArray(state.conversations) || !Array.isArray(state.messages)) return;
    const previousPublicKey = activePublicKey;
    conversations = state.conversations.filter(conversation =>
      conversation &&
      typeof conversation.publicKey === 'string' &&
      typeof conversation.name === 'string' &&
      typeof conversation.preview === 'string' &&
      Number.isSafeInteger(conversation.unreadCount));
    activePublicKey = typeof state.activePublicKey === 'string' &&
      conversations.some(conversation => conversation.publicKey === state.activePublicKey)
      ? state.activePublicKey
      : null;
    messages = activePublicKey
      ? state.messages.filter(message =>
        message &&
        typeof message.id === 'string' &&
        (message.direction === 'incoming' || message.direction === 'outgoing') &&
        typeof message.text === 'string' &&
        Number.isSafeInteger(message.sentAt))
      : [];
    renderConversationList();
    renderConversation();
    if (previousPublicKey !== activePublicKey) syncContactSelection(activePublicKey);
  }

  function updateContacts(message) {
    contacts = Array.isArray(message.contacts)
      ? message.contacts.filter(contact =>
        contact &&
        typeof contact.name === 'string' &&
        typeof contact.publicKey === 'string' &&
        typeof contact.fingerprint === 'string')
      : [];
    contactSelectEl.innerHTML = '<option value="">Add a new contact</option>' + contacts.map(contact =>
      '<option value="' + escapeHtml(contact.publicKey) + '">' +
      escapeHtml(contact.name) + ' · ' + escapeHtml(contact.publicKey.slice(0, 12)) +
      '</option>').join('');
    syncContactSelection(message.selectedPublicKey);
  }

  function showError(message) {
    errorNoticeTextEl.textContent = message;
    errorNoticeEl.hidden = false;
  }

  function updateConnectionState(state) {
    statusEl.textContent = state;
    statusEl.dataset.state = state;
    connectionNoticeEl.hidden = state !== 'error' && state !== 'disconnected';
    connectionNoticeTextEl.textContent = state === 'error' ? 'Could not connect to the relay.' : 'Not connected to the relay.';
    retryBtn.textContent = state === 'error' ? 'Retry' : 'Connect';
  }

  window.addEventListener('message', (event) => {
    const msg = event.data;
    switch (msg.command) {
      case 'conversationState':
        renderState(msg.state);
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
      case 'contactsUpdated':
        updateContacts(msg);
        break;
    }
  });

  sendBtn.addEventListener('click', () => {
    const text = (inputEl.value || '').trim();
    if (!text) return;
    if (!activePublicKey) {
      showError('Select a conversation before sending.');
      return;
    }
    const id = Date.now().toString() + '-' + nextMessageId++;
    vscode.postMessage({ command: 'sendMessage', id, to: activePublicKey, text });
    inputEl.value = '';
  });

  if (copyKeyBtn) copyKeyBtn.addEventListener('click', () => vscode.postMessage({ command: 'copyPublicKey' }));
  if (contactSelectEl) contactSelectEl.addEventListener('change', () => {
    const publicKey = contactSelectEl.value || null;
    syncContactSelection(publicKey);
  });
  if (saveContactBtn) saveContactBtn.addEventListener('click', () => {
    const name = (contactNameEl.value || '').trim();
    const publicKey = (contactPublicKeyEl.value || '').trim();
    if (!name || !publicKey) {
      showError('Enter a contact name and public key.');
      return;
    }
    vscode.postMessage({ command: 'saveContact', name, publicKey, currentPublicKey: selectedContactKey });
  });
  if (removeContactBtn) removeContactBtn.addEventListener('click', () => {
    if (selectedContactKey) vscode.postMessage({ command: 'removeContact', publicKey: selectedContactKey });
  });
  if (retryBtn) retryBtn.addEventListener('click', () => vscode.postMessage({ command: 'retryConnection' }));
  if (dismissErrorBtn) dismissErrorBtn.addEventListener('click', () => { errorNoticeEl.hidden = true; });
  inputEl.addEventListener('keydown', (event) => { if (event.key === 'Enter' && !event.shiftKey) sendBtn.click(); });

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (character) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    })[character]);
  }

  renderConversationList();
  renderConversation();
  vscode.postMessage({ command: 'webviewReady' });
})();

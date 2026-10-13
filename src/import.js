'use strict';

const send = (message) => new Promise((resolve, reject) => {
  chrome.runtime.sendMessage(message, (response) => {
    if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
    else if (response?.error) reject(new Error(response.error));
    else resolve(response);
  });
});

const chooseButton = document.getElementById('btn-choose');
const fileInput = document.getElementById('import-file');
const dropZone = document.getElementById('drop-zone');
const statusEl = document.getElementById('status');
const actionsEl = document.getElementById('actions');

function showStatus(message, type = '') {
  statusEl.textContent = message;
  statusEl.className = `status visible${type ? ` ${type}` : ''}`;
}

async function importFile(file) {
  if (!file) return;
  chooseButton.disabled = true;
  chooseButton.textContent = 'Importing…';
  actionsEl.classList.remove('visible');
  showStatus(`Reading ${file.name}…`);

  try {
    const payload = JSON.parse(await file.text());
    const result = await send({ type: 'IMPORT_DATA', payload });
    const channelCount = result?.channels?.length ?? 0;
    const selectedCount = result?.selectedChannelIds?.length ?? 0;
    showStatus(
      `Import complete: ${channelCount} channels restored, ${selectedCount} selected.`,
      'success'
    );
    actionsEl.classList.add('visible');
  } catch (error) {
    showStatus(error?.message || 'Could not import this backup.', 'error');
  } finally {
    fileInput.value = '';
    chooseButton.disabled = false;
    chooseButton.textContent = 'Choose backup';
  }
}

chooseButton.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => void importFile(fileInput.files?.[0]));

for (const eventName of ['dragenter', 'dragover']) {
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZone.classList.add('dragging');
  });
}
for (const eventName of ['dragleave', 'drop']) {
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZone.classList.remove('dragging');
  });
}
dropZone.addEventListener('drop', (event) => void importFile(event.dataTransfer?.files?.[0]));

document.getElementById('btn-open-feed').addEventListener('click', () => {
  location.href = chrome.runtime.getURL('src/feed.html');
});
document.getElementById('btn-close').addEventListener('click', () => {
  chrome.tabs.getCurrent((tab) => {
    if (tab?.id != null) chrome.tabs.remove(tab.id);
  });
});

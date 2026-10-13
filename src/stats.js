'use strict';

const send = (message) => new Promise((resolve, reject) => {
  chrome.runtime.sendMessage(message, (response) => {
    if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
    else if (response?.error) reject(new Error(response.error));
    else resolve(response);
  });
});

const todayEl = document.getElementById('today');
const weekEl = document.getElementById('week');
const lastSevenEl = document.getElementById('last-seven');
const daysEl = document.getElementById('days');
const limitInput = document.getElementById('limit');
const limitStatus = document.getElementById('limit-status');
const saveButton = document.getElementById('save-limit');

function formatDuration(seconds) {
  const totalMinutes = Math.floor((Number(seconds) || 0) / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function formatDay(dateText) {
  const date = new Date(`${dateText}T12:00:00`);
  return new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' }).format(date);
}

function render(stats) {
  todayEl.textContent = formatDuration(stats.todaySeconds);
  weekEl.textContent = formatDuration(stats.weekSeconds);
  lastSevenEl.textContent = formatDuration(stats.last7DaysSeconds);
  limitInput.value = stats.dailyLimitMinutes || 0;

  if (!stats.dailyLimitMinutes) {
    limitStatus.textContent = 'Time blocking is disabled.';
  } else if (stats.blocked) {
    limitStatus.textContent = `Limit reached after ${formatDuration(stats.todaySeconds)} today.`;
  } else {
    limitStatus.textContent = `${formatDuration(stats.remainingSeconds)} remaining today.`;
  }
  limitStatus.classList.toggle('blocked', Boolean(stats.blocked));

  const maximum = Math.max(1, ...stats.last7Days.map((entry) => entry.seconds));
  daysEl.innerHTML = '';
  for (const entry of stats.last7Days) {
    const row = document.createElement('div');
    row.className = 'day';
    row.innerHTML = `
      <div class="day-label"></div>
      <div class="bar"><div class="bar-fill"></div></div>
      <div class="day-time"></div>`;
    row.querySelector('.day-label').textContent = formatDay(entry.date);
    row.querySelector('.bar-fill').style.width = `${(entry.seconds / maximum) * 100}%`;
    row.querySelector('.day-time').textContent = formatDuration(entry.seconds);
    daysEl.appendChild(row);
  }
}

async function refresh() {
  try {
    const response = await send({ type: 'GET_WATCH_STATS' });
    render(response.stats);
  } catch (error) {
    limitStatus.textContent = error.message;
    limitStatus.classList.add('blocked');
  }
}

saveButton.addEventListener('click', async () => {
  saveButton.disabled = true;
  try {
    const response = await send({ type: 'SAVE_WATCH_LIMIT', minutes: limitInput.value });
    render(response.stats);
  } catch (error) {
    limitStatus.textContent = error.message;
    limitStatus.classList.add('blocked');
  } finally {
    saveButton.disabled = false;
  }
});

void refresh();
setInterval(() => void refresh(), 10 * 1000);

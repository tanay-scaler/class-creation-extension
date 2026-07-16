// =============================================
// Scaler Autofill - Popup Script
// =============================================

let csvData = [];
let csvColumns = [];
let fieldMap = {};
let isRunning = false;
let currentRowIndex = 0;

// ─── Tab Switching ────────────────────────────

document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(`tab-${tab.dataset.tab}`).classList.add('active');
    if (tab.dataset.tab === 'history') {
      renderHistoryList();
    }
  });
});

function switchTab(name) {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === `tab-${name}`));
}

// ─── CSV Parsing ──────────────────────────────

function parseCSV(text) {
  const lines = text.trim().split('\n');
  if (lines.length < 2) return { columns: [], rows: [] };

  const columns = parseCSVLine(lines[0]);
  const rows = lines.slice(1).map(line => {
    const vals = parseCSVLine(line);
    const obj = {};
    columns.forEach((col, i) => { obj[col] = (vals[i] || '').trim(); });
    return obj;
  }).filter(row => Object.values(row).some(v => v)); // remove empty rows

  return { columns, rows };
}

function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current.trim());
  return result;
}

// ─── CSV Upload ────────────────────────────────

const uploadZone = document.getElementById('uploadZone');
const csvInput = document.getElementById('csvInput');

uploadZone.addEventListener('click', () => csvInput.click());
uploadZone.addEventListener('dragover', e => { e.preventDefault(); uploadZone.classList.add('dragover'); });
uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('dragover'));
uploadZone.addEventListener('drop', e => {
  e.preventDefault();
  uploadZone.classList.remove('dragover');
  const file = e.dataTransfer.files[0];
  if (file) readFile(file);
});

csvInput.addEventListener('change', () => {
  if (csvInput.files[0]) readFile(csvInput.files[0]);
});

function readFile(file) {
  const reader = new FileReader();
  reader.onload = e => {
    const { columns, rows } = parseCSV(e.target.result);
    csvColumns = columns;
    csvData = rows;

    document.getElementById('csvFilename').textContent = file.name;
    document.getElementById('csvPreview').style.display = 'block';
    document.getElementById('statRows').textContent = rows.length;
    document.getElementById('statCols').textContent = columns.length;

    renderColumnsList();
    updateStats();
    document.getElementById('goToMapBtn').disabled = false;
    document.getElementById('startFrom').max = rows.length;

    // Save to storage
    chrome.storage.local.set({ scalerCSV: rows, scalerColumns: columns });
    addLog(`📄 Loaded ${rows.length} rows, ${columns.length} columns`, 'info');
  };
  reader.readAsText(file);
}

// ─── Column Mapping UI ────────────────────────

function renderColumnsList() {
  const list = document.getElementById('columnsList');
  if (csvColumns.length === 0) {
    list.innerHTML = '<div class="empty-state"><div class="icon">📋</div>Upload a CSV first to see columns</div>';
    return;
  }

  list.innerHTML = csvColumns.map(col => {
    const mapped = fieldMap[col];
    return `
      <div class="column-row" id="col-row-${sanitizeId(col)}">
        <div class="column-name">${col}</div>
        <div class="mapping-status ${mapped ? 'mapped' : ''}" id="status-${sanitizeId(col)}">
          ${mapped ? '✓ ' + truncate(mapped.selector, 20) : 'not mapped'}
        </div>
        <button class="map-btn ${mapped ? 'mapped' : ''}" data-col="${col}" id="mapbtn-${sanitizeId(col)}">
          ${mapped ? '✓ Re-map' : 'Map'}
        </button>
      </div>
    `;
  }).join('');

  // Bind map buttons
  list.querySelectorAll('.map-btn').forEach(btn => {
    btn.addEventListener('click', () => startMapping(btn.dataset.col));
  });
}

function sanitizeId(str) {
  return str.replace(/[^a-zA-Z0-9]/g, '_');
}

function truncate(str, len) {
  return str.length > len ? str.substring(0, len) + '…' : str;
}

function startMapping(column) {
  addLog(`🎯 Click the form field for: "${column}"`, 'info');

  chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
    const tab = tabs[0];
    if (!tab || !tab.url || !tab.url.includes('scaler.com/scm/classes/create-class')) {
      addLog('⚠️ Please open the Create Class page first!', 'warn');
      return;
    }

    chrome.tabs.sendMessage(tab.id, {
      action: 'startMapping',
      column,
      currentMap: fieldMap
    });
  });
}

// ─── Stats & State ────────────────────────────

function updateStats() {
  const mappedCount = csvColumns.filter(c => fieldMap[c]).length;
  document.getElementById('statMapped').textContent = mappedCount;
  document.getElementById('mappedCount').textContent = `${mappedCount}/${csvColumns.length}`;

  // Mapping is optional — lecture flow detects headers automatically
  // Non-lecture rows still need mapping for selector-based autofill
  document.getElementById('goToRunBtn').disabled = csvData.length === 0;
  document.getElementById('startBtn').disabled = csvData.length === 0;
}

function updateProgress(index, total) {
  const pct = total === 0 ? 0 : Math.round((index / total) * 100);
  document.getElementById('progressText').textContent = `${index} of ${total} classes`;
  document.getElementById('progressPct').textContent = `${pct}%`;
  document.getElementById('progressFill').style.width = `${pct}%`;
}

// ─── Log ──────────────────────────────────────

function addLog(message, type = 'info') {
  const box = document.getElementById('logBox');
  const line = document.createElement('div');
  line.className = `log-line ${type}`;
  const time = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  line.textContent = `[${time}] ${message}`;
  box.appendChild(line);
  box.scrollTop = box.scrollHeight;

  // Keep last 100 lines
  while (box.children.length > 100) box.removeChild(box.firstChild);
}

// ─── Run Controls ─────────────────────────────

document.getElementById('startBtn').addEventListener('click', () => {
  const startFrom = parseInt(document.getElementById('startFrom').value) || 1;
  currentRowIndex = startFrom - 1;

  const rowsToProcess = csvData.slice(currentRowIndex);
  if (rowsToProcess.length === 0) {
    addLog('⚠️ No rows to process', 'warn');
    return;
  }

  isRunning = true;
  document.getElementById('startBtn').style.display = 'none';
  document.getElementById('stopBtn').style.display = 'block';
  updateProgress(0, rowsToProcess.length);

  // Save queue state
  chrome.storage.local.set({
    scalerQueue: csvData,
    scalerQueueIndex: currentRowIndex,
    scalerFieldMap: fieldMap,
    scalerRunning: true
  });

  addLog(`▶ Starting autofill for ${rowsToProcess.length} rows from row ${startFrom}`, 'info');

  chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
    const tab = tabs[0];
    if (!tab || !tab.url || !tab.url.includes('scaler.com/scm/classes/create-class')) {
      chrome.tabs.create({ url: 'https://www.scaler.com/scm/classes/create-class' });
      addLog('🌐 Opening Create Class page...', 'info');
    } else {
      chrome.tabs.sendMessage(tab.id, {
        action: 'startAutofill',
        fieldMap,
        rows: csvData,
        startIndex: currentRowIndex
      });
    }
  });
});

document.getElementById('stopBtn').addEventListener('click', () => {
  isRunning = false;
  document.getElementById('startBtn').style.display = 'block';
  document.getElementById('stopBtn').style.display = 'none';
  chrome.storage.local.set({ scalerRunning: false });
  addLog('⏹ Stopped', 'warn');

  chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
    if (tabs[0]) chrome.tabs.sendMessage(tabs[0].id, { action: 'stopAutofill' });
  });
});

// ─── Navigation Buttons ───────────────────────

document.getElementById('openPageBtn').addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://www.scaler.com/scm/classes/create-class' });
});

document.getElementById('goToMapBtn').addEventListener('click', () => switchTab('map'));
document.getElementById('goToRunBtn').addEventListener('click', () => switchTab('run'));

document.getElementById('clearMapBtn').addEventListener('click', () => {
  fieldMap = {};
  chrome.storage.local.remove('scalerFieldMap');
  renderColumnsList();
  updateStats();
  addLog('🗑 Field map cleared', 'warn');
});

// ─── Message Listener (from content script) ───

chrome.runtime.onMessage.addListener((message) => {
  if (message.action === 'updateProgress') {
    addLog(message.message, message.type);
    if (message.type === 'error') {
      isRunning = false;
      document.getElementById('startBtn').style.display = 'block';
      document.getElementById('stopBtn').style.display = 'none';
    }
  }

  if (message.action === 'autofillStopped') {
    isRunning = false;
    document.getElementById('startBtn').style.display = 'block';
    document.getElementById('stopBtn').style.display = 'none';
    addLog('⏹ Autofill process stopped/paused.', 'warn');
  }

  if (message.action === 'fieldMapped') {
    const { column, selector } = message;
    fieldMap[column] = { selector, type: 'input' }; // type will be refined
    chrome.storage.local.set({ scalerFieldMap: fieldMap });

    // Update UI
    const statusEl = document.getElementById(`status-${sanitizeId(column)}`);
    const btnEl = document.getElementById(`mapbtn-${sanitizeId(column)}`);
    if (statusEl) { statusEl.textContent = '✓ ' + truncate(selector, 20); statusEl.className = 'mapping-status mapped'; }
    if (btnEl) { btnEl.textContent = '✓ Re-map'; btnEl.className = 'map-btn mapped'; }

    updateStats();
    addLog(`✅ "${column}" mapped to ${selector}`, 'success');
  }

  if (message.action === 'mappingComplete') {
    fieldMap = message.fieldMap;
    renderColumnsList();
    updateStats();
    addLog('✅ All mappings saved!', 'success');
  }

  if (message.action === 'rowComplete') {
    currentRowIndex++;
    updateProgress(currentRowIndex, csvData.length);
  }
});

// ─── Load saved state ─────────────────────────

chrome.storage.local.get(['scalerFieldMap', 'scalerCSV', 'scalerColumns', 'scalerQueueIndex', 'scalerRunning', 'scalerRunHistory'], data => {
  if (data.scalerFieldMap) {
    fieldMap = data.scalerFieldMap;
  }
  if (data.scalerCSV && data.scalerColumns) {
    csvData = data.scalerCSV;
    csvColumns = data.scalerColumns;
    document.getElementById('csvPreview').style.display = 'block';
    document.getElementById('statRows').textContent = csvData.length;
    document.getElementById('statCols').textContent = csvColumns.length;
    document.getElementById('goToMapBtn').disabled = false;
  }
  renderColumnsList();
  updateStats();
  renderHistoryList();

  if (data.scalerRunning && data.scalerQueueIndex !== undefined) {
    currentRowIndex = data.scalerQueueIndex;
    updateProgress(currentRowIndex, csvData.length);
    isRunning = true;
    document.getElementById('startBtn').style.display = 'none';
    document.getElementById('stopBtn').style.display = 'block';
    addLog(`▶ Running row ${currentRowIndex + 1}...`, 'info');
  }
});

// ─── History Panel Management ─────────────────

document.getElementById('clearHistoryBtn').addEventListener('click', () => {
  chrome.storage.local.remove('scalerRunHistory', () => {
    renderHistoryList();
    addLog('🗑 Run history cleared', 'warn');
  });
});

function renderHistoryList() {
  chrome.storage.local.get(['scalerRunHistory'], data => {
    const list = document.getElementById('historyList');
    const history = data.scalerRunHistory || [];
    
    if (history.length === 0) {
      list.innerHTML = '<div class="empty-state"><div class="icon">⏳</div>No past runs recorded yet.</div>';
      return;
    }
    
    list.innerHTML = history.map(run => {
      const isSuccess = run.status === 'success';
      const isFailed = run.status === 'failed';
      const statusColor = isSuccess ? '#00ff88' : (isFailed ? '#ff6b6b' : '#ffa500');
      
      return `
        <div class="column-row" style="flex-direction:column;align-items:stretch;gap:4px">
          <div style="display:flex;justify-content:space-between;align-items:center">
            <div class="column-name" style="font-size:11px;color:#888">${run.start}</div>
            <div style="color:${statusColor};font-weight:bold;text-transform:uppercase;font-size:10px">
              ${run.status}
            </div>
          </div>
          <div style="display:flex;justify-content:space-between;align-items:center;margin-top:2px">
            <span style="font-size:11px;color:#bbb">${run.logs ? run.logs.length : 0} Log lines</span>
            <button class="map-btn dl-log-btn" data-run-id="${run.id}" style="padding:2px 8px;font-size:10px">📥 Download</button>
          </div>
        </div>
      `;
    }).join('');
    
    // Bind download buttons
    list.querySelectorAll('.dl-log-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const run = history.find(r => r.id === btn.dataset.runId);
        if (run) downloadRunLogs(run);
      });
    });
  });
}

function downloadRunLogs(run) {
  const logText = run.logs.map(l => `[${l.time}] [${l.type.toUpperCase()}] ${l.message}`).join('\n');
  const blob = new Blob([logText], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `scaler_autofill_run_${run.id}.txt`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

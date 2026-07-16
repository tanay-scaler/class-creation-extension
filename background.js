// Background service worker
// Handles messaging between popup and content script

let logQueue = Promise.resolve();

function queueLogUpdate(message) {
  logQueue = logQueue.then(() => new Promise((resolve) => {
    chrome.storage.local.get(['scalerCurrentRun'], (data) => {
      const run = data.scalerCurrentRun;
      if (!run) {
        resolve();
        return;
      }
      const time = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
      run.logs.push({
        time: time,
        type: message.type || 'info',
        message: message.message
      });
      
      let finalize = false;
      if (message.message.includes('All') && message.message.includes('classes created')) {
        run.status = 'success';
        finalize = true;
      } else if (message.type === 'error') {
        run.status = 'failed';
        finalize = true;
      }
      
      if (finalize) {
        finalizeRun(run, resolve);
      } else {
        chrome.storage.local.set({ scalerCurrentRun: run }, resolve);
      }
    });
  }));
}

function finalizeRun(run, callback) {
  chrome.storage.local.get(['scalerRunHistory'], (histData) => {
    const history = histData.scalerRunHistory || [];
    if (!history.some(h => h.id === run.id)) {
      history.unshift(run);
      if (history.length > 20) history.pop();
    }
    
    chrome.storage.local.set({ 
      scalerRunHistory: history,
      scalerCurrentRun: null 
    }, () => {
      // Trigger automatic download
      try {
        const logText = run.logs.map(l => `[${l.time}] [${l.type.toUpperCase()}] ${l.message}`).join('\n');
        const dateStr = new Date().toISOString().slice(0, 10);
        chrome.downloads.download({
          url: 'data:text/plain;charset=utf-8,' + encodeURIComponent(logText),
          filename: `Scaler-Autofill-Logs/scaler_autofill_${run.status}_${dateStr}_${Date.now()}.txt`,
          conflictAction: 'uniquify',
          saveAs: false
        });
      } catch (err) {
        console.error('Failed to trigger auto download:', err);
      }
      if (callback) callback();
    });
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'startAutofill') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (tab && tab.url && tab.url.includes('scaler.com/scm/classes/create-class')) {
        chrome.tabs.sendMessage(tab.id, message, sendResponse);
      } else {
        // Open the create-class page first
        chrome.tabs.create({ url: 'https://www.scaler.com/scm/classes/create-class' }, (newTab) => {
          // Wait for page to load then send message
          chrome.tabs.onUpdated.addListener(function listener(tabId, info) {
            if (tabId === newTab.id && info.status === 'complete') {
              chrome.tabs.onUpdated.removeListener(listener);
              setTimeout(() => {
                chrome.tabs.sendMessage(newTab.id, message, sendResponse);
              }, 2000);
            }
          });
        });
      }
    });
    return true; // Keep channel open for async response
  }

  if (message.action === 'autofillStarted') {
    const currentRun = {
      id: `run_${Date.now()}`,
      start: new Date().toLocaleString(),
      status: 'running',
      logs: []
    };
    chrome.storage.local.set({ scalerCurrentRun: currentRun });
    return true;
  }

  if (message.action === 'autofillStopped' || message.action === 'stopAutofill') {
    logQueue = logQueue.then(() => new Promise((resolve) => {
      chrome.storage.local.get(['scalerCurrentRun'], (data) => {
        const run = data.scalerCurrentRun;
        if (run) {
          run.status = 'stopped';
          finalizeRun(run, resolve);
        } else {
          resolve();
        }
      });
    }));
    return true;
  }

  if (message.action === 'updateProgress') {
    // Forward progress updates to popup
    chrome.runtime.sendMessage(message);
    // Queue the log update to storage
    queueLogUpdate(message);
    return true;
  }
});

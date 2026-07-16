// =============================================
// Scaler Class Autofill - Content Script
// =============================================

let fieldMap = {};       // CSV column → DOM selector mapping
let csvQueue = [];       // Rows to process
let currentRowIndex = 0;
let isRunning = false;
let mappingMode = false;
let pendingMappingColumn = null;

// ─── Utilities ───────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function checkRunning() {
  if (!isRunning) {
    throw new Error('Autofill stopped by user.');
  }
}

function stopOnError(msg) {
  log(`❌ Autofill stopped due to error: ${msg}`, 'error');
  alert(`Autofill paused because an error occurred:\n\n${msg}`);
  isRunning = false;
  chrome.storage.local.set({ scalerRunning: false });
  chrome.runtime.sendMessage({ action: 'autofillStopped' });
}

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function hasValue(value) {
  return value !== undefined && value !== null && String(value).trim() !== '';
}

function getRowValue(rowData, aliases) {
  const normalizedEntries = Object.entries(rowData).map(([key, value]) => ({
    normalizedKey: normalizeText(key),
    value: String(value ?? '').trim(),
  }));

  for (const alias of aliases) {
    const normalizedAlias = normalizeText(alias);
    const exactMatch = normalizedEntries.find(entry => entry.normalizedKey === normalizedAlias);
    if (exactMatch && hasValue(exactMatch.value)) return exactMatch.value;

    const partialMatch = normalizedEntries.find(entry => {
      if (!hasValue(entry.value)) return false;
      return entry.normalizedKey.includes(normalizedAlias) || normalizedAlias.includes(entry.normalizedKey);
    });
    if (partialMatch) return partialMatch.value;
  }

  return '';
}

function isVisible(el) {
  if (!el) return false;
  const style = window.getComputedStyle(el);
  return style && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0' && el.getClientRects().length > 0;
}

function triggerClick(el) {
  if (!el) return;
  el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
  el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
}

function getElementText(el) {
  if (!el) return '';
  return [
    el.getAttribute?.('aria-label'),
    el.getAttribute?.('placeholder'),
    el.getAttribute?.('title'),
    el.value,
    el.textContent,
    el.parentElement?.textContent,
    el.closest?.('label, div, section, fieldset')?.textContent,
  ].filter(Boolean).join(' ');
}

function getOptionText(el) {
  if (!el) return '';
  return (el.getAttribute?.('aria-label') || el.textContent || el.innerText || '').trim();
}

function findVisibleControlByText(text, selector = 'input, textarea, select, button, [role="combobox"], [role="button"]') {
  const normalizedNeedle = normalizeText(text);
  const controls = Array.from(document.querySelectorAll(selector)).filter(isVisible);

  return controls.find(control => normalizeText(getElementText(control)).includes(normalizedNeedle));
}

function findButtonByText(text) {
  return findVisibleControlByText(text, 'button, [role="button"]');
}

function findSectionByHeader(headerText) {
  const needle = normalizeText(headerText);
  const headers = Array.from(document.querySelectorAll('label, div, span, h1, h2, h3, h4, h5, h6'))
    .filter(isVisible)
    .filter(el => el.children.length === 0 || (el.children.length === 1 && el.firstElementChild.tagName === 'INPUT'));
  
  const match = headers.find(el => {
    const text = (el.textContent || '').trim();
    return normalizeText(text) === needle;
  }) || headers.find(el => {
    const text = (el.textContent || '').trim();
    return normalizeText(text).includes(needle) && text.length < 40;
  });

  if (!match) return null;
  return match.closest('.m-b-s, .m-b-l, form, section, fieldset, [class*="section"], [class*="row"]') || match.parentElement;
}

function findInputByPlaceholder(placeholderText) {
  const needle = normalizeText(placeholderText);
  const fields = Array.from(document.querySelectorAll('input[placeholder], textarea[placeholder]')).filter(isVisible);
  return fields.find(field => normalizeText(field.getAttribute('placeholder') || '').includes(needle));
}

function findReactSelectControlByPlaceholder(placeholderText) {
  const placeholder = Array.from(document.querySelectorAll('div[id$="-placeholder"]'))
    .filter(isVisible)
    .find(node => normalizeText(node.textContent || '').includes(normalizeText(placeholderText)));
  if (!placeholder) return null;
  const container = placeholder.closest('.css-b62m3t-container, [class*="Select_root"], [class*="container"]');
  if (!container) return null;
  return container.querySelector('[class*="-control"], [class*="control"]');
}

function findScopedComboboxInput(control) {
  if (!control) return null;
  const container = control.closest('.css-b62m3t-container, [class*="Select_root"], [class*="container"]') || control.parentElement;
  if (!container) return null;
  const scopedInput = container.querySelector('input[role="combobox"]');
  return scopedInput && isVisible(scopedInput) ? scopedInput : null;
}

async function fillInputByPlaceholder(placeholderText, value) {
  const input = findInputByPlaceholder(placeholderText);
  if (!input) return false;
  input.focus();
  setReactValue(input, value);
  await sleep(300);
  return true;
}

async function fillInputNearText(anchorText, value) {
  if (!hasValue(value)) return false;
  const anchor = findTextNodeElement(anchorText, 'label, div, span');
  if (!anchor) return false;

  const container = anchor.closest('div, section, fieldset, form') || anchor.parentElement;
  if (!container) return false;

  const input = Array.from(container.querySelectorAll('input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]), textarea'))
    .filter(isVisible)
    .find(el => !el.disabled && !el.readOnly);

  if (!input) return false;

  input.focus();
  setReactValue(input, value);
  await sleep(300);
  return true;
}

async function clickControlByText(text, timeout = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    // Priority 1: Find react-select combobox by nearby label
    const labels = Array.from(document.querySelectorAll('label')).filter(isVisible);
    const labelMatch = labels.find(label => normalizeText(label.textContent).includes(normalizeText(text)));
    
    if (labelMatch) {
      const section = labelMatch.closest('.m-b-s, .m-b-l, form, section, fieldset') || labelMatch.parentElement;
      if (section) {
        const controls = Array.from(section.querySelectorAll('.css-b62m3t-container [class*="-control"], [class*="Select_root"] [class*="-control"], [class*="css-"][class*="control"]'))
          .filter(isVisible);
        if (controls.length > 0) {
          const labelTop = labelMatch.getBoundingClientRect().top;
          const best = controls.find(control => control.getBoundingClientRect().top >= labelTop - 10) || controls[0];
          triggerClick(best);
          await sleep(600);
          return best;
        }
      }
    }

    // Priority 2: Find regular control by placeholder/text
    const control = findVisibleControlByText(text);
    if (control) {
      triggerClick(control);
      await sleep(600);
      return control;
    }

    await sleep(200);
  }
  return null;
}

async function selectOptionFromOpenDropdown(optionText, timeout = 5000, requireExact = false) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const needle = normalizeText(optionText);

    function pickBestMatch(list, textGetter) {
      let bestExact = null;
      let bestPartial = null;
      let minPartialDiff = Infinity;

      for (let index = 0; index < list.length; index++) {
        const itemText = textGetter(list[index]);
        const currentText = normalizeText(itemText);
        
        if (currentText === needle) {
          bestExact = list[index];
        } else if (!requireExact && currentText.includes(needle)) {
          const diff = currentText.length - needle.length;
          if (diff <= minPartialDiff) {
            minPartialDiff = diff;
            bestPartial = list[index];
          }
        }
      }

      return bestExact || bestPartial || null;
    }

    // Look for react-select options (they render with role="option")
    const options = Array.from(document.querySelectorAll('[role="option"]'))
      .filter(isVisible);

    if (options.length === 0) {
      // Fallback: look for plain option elements, including react-select dynamic class divs
      const plainOptions = Array.from(document.querySelectorAll('li, div[class*="-option"], div[class*="__option"], [class*="Option_root"], .option, .menu-item, [class*="dropdown-item"]'))
        .filter(isVisible);

      const target = pickBestMatch(plainOptions, option => getOptionText(option));

      if (target) {
        triggerClick(target);
        await sleep(500);
        return true;
      }
    }

    const target = pickBestMatch(options, option => getOptionText(option));

    if (target) {
      triggerClick(target);
      await sleep(500);
      return true;
    }
    await sleep(200);
  }
  return false;
}

async function openAndSelect(text, optionText) {
  const normalizedText = normalizeText(text);
  const shouldBePlaceholderSelect = normalizedText.startsWith('select ') || normalizedText.startsWith('enter ');

  let control = findReactSelectControlByPlaceholder(text);

  // Custom fallbacks when control is not found by placeholder (e.g. when a value is already pre-filled)
  if (!control) {
    if (normalizedText.includes('create today') || normalizedText.includes('create type') || normalizedText.includes('class type')) {
      const container = document.querySelector('[class*="classTypeSelect"]');
      if (container) {
        control = container.querySelector('[class*="-control"], [class*="control"]');
      }
    } else if (normalizedText.includes('module type')) {
      const container = document.querySelector('[class*="AcademyModuleInput"]');
      if (container) {
        control = container.querySelector('[class*="-control"], [class*="control"]');
      }
    } else if (normalizedText.includes('select academy module') || normalizedText.includes('module name')) {
      const containers = document.querySelectorAll('[class*="AcademyModuleInput"]');
      if (containers.length > 1) {
        control = containers[1].querySelector('[class*="-control"], [class*="control"]');
      }
    } else if (normalizedText.includes('contest duration')) {
      const section = findSectionByHeader('Contest Requirements');
      if (section) {
        const containers = section.querySelectorAll('.css-b62m3t-container, [class*="Select_root"]');
        if (containers.length > 0) {
          control = containers[0].querySelector('[class*="-control"], [class*="control"]');
        }
      }
    } else if (normalizedText.includes('course type') || normalizedText.includes('contest window')) {
      const section = findSectionByHeader('Contest Requirements');
      if (section) {
        const containers = section.querySelectorAll('.css-b62m3t-container, [class*="Select_root"]');
        if (containers.length > 1) {
          control = containers[1].querySelector('[class*="-control"], [class*="control"]');
        }
      }
    } else if (normalizedText.includes('assignment duration')) {
      const section = findSectionByHeader('Assignment');
      if (section) {
        control = section.querySelector('.css-b62m3t-container [class*="-control"], [class*="Select_root"] [class*="-control"], [class*="css-"][class*="control"]');
      }
    } else if (normalizedText.includes('homework duration')) {
      const section = findSectionByHeader('Homework');
      if (section) {
        control = section.querySelector('.css-b62m3t-container [class*="-control"], [class*="Select_root"] [class*="-control"], [class*="css-"][class*="control"]');
      }
    } else if (normalizedText.includes('pre read duration')) {
      const section = findSectionByHeader('Pre Read');
      if (section) {
        control = section.querySelector('.css-b62m3t-container [class*="-control"], [class*="Select_root"] [class*="-control"], [class*="css-"][class*="control"]');
      }
    } else if (normalizedText.includes('live lecture duration')) {
      const section = findSectionByHeader('Live Lecture');
      if (section) {
        control = section.querySelector('.css-b62m3t-container [class*="-control"], [class*="Select_root"] [class*="-control"], [class*="css-"][class*="control"]');
      }
    } else if (normalizedText.includes('discussion duration')) {
      const section = findSectionByHeader('Discussion Duration');
      if (section) {
        control = section.querySelector('.css-b62m3t-container [class*="-control"], [class*="Select_root"] [class*="-control"], [class*="css-"][class*="control"]');
      }
    }
  }

  // Early return if the dropdown already displays optionText
  if (control && hasValue(optionText)) {
    const singleValueEl = control.querySelector('[class*="singleValue"], [class*="SingleValue"]');
    if (singleValueEl && normalizeText(singleValueEl.textContent || '') === normalizeText(optionText)) {
      return control;
    }
  }

  if (control) {
    triggerClick(control);
    await sleep(500);
  } else {
    if (shouldBePlaceholderSelect) {
      log(`⚠️ Could not find select control for "${text}"`, 'warn');
      return null;
    }
    control = await clickControlByText(text);
  }
  if (!control) return null;

  if (hasValue(optionText)) {
    // 1. Try to find an exact match in the currently open dropdown (fast path)
    let selected = await selectOptionFromOpenDropdown(optionText, 1000, true);
    if (selected) return control;

    // 2. If not found, try to type in the combobox if available
    const scopedCombobox = findScopedComboboxInput(control);
    if (scopedCombobox) {
      scopedCombobox.focus();
      setReactValue(scopedCombobox, optionText);
      await sleep(500);
      
      // Look for exact matches first in the filtered dropdown
      if (await selectOptionFromOpenDropdown(optionText, 2000, true)) return control;
      
      // Look for partial matches next
      if (await selectOptionFromOpenDropdown(optionText, 1000, false)) return control;
      
      // If neither exact nor partial match can be clicked, try hitting Enter key
      scopedCombobox.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
      await sleep(250);
      return control;
    }

    // 3. Fallback if no combobox is present: try partial match in the dropdown
    selected = await selectOptionFromOpenDropdown(optionText, 2000, false);
    if (selected) return control;

    log(`⚠️ Could not select option "${optionText}" for "${text}"`, 'warn');
    return null;
  }

  return control;
}

async function fillVisibleInput(value, timeout = 4000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const fields = Array.from(document.querySelectorAll('input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]), textarea'))
      .filter(isVisible);
    
    const target = fields.slice().reverse().find(field => {
      if (field.disabled || field.readOnly) return false;
      const existing = String(field.value || '').trim();
      return existing === '';
    });

    if (target) {
      target.focus();
      await sleep(200);
      setReactValue(target, value);
      await sleep(300);
      return true;
    }
    await sleep(200);
  }
  return false;
}

async function fillFieldByLabel(labelText, value) {
  const control = findVisibleControlByText(labelText, 'input, textarea');
  if (control) {
    control.focus();
    setReactValue(control, value);
    await sleep(300);
    return true;
  }

  return fillVisibleInput(value);
}

async function clickSectionButton(labelText) {
  const start = Date.now();
  const timeout = 8000;
  const needle = normalizeText(labelText);
  
  while (Date.now() - start < timeout) {
    // Find toggle chips by exact/close text and click the plus icon inside.
    const chips = Array.from(document.querySelectorAll('.ToggleChip_root__YnBT3, [class*="ToggleChip"]'))
      .filter(isVisible);

    const exactChip = chips.find(chip => normalizeText(chip.textContent || '') === needle);
    const startsWithChip = chips.find(chip => normalizeText(chip.textContent || '').startsWith(needle));
    const includesChip = chips.find(chip => normalizeText(chip.textContent || '').includes(needle));
    const target = exactChip || startsWithChip || includesChip;

    if (target) {
      const plusIcon = target.querySelector('.Icon-module_icon-add__B3tYa, [class*="icon-add"], i[class*="add"], svg');
      triggerClick(plusIcon || target);
      await sleep(800);
      return true;
    }

    // Fallback: find by button text
    const button = findButtonByText(labelText);
    if (button) {
      triggerClick(button);
      await sleep(800);
      return true;
    }

    await sleep(200);
  }

  log(`⚠️ Could not find button/chip for "${labelText}"`, 'warn');
  return false;
}

async function fillAfterSectionOpen(value) {
  if (!hasValue(value)) return true;
  await sleep(800); // Wait for section to render
  return fillVisibleInput(value, 5000);
}

async function fillLectureDetailEditor(sectionLabel, value, editorIndex) {
  if (!hasValue(value)) return false;

  const placeholderNeedle = normalizeText(`Enter ${sectionLabel}`);

  // Priority 1: TinyMCE/iframe editor that still shows section placeholder text.
  const iframes = Array.from(document.querySelectorAll('iframe')).filter(isVisible);
  for (const frame of iframes) {
    try {
      const body = frame.contentDocument?.body;
      if (!body) continue;
      const currentText = normalizeText(body.textContent || '');
      if (currentText.includes(placeholderNeedle)) {
        body.innerHTML = `<p>${escapeHtml(value)}</p>`;
        body.dispatchEvent(new Event('input', { bubbles: true }));
        body.dispatchEvent(new Event('keyup', { bubbles: true }));
        return true;
      }
    } catch (err) {
      // Ignore cross-frame/unsafe access and continue with other strategies.
    }
  }

  // Priority 2: fallback to visible editor by order among active rich editors.
  const visibleIframeBodies = iframes
    .map(frame => {
      try {
        return frame.contentDocument?.body || null;
      } catch (err) {
        return null;
      }
    })
    .filter(body => body && isVisible(body));

  if (visibleIframeBodies[editorIndex]) {
    const body = visibleIframeBodies[editorIndex];
    body.innerHTML = `<p>${escapeHtml(value)}</p>`;
    body.dispatchEvent(new Event('input', { bubbles: true }));
    body.dispatchEvent(new Event('keyup', { bubbles: true }));
    return true;
  }

  // Priority 3: contenteditable editors (non-iframe rich text).
  const editables = Array.from(document.querySelectorAll('[contenteditable="true"]'))
    .filter(isVisible)
    .filter(el => !el.closest('[role="option"]'));

  if (editables[editorIndex]) {
    const editable = editables[editorIndex];
    editable.focus();
    editable.innerHTML = `<p>${escapeHtml(value)}</p>`;
    editable.dispatchEvent(new Event('input', { bubbles: true }));
    editable.dispatchEvent(new Event('keyup', { bubbles: true }));
    return true;
  }

  return false;
}

async function clickCreateClassButton() {
  const button = findButtonByText('Create Class');
  if (!button) return false;
  triggerClick(button);
  await sleep(1200);
  return true;
}

function hasLectureSignals(rowData) {
  return [
    'topic name',
    'topic',
    'lecture activity',
    'academy module type',
    'academy module name',
    'ta skill',
    'pre lecture content',
    'post lecture content',
    'research papers',
    'live lecture duration',
    'assignment duration',
    'homework duration',
    'pre read duration',
    'case study id',
  ].some(alias => hasValue(getRowValue(rowData, [alias])));
}

function resolveCreateMode(rowData) {
  const rawValue = getRowValue(rowData, [
    'what do you want to create today',
    'create type',
    'class type',
    'create today',
  ]);

  const normalized = normalizeText(rawValue);
  const allowed = new Map([
    ['lecture', 'Lecture'],
    ['contest', 'Contest'],
    ['class without live lecture', 'Class without Live Lecture'],
  ]);

  if (allowed.has(normalized)) {
    return allowed.get(normalized);
  }

  if (hasLectureSignals(rowData)) {
    return 'Lecture';
  }

  return rawValue;
}

async function fillOptionalSubtype(control, value) {
  if (!control) return false;
  
  let current = control.parentElement;
  while (current && current !== document.body) {
    const controls = Array.from(current.querySelectorAll('.css-b62m3t-container [class*="-control"], [class*="Select_root"] [class*="-control"], [class*="css-"][class*="control"]'))
      .filter(isVisible);
      
    const sibling = controls.find(c => c !== control && !control.contains(c) && !c.contains(control));
    if (sibling) {
      if (hasValue(value)) {
        const singleValueEl = sibling.querySelector('[class*="singleValue"], [class*="SingleValue"]');
        if (singleValueEl && normalizeText(singleValueEl.textContent || '') === normalizeText(value)) {
          log(`✅ Optional subtype already set to "${value}"`, 'success');
          return true;
        }
      }
      
      log(`🔄 Selecting optional subtype "${value}" in sibling dropdown`, 'info');
      triggerClick(sibling);
      await sleep(600);
      
      // 1. Try fast-path select from open dropdown options
      let selected = await selectOptionFromOpenDropdown(value, 1000, true);
      if (!selected) {
        // 2. Fallback: Type in combobox if search input is available
        const scopedCombobox = findScopedComboboxInput(sibling);
        if (scopedCombobox) {
          scopedCombobox.focus();
          setReactValue(scopedCombobox, value);
          await sleep(500);
          
          if (await selectOptionFromOpenDropdown(value, 2000, true)) {
            selected = true;
          } else if (await selectOptionFromOpenDropdown(value, 1000, false)) {
            selected = true;
          } else {
            scopedCombobox.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
            await sleep(250);
            selected = true;
          }
        } else {
          // 3. Fallback: select partial match from open dropdown options
          selected = await selectOptionFromOpenDropdown(value, 2000, false);
        }
      }
      
      if (selected) return true;
    }
    current = current.parentElement;
  }
  
  log(`⚠️ Sibling dropdown not found or could not select value "${value}" for optional activity`, 'warn');
  return false;
}

async function fillLectureFlow(rowData) {
  const createMode = resolveCreateMode(rowData) || 'Lecture';

  log(`🎓 Starting lecture flow (type: ${createMode})`, 'info');
  const selectedType = await openAndSelect('What do you want to create today', createMode || 'Lecture');
  if (!selectedType) throw new Error(`Failed to select creation type: "${createMode || 'Lecture'}"`);

  const topicName = getRowValue(rowData, ['topic name', 'topic', 'lecture topic', 'class topic']);
  if (hasValue(topicName)) {
    log(`📝 Filling topic: ${topicName}`, 'info');
    const filled = (await fillInputByPlaceholder('Enter Topic Name', topicName)) || (await fillFieldByLabel('Enter Topic Name', topicName));
    if (!filled) throw new Error(`Failed to fill topic name: "${topicName}"`);
  }

  const lectureActivity = getRowValue(rowData, ['lecture activity', 'activity', 'regular/optional', 'session type']) || 'Regular';
  log(`🔄 Setting lecture activity: ${lectureActivity}`, 'info');
  const activityControl = await openAndSelect('Lecture Activity', lectureActivity);
  if (!activityControl) throw new Error(`Failed to select activity: "${lectureActivity}"`);
  
  if (normalizeText(lectureActivity) === 'optional') {
    checkRunning();
    const subtypeFilled = await fillOptionalSubtype(activityControl, 'Optional');
    if (!subtypeFilled) throw new Error(`Failed to select Optional subtype`);
  }

  const academyModuleType = getRowValue(rowData, ['academy module type', 'module type', 'module category']) || getRowValue(rowData, ['academy module']);
  const academyModuleName = getRowValue(rowData, ['academy module name', 'module name', 'academy module value', 'module']);
  if (hasValue(academyModuleType) || hasValue(academyModuleName)) {
    log(`📚 Setting academy module: ${academyModuleType} > ${academyModuleName}`, 'info');
    if (hasValue(academyModuleType)) {
      const filled = await openAndSelect('Select Academy Module Type', academyModuleType);
      if (!filled) throw new Error(`Failed to select Academy Module Type: "${academyModuleType}"`);
    }
    if (hasValue(academyModuleName)) {
      const filled = await openAndSelect('Select Academy Module', academyModuleName);
      if (!filled) throw new Error(`Failed to select Academy Module Name: "${academyModuleName}"`);
    }
  }

  const junctionNumber = getRowValue(rowData, ['junction number', 'junction', 'junction no', 'junction id']);
  if (hasValue(junctionNumber)) {
    log(`🔢 Setting junction number: ${junctionNumber}`, 'info');
    const filled = (await fillInputByPlaceholder('Enter Junction Number', junctionNumber)) || (await fillFieldByLabel('Enter Junction Number', junctionNumber));
    if (!filled) throw new Error(`Failed to fill junction number: "${junctionNumber}"`);
  }

  const taSkill = getRowValue(rowData, ['ta skill', 'ta skills', 'skill']);
  if (hasValue(taSkill)) {
    log(`👥 Setting TA skill: ${taSkill}`, 'info');
    const filled = await openAndSelect('TA Skill', taSkill);
    if (!filled) throw new Error(`Failed to select TA Skill: "${taSkill}"`);
  }

  const lectureSections = [
    { label: 'Pre Lecture Content', aliases: ['pre lecture content', 'pre lecture', 'pre lecture link', 'pre lecture text'] },
    { label: 'Post Lecture Content', aliases: ['post lecture content', 'post lecture', 'post lecture link', 'post lecture text'] },
    { label: 'Research Papers', aliases: ['research papers', 'research paper', 'paper link', 'paper content'] },
  ];

  let lectureEditorIndex = 0;
  for (const section of lectureSections) {
    const value = getRowValue(rowData, section.aliases);
    if (!hasValue(value)) continue;
    checkRunning();
    log(`📄 Adding ${section.label}`, 'info');
    const opened = await clickSectionButton(section.label);
    if (!opened) throw new Error(`Failed to open section: "${section.label}"`);
    
    await sleep(600);
    const editorFilled = await fillLectureDetailEditor(section.label, value, lectureEditorIndex);
    if (!editorFilled) {
      const inputFilled = (await fillInputNearText(section.label, value)) || (await fillAfterSectionOpen(value));
      if (!inputFilled) throw new Error(`Failed to fill section detail for: "${section.label}"`);
    }
    lectureEditorIndex += 1;
  }

  const liveLectureDuration = getRowValue(rowData, ['live lecture duration', 'live lecture', 'lecture duration']);
  const classTag = getRowValue(rowData, ['class tag']) || 'Default';
  if (hasValue(liveLectureDuration) || hasValue(classTag)) {
    log(`🎬 Configuring live lecture`, 'info');
    const opened = await clickSectionButton('Live Lecture');
    if (!opened) throw new Error(`Failed to open Live Lecture section`);
    
    if (hasValue(liveLectureDuration)) {
      log(`⏱️ Duration: ${liveLectureDuration} min`, 'info');
      const filled = await openAndSelect('Enter Live Lecture Duration', liveLectureDuration);
      if (!filled) throw new Error(`Failed to select Live Lecture duration: "${liveLectureDuration}"`);
    }
    if (hasValue(classTag)) {
      log(`🏷️ Tag: ${classTag}`, 'info');
      const filled = await openAndSelect('Class Tag', classTag);
      if (!filled) throw new Error(`Failed to select Class Tag: "${classTag}"`);
    }
  }

  const durationSections = [
    {
      label: 'Assignment',
      durationAliases: ['assignment duration', 'assignment', 'assignment minutes'],
      slugAliases: ['assignment slug id', 'assignment slug', 'slug id assignment'],
    },
    {
      label: 'Homework',
      durationAliases: ['homework duration', 'homework', 'homework minutes'],
      slugAliases: ['homework slug id', 'homework slug', 'slug id homework'],
    },
    {
      label: 'Pre Read',
      durationAliases: ['pre read duration', 'pre read', 'preread duration'],
      slugAliases: ['pre read slug id', 'pre read slug', 'slug id pre read'],
    },
  ];

  for (const section of durationSections) {
    const durationValue = getRowValue(rowData, section.durationAliases);
    const slugValue = getRowValue(rowData, section.slugAliases);
    if (!hasValue(durationValue) && !hasValue(slugValue)) continue;

    checkRunning();
    log(`📋 Configuring ${section.label}`, 'info');
    const opened = await clickSectionButton(section.label);
    if (!opened) throw new Error(`Failed to open section: "${section.label}"`);
    
    if (hasValue(slugValue)) {
      log(`  Slug: ${slugValue}`, 'info');
      const slugPlaceholder = `${section.label} Slug Id`;
      const filled = (await fillInputByPlaceholder(slugPlaceholder, slugValue)) || (await fillAfterSectionOpen(slugValue));
      if (!filled) throw new Error(`Failed to fill slug for: "${section.label}"`);
    }
    if (hasValue(durationValue)) {
      log(`  Duration: ${durationValue}`, 'info');
      const durationPlaceholder = `Enter ${section.label} Duration`;
      const filled = (await openAndSelect(durationPlaceholder, durationValue)) || (await fillAfterSectionOpen(durationValue));
      if (!filled) throw new Error(`Failed to select duration for: "${section.label}"`);
    }
  }

  const caseStudyId = getRowValue(rowData, ['case study id', 'case study', 'case study slug', 'case study slug id']);
  if (hasValue(caseStudyId)) {
    log(`📚 Adding case study: ${caseStudyId}`, 'info');
    const opened = await clickSectionButton('Add Case Study');
    if (!opened) throw new Error(`Failed to open Add Case Study section`);
    
    const caseStudyInputFilled = await fillInputNearText('Add Case Study', caseStudyId) || await fillVisibleInput(caseStudyId, 5000);
    if (!caseStudyInputFilled) throw new Error(`Failed to fill Case Study ID: "${caseStudyId}"`);
    
    const confirmButton = findButtonByText('Confirm') || findButtonByText('Add') || findButtonByText('Save');
    if (!confirmButton) throw new Error(`Failed to find Confirm/Add button for Case Study`);
    triggerClick(confirmButton);
    await sleep(800);
  }

  log(`✅ Submitting class creation`, 'info');
  await clickCreateClassButton();
  return true;
}

async function fillContestFlow(rowData) {
  const discussionToggle = getRowValue(rowData, ['discussion toggle', 'discussion', 'enable discussion']);
  const wantsDiscussion = hasValue(discussionToggle) && ['true', 'yes', '1', 'on'].includes(normalizeText(discussionToggle));

  if (!wantsDiscussion) {
    const hasDiscussionDuration = hasValue(getRowValue(rowData, ['discussion duration', 'discussion time']));
    const hasPreLecture = hasValue(getRowValue(rowData, ['pre lecture content', 'pre lecture', 'pre lecture link', 'pre lecture text']));
    const hasPostLecture = hasValue(getRowValue(rowData, ['post lecture content', 'post lecture', 'post lecture link', 'post lecture text']));
    const hasResearchPapers = hasValue(getRowValue(rowData, ['research papers', 'research paper', 'paper link', 'paper content']));

    if (hasDiscussionDuration || hasPreLecture || hasPostLecture || hasResearchPapers) {
      const errorMsg = `Stopping autofill: Discussion is disabled (false), but discussion-related fields (duration, pre/post lecture, or research papers) are filled in the CSV.`;
      log(`❌ ${errorMsg}`, 'error');
      alert(errorMsg);
      isRunning = false;
      chrome.runtime.sendMessage({ action: 'stopAutofill' });
      return false;
    }
  }

  log(`🏆 Starting contest flow`, 'info');
  const selectedType = await openAndSelect('What do you want to create today', 'Contest');
  if (!selectedType) throw new Error("Failed to select creation type: Contest");

  const topicName = getRowValue(rowData, ['topic name', 'topic', 'lecture topic', 'class topic', 'contest name']);
  if (hasValue(topicName)) {
    log(`📝 Filling topic/contest name: ${topicName}`, 'info');
    const filled = (await fillInputByPlaceholder('Enter Topic Name', topicName)) || (await fillFieldByLabel('Enter Topic Name', topicName));
    if (!filled) throw new Error(`Failed to fill topic name: "${topicName}"`);
  }

  const contestActivity = getRowValue(rowData, ['contest activity', 'lecture activity', 'activity', 'session type']) || 'Regular';
  log(`🔄 Setting contest activity: ${contestActivity}`, 'info');
  const activityControl = await openAndSelect('Contest Activity', contestActivity);
  if (!activityControl) throw new Error(`Failed to select activity: "${contestActivity}"`);
  
  if (normalizeText(contestActivity) === 'optional') {
    checkRunning();
    const subtypeFilled = await fillOptionalSubtype(activityControl, 'Optional');
    if (!subtypeFilled) throw new Error(`Failed to select Optional subtype`);
  }

  const academyModuleType = getRowValue(rowData, ['academy module type', 'module type', 'module category']) || 'Core';
  log(`📚 Setting academy module type: ${academyModuleType}`, 'info');
  const typeFilled = await openAndSelect('Select Academy Module Type', academyModuleType);
  if (!typeFilled) throw new Error(`Failed to select Academy Module Type: "${academyModuleType}"`);

  const academyModuleName = getRowValue(rowData, ['academy module name', 'module name', 'academy module value', 'module']);
  if (hasValue(academyModuleName)) {
    log(`📚 Setting academy module name: ${academyModuleName}`, 'info');
    const nameFilled = await openAndSelect('Select Academy Module', academyModuleName);
    if (!nameFilled) throw new Error(`Failed to select Academy Module Name: "${academyModuleName}"`);
  }

  const junctionNumber = getRowValue(rowData, ['junction number', 'junction', 'junction no', 'junction id']);
  if (hasValue(junctionNumber)) {
    log(`🔢 Setting junction number: ${junctionNumber}`, 'info');
    const filled = (await fillInputByPlaceholder('Enter Junction Number', junctionNumber)) || (await fillFieldByLabel('Enter Junction Number', junctionNumber));
    if (!filled) throw new Error(`Failed to fill junction number: "${junctionNumber}"`);
  }

  const taSkill = getRowValue(rowData, ['ta skill', 'ta skills', 'skill']);
  if (hasValue(taSkill)) {
    log(`👥 Setting TA skill: ${taSkill}`, 'info');
    const filled = await openAndSelect('TA Skill', taSkill);
    if (!filled) throw new Error(`Failed to select TA Skill: "${taSkill}"`);
  }

  // Contest Type selection
  const singleVal = getRowValue(rowData, ['contest_type_single', 'single contest', 'is single']);
  const groupVal = getRowValue(rowData, ['contest_type_group', 'group contest', 'is group']);
  
  let isSingle = false;
  if (hasValue(singleVal)) {
    isSingle = ['true', 'yes', '1', 'on'].includes(normalizeText(singleVal));
  } else if (hasValue(groupVal)) {
    isSingle = !['true', 'yes', '1', 'on'].includes(normalizeText(groupVal));
  } else {
    const contestType = getRowValue(rowData, ['contest type', 'contest category', 'type']);
    if (hasValue(contestType)) {
      isSingle = normalizeText(contestType).includes('single');
    }
  }

  const targetRadioText = isSingle ? 'Single Contest' : 'Group Contest';
  log(`🎯 Setting contest type: ${targetRadioText}`, 'info');
  
  const radioLabels = Array.from(document.querySelectorAll('.RadioButton-module_root__gQhQR, [class*="RadioButton-module_root"], label'))
    .filter(isVisible);
  const matchedRadioLabel = radioLabels.find(label => normalizeText(label.textContent || '').includes(normalizeText(targetRadioText)));
  if (matchedRadioLabel) {
    triggerClick(matchedRadioLabel);
    await sleep(400);
  } else {
    throw new Error(`Failed to find radio button for contest type: "${targetRadioText}"`);
  }

  // Contest Requirements (Contest ID, Duration, and either Window or Course Type)
  const contestId = getRowValue(rowData, ['contest id', 'single contest id', 'group contest id', 'contest slug']);
  if (isSingle) {
    if (hasValue(contestId)) {
      log(`🆔 Setting single contest ID: ${contestId}`, 'info');
      const filled = await fillInputByPlaceholder('Single Contest ID', contestId);
      if (!filled) throw new Error(`Failed to fill Single Contest ID: "${contestId}"`);
    }
  } else {
    if (hasValue(contestId)) {
      log(`🆔 Setting group contest ID: ${contestId}`, 'info');
      const filled = await fillInputByPlaceholder('Group Contest ID', contestId);
      if (!filled) throw new Error(`Failed to fill Group Contest ID: "${contestId}"`);
    }
  }

  const contestDuration = getRowValue(rowData, ['contest duration', 'duration']);
  if (hasValue(contestDuration)) {
    log(`⏱️ Setting duration: ${contestDuration}`, 'info');
    const filled = await openAndSelect('Enter Contest Duration', contestDuration);
    if (!filled) throw new Error(`Failed to select contest duration: "${contestDuration}"`);
  }

  if (isSingle) {
    const contestWindow = getRowValue(rowData, ['contest window', 'window']);
    if (hasValue(contestWindow)) {
      log(`⏱️ Setting window: ${contestWindow}`, 'info');
      const filled = await openAndSelect('Enter Contest Window', contestWindow);
      if (!filled) throw new Error(`Failed to select contest window: "${contestWindow}"`);
    }
  } else {
    const courseType = getRowValue(rowData, ['course type', 'course_type']);
    if (hasValue(courseType)) {
      log(`📚 Setting course type: ${courseType}`, 'info');
      const filled = await openAndSelect('Select Course Type', courseType);
      if (!filled) throw new Error(`Failed to select course type: "${courseType}"`);
    }
  }

  // Discussion Toggle
  log(`💬 Discussion enabled: ${wantsDiscussion}`, 'info');
  const label = Array.from(document.querySelectorAll('label, div, span, h1, h2, h3, h4, h5, h6'))
    .filter(isVisible)
    .find(el => {
      const text = (el.textContent || '').trim();
      return text.toLowerCase().startsWith('discussion') && text.length < 30;
    });
  
  let switchWrapper = null;
  let checkboxInput = null;

  if (label) {
    const parentContainer = label.closest('.row, div, section, fieldset, [class*="row"], [class*="section"]') || label.parentElement;
    if (parentContainer) {
      switchWrapper = parentContainer.querySelector('[class*="Switch_switch"]');
      checkboxInput = parentContainer.querySelector('input[type="checkbox"]');
    }
  }

  // Fallback to global search if not found within the parent container
  if (!switchWrapper) {
    switchWrapper = document.querySelector('[class*="Switch_switch"]');
  }
  if (!checkboxInput) {
    checkboxInput = document.querySelector('input[type="checkbox"]');
  }

  // Check state based on the class list of switchWrapper first, then fallback to checkbox input
  function getCheckedState() {
    if (switchWrapper) {
      const classes = switchWrapper.classList.toString();
      return classes.includes('checked') || classes.includes('Switch_checked');
    }
    return checkboxInput ? checkboxInput.checked : false;
  }

  if (checkboxInput || switchWrapper) {
    const isCurrentlyChecked = getCheckedState();
    if (wantsDiscussion !== isCurrentlyChecked) {
      log(`🔄 Toggling discussion switch (current: ${isCurrentlyChecked}, target: ${wantsDiscussion})`, 'info');
      
      const clickTargets = [];
      if (switchWrapper) {
        const track = switchWrapper.querySelector('[class*="track"]');
        if (track) clickTargets.push(track);
      }
      if (switchWrapper) clickTargets.push(switchWrapper);
      if (checkboxInput) clickTargets.push(checkboxInput);
      if (switchWrapper) {
        const thumb = switchWrapper.querySelector('[class*="thumb"]');
        if (thumb) clickTargets.push(thumb);
      }
      if (label) clickTargets.push(label);

      for (const target of clickTargets) {
        log(`👉 Attempting click on: ${target.tagName}.${Array.from(target.classList).join('.')}`, 'info');
        triggerClick(target);
        target.click();
        
        await sleep(250); // Wait for React to apply update
        
        if (getCheckedState() === wantsDiscussion) {
          log(`✅ Discussion toggle successfully set to ${wantsDiscussion}!`, 'success');
          break;
        }
      }

      // Final fallback: Direct property setter bypass
      if (getCheckedState() !== wantsDiscussion && checkboxInput) {
        log(`🔄 Using React property setter fallback to force toggle to ${wantsDiscussion}`, 'info');
        setReactCheckbox(checkboxInput, wantsDiscussion);
        await sleep(300);
        if (getCheckedState() === wantsDiscussion) {
          log(`✅ Discussion toggle successfully forced to ${wantsDiscussion}!`, 'success');
        } else {
          log(`⚠️ Discussion toggle state verification failed, but action was dispatched.`, 'warn');
        }
      }
    }
  } else {
    throw new Error(`Failed to locate discussion switch or checkbox input`);
  }

  if (wantsDiscussion) {
    const discussionDuration = getRowValue(rowData, ['discussion duration', 'discussion time']);
    if (hasValue(discussionDuration)) {
      log(`⏱️ Setting discussion duration: ${discussionDuration}`, 'info');
      const filled = await openAndSelect('Enter Discussion Duration', discussionDuration);
      if (!filled) throw new Error(`Failed to select discussion duration: "${discussionDuration}"`);
    }

    // Pre/Post Lecture Content and Research Papers (Toggle chips)
    const lectureSections = [
      { label: 'Pre Lecture Content', aliases: ['pre lecture content', 'pre lecture', 'pre lecture link', 'pre lecture text'] },
      { label: 'Post Lecture Content', aliases: ['post lecture content', 'post lecture', 'post lecture link', 'post lecture text'] },
      { label: 'Research Papers', aliases: ['research papers', 'research paper', 'paper link', 'paper content'] },
    ];

    let lectureEditorIndex = 0;
    for (const section of lectureSections) {
      const value = getRowValue(rowData, section.aliases);
      if (!hasValue(value)) continue;
      checkRunning();
      log(`📄 Adding ${section.label}`, 'info');
      const opened = await clickSectionButton(section.label);
      if (!opened) throw new Error(`Failed to open discussion section: "${section.label}"`);
      
      await sleep(600);
      const editorFilled = await fillLectureDetailEditor(section.label, value, lectureEditorIndex);
      if (!editorFilled) {
        const inputFilled = (await fillInputNearText(section.label, value)) || (await fillAfterSectionOpen(value));
        if (!inputFilled) throw new Error(`Failed to fill discussion section detail: "${section.label}"`);
      }
      lectureEditorIndex += 1;
    }
  }

  log(`✅ Submitting contest creation`, 'info');
  await clickCreateClassButton();
  return true;
}

function log(msg, type = 'info') {
  chrome.runtime.sendMessage({ action: 'updateProgress', type, message: msg });
}

// React-friendly value setter (bypasses controlled input)
function setReactValue(el, value) {
  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
    el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype,
    'value'
  )?.set;
  if (nativeInputValueSetter) {
    nativeInputValueSetter.call(el, value);
  } else {
    el.value = value;
  }
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function setReactCheckbox(el, checked) {
  if (!el) return;
  const nativeCheckboxSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    'checked'
  )?.set;
  if (nativeCheckboxSetter) {
    nativeCheckboxSetter.call(el, checked);
  } else {
    el.checked = checked;
  }
  el.dispatchEvent(new Event('click', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

// Wait for element with timeout
async function waitForElement(selector, timeout = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const el = document.querySelector(selector);
    if (el) return el;
    await sleep(200);
  }
  return null;
}

// Wait for element by text content
async function waitForElementByText(tag, text, timeout = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const els = Array.from(document.querySelectorAll(tag));
    const found = els.find(el => el.textContent.trim().toLowerCase().includes(text.toLowerCase()));
    if (found) return found;
    await sleep(200);
  }
  return null;
}

// Click helper that waits for element
async function clickElement(selector, timeout = 8000) {
  const el = await waitForElement(selector, timeout);
  if (el) {
    triggerClick(el);
    await sleep(500);
    return true;
  }
  return false;
}

// Fill input by selector
async function fillField(selector, value) {
  const el = await waitForElement(selector, 5000);
  if (!el) return false;
  el.focus();
  setReactValue(el, value);
  await sleep(300);
  return true;
}

// Select dropdown option by visible text
async function selectDropdown(selector, optionText) {
  const trigger = await waitForElement(selector, 5000);
  if (!trigger) return false;
  triggerClick(trigger);
  await sleep(600);

  // Try to find option in dropdown list
  const options = Array.from(document.querySelectorAll('[role="option"], div[class*="-option"], div[class*="__option"], [class*="Option_root"], li[class*="option"], [class*="menu-item"], [class*="dropdown-item"]'));
  const match = options.find(o => getOptionText(o).trim().toLowerCase() === optionText.toLowerCase());
  if (match) {
    triggerClick(match);
    await sleep(400);
    return true;
  }

  // Try typing into search input
  const search = document.querySelector('[class*="search"] input, [class*="filter"] input, [placeholder*="search" i]');
  if (search) {
    setReactValue(search, optionText);
    await sleep(800);
    const filtered = Array.from(document.querySelectorAll('[role="option"], div[class*="-option"], div[class*="__option"], [class*="Option_root"], li[class*="option"]'));
    const match2 = filtered.find(o => getOptionText(o).trim().toLowerCase().includes(optionText.toLowerCase()));
    if (match2) {
      triggerClick(match2);
      await sleep(400);
      return true;
    }
  }

  log(`⚠️ Could not find option "${optionText}" in dropdown ${selector}`, 'warn');
  return false;
}

// ─── Field Map Storage ────────────────────────

async function saveFieldMap(map) {
  return new Promise(resolve => chrome.storage.local.set({ scalerFieldMap: map }, resolve));
}

async function loadFieldMap() {
  return new Promise(resolve => {
    chrome.storage.local.get('scalerFieldMap', result => {
      resolve(result.scalerFieldMap || {});
    });
  });
}

// ─── Mapping Mode UI ─────────────────────────

function injectMappingUI() {
  if (document.getElementById('scaler-mapper-banner')) return;

  const banner = document.createElement('div');
  banner.id = 'scaler-mapper-banner';
  banner.style.cssText = `
    position: fixed; top: 0; left: 0; right: 0; z-index: 999999;
    background: #1a1a2e; color: #fff; padding: 12px 20px;
    font-family: sans-serif; font-size: 13px;
    display: flex; align-items: center; gap: 16px;
    box-shadow: 0 2px 12px rgba(0,0,0,0.4);
  `;
  banner.innerHTML = `
    <span style="color:#00d4ff; font-weight:600;">🎯 MAPPING MODE</span>
    <span id="mapper-instruction">Click a field on the form to map it to a CSV column</span>
    <span id="mapper-column-badge" style="background:#00d4ff;color:#000;padding:2px 8px;border-radius:4px;font-weight:700;display:none;"></span>
    <button id="mapper-done" style="margin-left:auto;background:#00d4ff;color:#000;border:none;padding:6px 14px;border-radius:6px;cursor:pointer;font-weight:600;">Done Mapping</button>
  `;
  document.body.prepend(banner);

  document.getElementById('mapper-done').addEventListener('click', () => {
    disableMappingMode();
    saveFieldMap(fieldMap);
    chrome.runtime.sendMessage({ action: 'mappingComplete', fieldMap });
    log('✅ Field map saved!', 'success');
  });

  // Highlight elements on hover
  document.addEventListener('mouseover', onHover, true);
  document.addEventListener('mouseout', onMouseOut, true);
  document.addEventListener('click', onMapClick, true);
}

let hoveredEl = null;

function onHover(e) {
  if (!mappingMode) return;
  const el = e.target.closest('input, textarea, select, [class*="select"], [class*="dropdown"], [role="combobox"]');
  if (!el) return;
  hoveredEl = el;
  el.style.outline = '3px solid #00d4ff';
  el.style.outlineOffset = '2px';
}

function onMouseOut(e) {
  if (hoveredEl) {
    hoveredEl.style.outline = '';
    hoveredEl.style.outlineOffset = '';
    hoveredEl = null;
  }
}

function onMapClick(e) {
  if (!mappingMode || !pendingMappingColumn) return;
  const el = e.target.closest('input, textarea, select, [class*="select"], [class*="dropdown"], [role="combobox"]');
  if (!el) return;

  e.preventDefault();
  e.stopPropagation();

  // Build a unique selector for this element
  const selector = buildSelector(el);
  fieldMap[pendingMappingColumn] = { selector, type: getFieldType(el) };

  log(`✅ Mapped "${pendingMappingColumn}" → ${selector}`, 'success');
  chrome.runtime.sendMessage({ action: 'fieldMapped', column: pendingMappingColumn, selector });

  el.style.outline = '3px solid #00ff88';
  setTimeout(() => { el.style.outline = ''; }, 1500);
}

function buildSelector(el) {
  // Try id first
  if (el.id) return `#${CSS.escape(el.id)}`;
  // Try name attribute
  if (el.name) return `[name="${el.name}"]`;
  // Try placeholder
  if (el.placeholder) return `[placeholder="${el.placeholder}"]`;
  // Try aria-label
  if (el.getAttribute('aria-label')) return `[aria-label="${el.getAttribute('aria-label')}"]`;
  // Build class-based selector
  const classes = Array.from(el.classList).filter(c => !c.includes('hover') && !c.includes('focus')).slice(0, 3).join('.');
  if (classes) return `${el.tagName.toLowerCase()}.${classes}`;
  // Fallback: nth-child path
  return getFullPath(el);
}

function getFullPath(el) {
  const parts = [];
  while (el && el !== document.body) {
    let seg = el.tagName.toLowerCase();
    if (el.id) { parts.unshift(`#${CSS.escape(el.id)}`); break; }
    const idx = Array.from(el.parentNode?.children || []).indexOf(el) + 1;
    seg += `:nth-child(${idx})`;
    parts.unshift(seg);
    el = el.parentElement;
  }
  return parts.join(' > ');
}

function getFieldType(el) {
  if (el.tagName === 'SELECT') return 'select';
  if (el.tagName === 'TEXTAREA') return 'textarea';
  if (el.getAttribute('role') === 'combobox' || el.classList.toString().includes('select')) return 'dropdown';
  if (el.type === 'date' || el.type === 'datetime-local') return 'date';
  if (el.type === 'checkbox' || el.type === 'radio') return 'checkbox';
  return 'input';
}

function disableMappingMode() {
  mappingMode = false;
  document.removeEventListener('mouseover', onHover, true);
  document.removeEventListener('mouseout', onMouseOut, true);
  document.removeEventListener('click', onMapClick, true);
  const banner = document.getElementById('scaler-mapper-banner');
  if (banner) banner.remove();
}

// ─── Next Button Detection ────────────────────

async function clickNextButton() {
  // Common next button patterns
  const selectors = [
    'button[type="submit"]',
    'button:not([disabled])[class*="next"]',
    'button:not([disabled])[class*="Next"]',
    'button:not([disabled])[class*="continue"]',
    'button:not([disabled])[class*="proceed"]',
    'button:not([disabled])[class*="primary"]',
  ];

  for (const sel of selectors) {
    const btns = Array.from(document.querySelectorAll(sel));
    const btn = btns.find(b => {
      const text = b.textContent.trim().toLowerCase();
      return ['next', 'continue', 'proceed', 'save', 'submit', 'create'].some(t => text.includes(t));
    });
    if (btn && !btn.disabled) {
      btn.click();
      await sleep(1500);
      return true;
    }
  }

  // Fallback: find any visible primary button
  const allBtns = Array.from(document.querySelectorAll('button:not([disabled])'));
  const primary = allBtns.find(b => {
    const text = b.textContent.trim().toLowerCase();
    return ['next', 'continue', 'proceed', 'save & next', 'create class'].some(t => text.includes(t));
  });
  if (primary) {
    primary.click();
    await sleep(1500);
    return true;
  }

  return false;
}

// ─── Main Autofill Logic ─────────────────────

async function fillRow(rowData) {
  try {
    const createMode = resolveCreateMode(rowData);
    if (createMode) {
      log(`🔄 Selecting creation type: ${createMode}`, 'info');
      const selected = await openAndSelect('What do you want to create today', createMode);
      if (!selected) throw new Error(`Failed to select creation type: "${createMode}"`);
      await sleep(1000); // Wait for form to switch
    }

    if (createMode === 'Lecture' || createMode === 'Class without Live Lecture' || (!createMode && hasLectureSignals(rowData))) {
      await fillLectureFlow(rowData);
      return;
    }

    if (createMode === 'Contest') {
      await fillContestFlow(rowData);
      return;
    }

    // Fill all mapped fields
    for (const [col, mapping] of Object.entries(fieldMap)) {
      if (!rowData[col]) continue;
      const { selector, type } = mapping;

      if (type === 'dropdown' || type === 'select') {
        const filled = await selectDropdown(selector, rowData[col]);
        if (!filled) throw new Error(`Failed to select "${rowData[col]}" in dropdown "${col}"`);
      } else if (type === 'checkbox') {
        const el = await waitForElement(selector, 3000);
        if (!el) throw new Error(`Could not find checkbox "${col}"`);
        if (rowData[col].toLowerCase() === 'true') el.click();
      } else {
        const filled = await fillField(selector, rowData[col]);
        if (!filled) throw new Error(`Failed to fill field "${col}" with "${rowData[col]}"`);
      }
      log(`✅ Filled "${col}" = "${rowData[col]}"`, 'success');
      await sleep(200);
    }

    // Try to advance the step
    const advanced = await clickNextButton();
    if (advanced) {
      log('➡️ Clicked Next/Continue', 'info');
    } else {
      log('⚠️ Could not find Next button — you may need to click manually', 'warn');
    }
  } catch (err) {
    stopOnError(err.message);
    throw err;
  }
}

async function processQueue() {
  if (!isRunning || currentRowIndex >= csvQueue.length) {
    if (currentRowIndex >= csvQueue.length) {
      log(`🎉 All ${csvQueue.length} classes created!`, 'success');
      isRunning = false;
    }
    return;
  }

  const row = csvQueue[currentRowIndex];
  log(`📝 Processing row ${currentRowIndex + 1} of ${csvQueue.length}: ${JSON.stringify(row)}`, 'info');

  try {
    await fillRow(row);
  } catch (err) {
    log(`❌ Queue execution halted due to error: ${err.message}`, 'error');
    return;
  }

  if (!isRunning) {
    log('⏹️ Autofill process stopped early.', 'warn');
    return;
  }
  currentRowIndex++;

  // Wait for page to settle before next row
  await sleep(2000);
  if (!isRunning) {
    log('⏹️ Autofill process stopped early.', 'warn');
    return;
  }

  // Check if we're back at create-class (after submission) or still on same form
  if (currentRowIndex < csvQueue.length) {
    // Navigate to create new class
    await sleep(1000);
    window.location.href = 'https://www.scaler.com/scm/classes/create-class';
    // Queue will continue after page reload via message
  }
}

// ─── Message Listener ─────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'startMapping') {
    fieldMap = message.currentMap || {};
    pendingMappingColumn = message.column;
    mappingMode = true;
    injectMappingUI();
    const badge = document.getElementById('mapper-column-badge');
    const instruction = document.getElementById('mapper-instruction');
    if (badge) { badge.textContent = message.column; badge.style.display = 'inline'; }
    if (instruction) instruction.textContent = `Click the field for:`;
    sendResponse({ status: 'mapping_started' });
  }

  if (message.action === 'startAutofill') {
    fieldMap = message.fieldMap;
    csvQueue = message.rows;
    currentRowIndex = message.startIndex || 0;
    isRunning = true;
    chrome.runtime.sendMessage({ action: 'autofillStarted' });
    processQueue();
    sendResponse({ status: 'started' });
  }

  if (message.action === 'stopAutofill') {
    isRunning = false;
    log('⏹️ Autofill stopped', 'warn');
    chrome.runtime.sendMessage({ action: 'autofillStopped' });
    sendResponse({ status: 'stopped' });
  }

  if (message.action === 'continueQueue') {
    // Called after page reload to continue processing
    csvQueue = message.rows;
    currentRowIndex = message.startIndex;
    fieldMap = message.fieldMap;
    isRunning = true;
    processQueue();
    sendResponse({ status: 'continuing' });
  }

  return true;
});

// ─── Resume on page load ──────────────────────

window.addEventListener('load', async () => {
  // Check if there's a pending queue to resume
  chrome.storage.local.get(['scalerQueue', 'scalerQueueIndex', 'scalerFieldMap', 'scalerRunning'], (data) => {
    if (data.scalerRunning && data.scalerQueue && data.scalerQueueIndex < data.scalerQueue.length) {
      log(`🔄 Resuming from row ${data.scalerQueueIndex + 1}...`, 'info');
      csvQueue = data.scalerQueue;
      currentRowIndex = data.scalerQueueIndex;
      fieldMap = data.scalerFieldMap || {};
      isRunning = true;
      setTimeout(processQueue, 2500); // Give React time to render
    }
  });
});

// Save state before each navigation
window.addEventListener('beforeunload', () => {
  if (isRunning) {
    chrome.storage.local.set({
      scalerQueue: csvQueue,
      scalerQueueIndex: currentRowIndex,
      scalerFieldMap: fieldMap,
      scalerRunning: true
    });
  }
});

console.log('[Scaler Autofill] Content script loaded ✓');

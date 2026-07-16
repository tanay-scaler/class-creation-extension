# ⚡ Scaler Class Autofill — Chrome Extension

> Bulk-create Scaler SCM classes from a CSV file. Automatically fills the multi-step form for **Lectures**, **Contests**, and **Classes without Live Lectures** — row by row, with live progress logs and auto-resume across page reloads.

---

## ✨ Features

- 📄 **CSV-driven** — one row per class, any column names
- 🗺️ **Visual field mapping** — click fields on the form to link them to CSV columns
- 🎓 **Lecture / Contest / Class without Live Lecture** flows all supported
- 🔄 **Auto-resume** — if the page reloads mid-run, it picks up where it left off
- 📋 **Run history** — logs every run with downloadable `.txt` log files
- ⏹ **Stop / Resume** — pause at any row and restart from that row

---

## 📦 Installation (No build step required)

1. Clone or download this repository:
   ```bash
   git clone https://github.com/YOUR_USERNAME/scaler-autofill.git
   ```

2. Open Chrome and navigate to:
   ```
   chrome://extensions/
   ```

3. Enable **Developer Mode** using the toggle in the top-right corner.

4. Click **"Load unpacked"** and select the `scaler-autofill` folder.

5. The ⚡ icon will appear in your Chrome toolbar — you're ready to go.

> **Note:** You must be logged into [scaler.com](https://www.scaler.com) before using the extension.

---

## 🗂️ CSV Format

Each row in your CSV represents one class. The extension supports three class types, each with its own set of recognized column names.

### Recognized Column Names

| Field | Accepted Column Names |
|---|---|
| **Class type** | `what do you want to create today`, `create type`, `class type` |
| **Topic name** | `topic name`, `topic`, `lecture topic`, `class topic` |
| **Lecture activity** | `lecture activity`, `activity`, `regular/optional`, `session type` |
| **Academy module type** | `academy module type`, `module type`, `module category` |
| **Academy module name** | `academy module name`, `module name`, `module` |
| **Junction number** | `junction number`, `junction`, `junction no`, `junction id` |
| **TA Skill** | `ta skill`, `ta skills`, `skill` |
| **Pre-lecture content** | `pre lecture content`, `pre lecture`, `pre lecture link` |
| **Post-lecture content** | `post lecture content`, `post lecture`, `post lecture link` |
| **Research papers** | `research papers`, `research paper`, `paper link` |
| **Live lecture duration** | `live lecture duration`, `live lecture`, `lecture duration` |
| **Class tag** | `class tag` |
| **Assignment duration** | `assignment duration`, `assignment` |
| **Assignment slug** | `assignment slug id`, `assignment slug` |
| **Homework duration** | `homework duration`, `homework` |
| **Homework slug** | `homework slug id`, `homework slug` |
| **Pre-read duration** | `pre read duration`, `pre read` |
| **Pre-read slug** | `pre read slug id`, `pre read slug` |
| **Case study ID** | `case study id`, `case study`, `case study slug` |
| **Contest ID** | `contest id`, `single contest id`, `group contest id` |
| **Contest duration** | `contest duration`, `duration` |
| **Contest window** | `contest window`, `window` |
| **Contest type** | `contest type`, `contest category`, `type` |
| **Course type** | `course type`, `course_type` |
| **Discussion toggle** | `discussion toggle`, `discussion`, `enable discussion` |
| **Discussion duration** | `discussion duration`, `discussion time` |

> Column names are **case-insensitive** and can be partial matches — e.g., `Topic` matches `topic name`.


## 🚀 How to Use

### Step 1 — Upload CSV

1. Click the ⚡ extension icon in Chrome
2. On the **Setup** tab, drag & drop or click to upload your CSV file
3. You'll see a preview showing row count, column count, and mapped fields
4. Click **"Open Create Class Page"** to open the Scaler SCM form

---

### Step 2 — Map Fields *(optional for Lecture/Contest flows)*

> If your CSV uses the recognized column names from the table above, the extension fills the form automatically — **no mapping needed**. Mapping is for custom column names or additional fields.

1. Go to the **Map Fields** tab
2. Click **"Map"** next to any CSV column
3. A blue **🎯 MAPPING MODE** banner appears at the top of the Scaler page
4. Click the form field you want to link that column to
5. Repeat for all columns you want to map
6. Click **"Done Mapping"** in the banner when finished

> Mappings are **saved automatically** — you only need to map once per field.

---

### Step 3 — Run

1. Go to the **Run** tab
2. Use **"Start from row"** to skip ahead (useful when resuming a failed run)
3. Click **▶ Start Autofill**
4. Watch the live log — every field fill, dropdown selection, and error is shown in real time
5. Click **⏹ Stop** at any time to pause — progress is saved and you can resume from where you left off

---

### Step 4 — History & Logs

- Go to the **⏳ History** tab to see all past runs
- Each run shows its status (`success` / `failed` / `stopped`) and log line count
- Click **📥 Download** to save the full log as a `.txt` file

---

## 🗺️ Project Structure

```
scaler-autofill/
├── manifest.json              # Chrome extension manifest (MV3)
├── background.js              # Service worker — handles messaging & log storage
├── content/
│   └── content.js             # Content script — runs on scaler.com, fills the form
├── popup/
│   ├── popup.html             # Extension popup UI
│   └── popup.js               # Popup logic — CSV parsing, mapping UI, run controls
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

---

## 🛠️ Troubleshooting

| Problem | Solution |
|---|---|
| Fields not filling | The form may have updated — re-map those fields in the Map Fields tab |
| Dropdown not selecting | Ensure the CSV value matches the visible dropdown option text exactly |
| "Could not find Next button" | Click the button manually — the autofill will continue to the next row |
| Extension not responding | Make sure you're logged into Scaler and on the correct page |
| Run stops mid-way | Check the **History** tab log for the specific error, fix the CSV row, and restart from that row |
| Mapping mode not appearing | Make sure the Scaler create-class page is open in the active tab |

---


## 📄 License

MIT — free to use and modify.

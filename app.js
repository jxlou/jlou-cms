/* JLou HTML Content Management System - local, browser-only, no server needed.
   Data is stored in the browser's IndexedDB (large capacity), with a one-time
   migration from the older localStorage store and a localStorage fallback. */
(function () {
  "use strict";

  // ---------- Storage ----------
  const LS_DOCS = "jlou_cms_docs";       // { [id]: {id,title,html,updated} }  (legacy / fallback)
  const LS_LAST = "jlou_cms_last";       // last opened id
  const DB_NAME = "jlou_cms";
  const DB_STORE = "kv";
  const DB_KEY_DOCS = "docs";
  const DB_KEY_TOMBS = "tombstones";     // { [id]: deletedAtMs } - so deletes propagate across devices
  // --- Cloud sync (GitHub Gist) settings, kept per-device in localStorage ---
  const LS_SYNC_TOKEN = "jlou_cms_sync_token";  // GitHub personal access token (gist scope)
  const LS_SYNC_GIST = "jlou_cms_sync_gist";    // gist id holding the shared library
  const LS_SYNC_ON = "jlou_cms_sync_on";        // "1" when auto-sync is enabled
  const LS_SYNC_META = "jlou_cms_sync_meta";    // last successful sync (ms)
  const GIST_FILE = "jlou-cms.json";            // file name inside the gist

  const $ = (sel) => document.querySelector(sel);
  const editor = $("#editor");
  const titleInput = $("#titleInput");
  const docSelect = $("#docSelect");
  const tocList = $("#tocList");
  const tocEmpty = $("#tocEmpty");
  const saveState = $("#saveState");

  let docs = {};            // in-memory source of truth; loaded async at boot
  let tombstones = {};      // { id: deletedAtMs } for deletions, so sync can propagate them
  let currentId = null;
  let dirty = false;
  let _db = null;           // IndexedDB handle (null => fall back to localStorage)
  let applyingRemote = false; // guard: true while merging pulled data, to avoid a sync loop

  // --- IndexedDB helpers (single key/value store holding the whole docs blob) ---
  function idbOpen() {
    return new Promise((resolve, reject) => {
      let req;
      try { req = indexedDB.open(DB_NAME, 1); }
      catch (e) { reject(e); return; }
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  function idbGet(key) {
    return new Promise((resolve, reject) => {
      const tx = _db.transaction(DB_STORE, "readonly");
      const req = tx.objectStore(DB_STORE).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  function idbSet(key, value) {
    return new Promise((resolve, reject) => {
      let tx;
      try { tx = _db.transaction(DB_STORE, "readwrite"); }
      catch (e) { reject(e); return; }
      tx.objectStore(DB_STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error("Transaction aborted (storage full?)"));
    });
  }

  function loadDocsLS() {
    try { return JSON.parse(localStorage.getItem(LS_DOCS)) || {}; }
    catch { return {}; }
  }

  // Persist the whole library. Returns a Promise (resolves on save, rejects on failure).
  function persist() {
    if (_db) {
      // Deep-copy so the stored structured clone can't be mutated later mid-write.
      return idbSet(DB_KEY_DOCS, JSON.parse(JSON.stringify(docs)));
    }
    return new Promise((resolve, reject) => {
      try { localStorage.setItem(LS_DOCS, JSON.stringify(docs)); resolve(); }
      catch (e) { reject(e); }
    });
  }
  // Fire-and-forget save used by everyday edits; surfaces errors without blocking.
  function persistSafe() {
    persist().catch((e) => {
      console.error("Save failed", e);
      alert("Could not save your changes to storage: " +
            (e && e.name ? e.name : (e && e.message ? e.message : e)) +
            ".\nYour latest change may not be persisted.");
    });
    scheduleAutoSync();
  }

  // Persist the deletion tombstones (small map) alongside the docs blob.
  function persistTombs() {
    try {
      if (_db) return idbSet(DB_KEY_TOMBS, JSON.parse(JSON.stringify(tombstones)));
      localStorage.setItem(DB_KEY_TOMBS, JSON.stringify(tombstones));
    } catch (e) { console.error("Tombstone save failed", e); }
    return Promise.resolve();
  }
  // Record that a document was deleted, so the deletion syncs to other devices.
  function recordTombstone(id) {
    tombstones[id] = Date.now();
    persistTombs();
  }
  function uid() {
    return "d" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  // ---------- Document lifecycle ----------
  function welcomeHtml() {
    return "<h1>Welcome to JLou Content Manager</h1>" +
      "<p>This is a local content system. Everything is saved in your browser.</p>" +
      "<h2>Quick start</h2>" +
      "<ul><li>Click <b>+ New</b> to create a document.</li>" +
      "<li>Use <b>H1 / H2</b> to add titles - they appear in the Contents panel on the left.</li>" +
      "<li>Paste an image with Ctrl+V, or use the <b>Image</b> / <b>Attach</b> buttons.</li>" +
      "<li>Use <b>&lt;/&gt; Code</b> for a code snippet block.</li>" +
      "<li>Use <b>Import&hellip;</b> to load a <b>.txt</b>, <b>.html</b>, or <b>Word (.docx)</b> file as a new document. To bring in an HTML report whose images sit in a sibling folder (e.g. <code>./images/</code>), use <b>HTML folder (.html + images)</b> and pick the whole folder - the images are embedded automatically.</li>" +
      "<li>Use <b>Backup</b> / <b>Restore</b> to save or load your whole library as a single <code>.json</code> file (great for moving between browsers or origins).</li>" +
      "<li>Press <b>Ctrl+F</b> to search <b>within the open page</b> - matches are highlighted; press <b>Enter</b> / <b>Shift+Enter</b> (or the arrows) to jump between them, <b>Esc</b> to close.</li></ul>" +
      "<h2>Bulk rename (Library &rarr; Bulk rename&hellip;)</h2>" +
      "<ul>" +
      "<li><b>Find (pattern)</b> + <b>Replace with</b> fields.</li>" +
      "<li>Three options:" +
        "<ul>" +
        "<li><b>Regular expression</b> (on by default) - full regex; use groups like <code>$1</code> in the replacement.</li>" +
        "<li><b>Case sensitive</b> - off by default.</li>" +
        "<li><b>Match start of title only</b> - auto-prepends <code>^</code>.</li>" +
        "</ul></li>" +
      "<li>Turn regex <b>off</b> to match plain text, where <code>*</code> and <code>?</code> act as wildcards.</li>" +
      "<li><b>Live preview</b> lists every matched title as <code>old &rarr; new</code> (strikethrough &rarr; bold) with a running count. The <b>Rename</b> button stays disabled until there's a real change, and invalid patterns show an inline error.</li>" +
      "</ul>" +
      "<p>It's pre-filled with the number-prefix case (<code>^\\d+[a-zA-Z]?\\s*[.\\-)]\\s*</code> &rarr; <code>nzpost.</code>), so that task works out of the box - but now you can match anything, e.g.:</p>" +
      "<ul>" +
      "<li>Find <code>teamsite</code> &rarr; Replace <code>TeamSite</code> (case-insensitive, anywhere).</li>" +
      "<li>Regex <code>\\s*\\(\\d+\\)$</code> &rarr; <i>(empty)</i> to strip trailing <code>(1)</code>, <code>(2)</code> duplicates.</li>" +
      "</ul>" +
      "<h2>Where is my content stored?</h2>" +
      "<p>Your documents are <b>not</b> saved in the app folder. They live in this browser's <b>IndexedDB</b> database <code>jlou_cms</code> (the last-opened id is kept in <code>localStorage</code> under <code>jlou_cms_last</code>). Images are embedded as base64.</p>" +
      "<ul>" +
      "<li><b>Much bigger capacity.</b> IndexedDB typically allows <b>hundreds of MB</b> (often a share of free disk), so large libraries with many embedded images fit comfortably - the old ~5 MB localStorage limit no longer applies.</li>" +
      "<li><b>Automatic upgrade.</b> Any documents from the previous localStorage version are migrated into IndexedDB the first time you open this version.</li>" +
      "<li><b>Per browser &amp; per address.</b> Content created in Edge will not appear in Chrome, and opening via <code>file://</code> vs <code>http://localhost</code> can be separate stores too.</li>" +
      "<li><b>Clearing browsing data</b> (\"cookies and site data\") for this page will <b>erase</b> your documents.</li>" +
      "<li>To move content between browsers or keep a real file, use <b>Backup</b> to download all documents as one <code>.json</code> file, then <b>Restore</b> it in the other browser (or use <b>Export .html</b> per document).</li>" +
      "</ul>" +
      "<h2>What's stored, and where</h2>" +
      "<p>All your documents are saved as <b>one JSON blob</b> in IndexedDB:</p>" +
      "<ul>" +
      "<li>IndexedDB DB <code>jlou_cms</code>, store <code>kv</code>, key <code>docs</code> &rarr; every document <code>{id, title, html, updated}</code> (including pasted/embedded images as base64)</li>" +
      "<li><code>localStorage.jlou_cms_last</code> &rarr; the last-opened document id</li>" +
      "</ul>" +
      "<p>The <b>project folder</b> only holds the <i>app itself</i> (code), never your content:</p>" +
      '<pre class="code-block"><code>index.html, app.js, styles.css, mammoth.browser.min.js, sample-note.txt</code></pre>' +
      "<h2>Where the database physically lives (on disk)</h2>" +
      "<p>The browser keeps it in its own profile directory - not human-readable, don't edit by hand:</p>" +
      "<ul>" +
      "<li><b>Edge:</b> <code>%LOCALAPPDATA%\\Microsoft\\Edge\\User Data\\Default\\IndexedDB</code></li>" +
      "<li><b>Chrome:</b> <code>%LOCALAPPDATA%\\Google\\Chrome\\User Data\\Default\\IndexedDB</code></li>" +
      "</ul>" +
      '<pre class="code-block"><code>console.log("Hello from a code block");</code></pre>' +
      "<h2>Cloud sync &amp; access anywhere (\u2601 Sync)</h2>" +
      "<p>Use <b>\u2601 Sync</b> to keep your whole library in a <b>private GitHub Gist</b> so you can open it on any device - including your phone - from the same web address.</p>" +
      "<ul>" +
      "<li><b>One-time setup:</b> create a GitHub token with only the <code>gist</code> scope, open <b>\u2601 Sync</b>, paste the token, then click <b>Create new private gist</b>. Tick <b>Auto-sync</b>.</li>" +
      "<li><b>On another device:</b> open the same site, click <b>\u2601 Sync</b>, paste the <b>same token</b> and the <b>Gist ID</b> shown on the first device, Save, then <b>Sync now</b>.</li>" +
      "<li><b>How it merges:</b> the newest edit of each document wins (last-write-wins by time), and deletions are remembered so they don't come back. Sync runs automatically after changes, on startup, and when you switch back to the tab.</li>" +
      "<li><b>Privacy:</b> the token is stored only in this browser (never in the app files); the gist is private. Data still travels to your own GitHub account.</li>" +
      "</ul>" +
      "<h2>Version history</h2>" +
      "<ul class=\"version-history\">" +
      "<li><b>v38</b> - New <b>▦ Table</b> button (pick rows/columns + optional header row) and a <b>🔎 Find</b> button in the toolbar so you can search within the current page - handy on mobile where Ctrl+F isn't available.</li>" +
      "<li><b>v37</b> - Fixed: editing the Welcome/Help page no longer gets wiped when you click <b>Help</b> again - your edits are kept, and the built-in Help only refreshes if you haven't changed it.</li>" +
      "<li><b>v36</b> - Cloud sync now handles <b>large libraries</b> (many MB with images): data is split into chunks and reassembled reliably, working around GitHub's gist size limits.</li>" +
      "<li><b>v35</b> - Cloud sync now shows a clear <b>toast</b> on every sync/create, times out instead of hanging, and can't get stuck - so you always see success or the exact error.</li>" +
      "<li><b>v34</b> - New <b>\u2601 Cloud sync</b>: keep your library in a private GitHub Gist and access it from any device (phone included), with automatic last-write-wins merging and delete tracking.</li>" +
      "<li><b>v33</b> - New <b>Font size</b> button (A▾) in the toolbar with a size menu (Small → Huge), applied as inline styles that persist on save/export.</li>" +
      "<li><b>v32</b> - New <b>Text colour</b> (A) and <b>Highlight</b> buttons in the toolbar, each with a swatch palette plus a custom-colour picker.</li>" +
      "<li><b>v31</b> - Version history list set to 8pt with a light-grey background panel.</li>" +
      "<li><b>v30</b> - Reduced the font size of this Version history list so it's more compact.</li>" +
      "<li><b>v29</b> - Added a <b>Bulk rename</b> how-to section to this Help page.</li>" +
      "<li><b>v28</b> - Bulk rename is now a full <b>find &amp; replace dialog</b>: match titles by plain text, wildcards, or regex, with a live preview of every before\u2192after change before you apply.</li>" +
      "<li><b>v27</b> - Library gains a <b>Bulk rename\u2026</b> button that replaces a leading number prefix in titles (e.g. \u201c80. \u201d) with a text prefix you choose, such as \u201cnzpost.\u201d, across all documents at once.</li>" +
      "<li><b>v26</b> - The Library now stays open when you click a document (it just loads and highlights it); close it manually with \u2715 or the Library button.</li>" +
      "<li><b>v25</b> - In-page find now has a <b>\u2630 list button</b> that shows every match with a context snippet in a popup - click any row to jump straight to it.</li>" +
      "<li><b>v24</b> - In-page search: press <b>Ctrl+F</b> while viewing a document to find and highlight text within it, with Enter/Shift+Enter to step through matches.</li>" +
      "<li><b>v23</b> - Document dropdown: titles that start with a number now come first in true numeric order (1, 2, 10...), followed by the rest alphabetically.</li>" +
      "<li><b>v22</b> - The document dropdown is now sorted alphabetically by title (A-Z, natural number order) instead of by last-updated.</li>" +
      "<li><b>v21</b> - Storage moved from localStorage (~5 MB) to <b>IndexedDB</b> (hundreds of MB), so large imports like the 48-note pack now restore without hitting the storage limit. Existing docs are migrated automatically.</li>" +
      "<li><b>v20</b> - Restore now reports the exact reason if it fails (invalid JSON, storage full, etc.) instead of failing silently.</li>" +
      "<li><b>v19</b> - Buttons restyled with a tactile look; New (blue) and Delete (red) now stand out as primary/danger actions.</li>" +
      "<li><b>v18</b> - Version badge added to the top bar (click it to jump here); Version history section.</li>" +
      "<li><b>v16</b> - Distinct colours for the document list (amber), Import (green) and Search (blue).</li>" +
      "<li><b>v15</b> - Toolbar re-arranged: Import moved next to the document list; document list given its own colour.</li>" +
      "<li><b>v14</b> - Import Lucidchart (and any) <b>SVG</b> diagrams inline: sanitized, scalable and fully offline.</li>" +
      "<li><b>v13</b> - Inline table-of-contents from an imported report is hidden (mirrored in the left Contents panel).</li>" +
      "<li><b>v12</b> - Imported reports that ship their own TOC now drive the left Contents panel.</li>" +
      "<li><b>v11</b> - Imported HTML keeps its original CSS (scoped so it can't affect the app UI).</li>" +
      "<li><b>v10</b> - New <b>HTML folder</b> import: embeds images from a sibling <code>images/</code> folder as base64.</li>" +
      "<li><b>v9</b> - <b>Backup</b> / <b>Restore</b> the whole library as a single <code>.json</code> file.</li>" +
      "<li><b>v8</b> - <b>Library</b> storage manager, draggable splitter and filter box; find/highlight navigation; Word (.docx) import.</li>" +
      "</ul>";
  }

  // Open the Welcome/Help page. Auto-refresh the built-in content only when the page
  // is untouched; if the user has edited it, keep their version (never overwrite).
  function helpHash(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return String(h);
  }
  function showHelp() {
    saveCurrent();
    let existing = Object.values(docs).find((d) => d.help) ||
                   Object.values(docs).find((d) => d.title === "Welcome");
    if (!existing) {
      const id = uid();
      const gen = welcomeHtml();
      docs[id] = { id, title: "Welcome", html: gen, updated: Date.now(), help: true, helpHash: helpHash(gen) };
      persistSafe();
      refreshDocSelect();
      openDoc(id);
      return;
    }
    existing.help = true; // mark it so we can find it by identity, not by title
    const gen = welcomeHtml();
    // Refresh to the newest built-in Help only if the stored content is exactly what we
    // last generated (i.e. the user hasn't modified it). Otherwise, preserve their edits.
    if (existing.helpHash && helpHash(existing.html) === existing.helpHash) {
      existing.html = gen;
      existing.helpHash = helpHash(gen);
      existing.updated = Date.now();
      persistSafe();
    }
    openDoc(existing.id);
  }

  function newDoc(title, html) {
    const id = uid();
    docs[id] = {
      id,
      title: title || "Untitled document",
      html: html || "<h1>New title</h1><p>Start writing here...</p>",
      updated: Date.now(),
    };
    persistSafe();
    refreshDocSelect();
    openDoc(id);
  }

  function openDoc(id) {
    if (!docs[id]) return;
    findMarks = []; findIdx = -1; activeFindTerm = ""; hideFindBar();
    currentId = id;
    localStorage.setItem(LS_LAST, id);
    titleInput.value = docs[id].title;
    editor.innerHTML = docs[id].html;
    docSelect.value = id;
    buildToc();
    markClean();
  }

  function saveCurrent() {
    if (!currentId || !docs[currentId]) return;
    docs[currentId].title = titleInput.value.trim() || "Untitled document";
    docs[currentId].html = cleanEditorHtml();
    docs[currentId].updated = Date.now();
    persistSafe();
    refreshDocSelect(true);
    markClean();
  }

  function deleteCurrent() {
    if (!currentId) return;
    if (!confirm("Delete \"" + docs[currentId].title + "\"? This cannot be undone.")) return;
    const delId = currentId;
    delete docs[currentId];
    recordTombstone(delId);
    persistSafe();
    const ids = Object.keys(docs);
    refreshDocSelect();
    if (ids.length) openDoc(ids[0]);
    else newDoc();
  }

  function renameCurrent() {
    if (!currentId) return;
    const name = prompt("Rename document:", docs[currentId].title);
    if (name === null) return;
    titleInput.value = name.trim() || "Untitled document";
    saveCurrent();
  }

  function refreshDocSelect(keepSelection) {
    const sel = keepSelection ? docSelect.value : null;
    docSelect.innerHTML = "";
    const leadNum = (t) => {
      const m = (t || "").match(/^\s*(\d+(?:\.\d+)?)/);
      return m ? parseFloat(m[1]) : null;
    };
    Object.values(docs)
      .sort((a, b) => {
        const na = leadNum(a.title), nb = leadNum(b.title);
        // Titles that start with a number come first, ordered numerically.
        if (na !== null && nb !== null) {
          if (na !== nb) return na - nb;
        } else if (na !== null) {
          return -1;
        } else if (nb !== null) {
          return 1;
        }
        return (a.title || "").localeCompare(b.title || "", undefined, { numeric: true, sensitivity: "base" });
      })
      .forEach((d) => {
        const opt = document.createElement("option");
        opt.value = d.id;
        opt.textContent = d.title;
        docSelect.appendChild(opt);
      });
    if (sel) docSelect.value = sel;
    else if (currentId) docSelect.value = currentId;
  }

  // ---------- Dirty tracking + autosave ----------
  let saveTimer = null;
  function markDirty() {
    dirty = true;
    saveState.textContent = "Unsaved...";
    saveState.classList.add("dirty");
    buildToc();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveCurrent, 800); // autosave
  }
  function markClean() {
    dirty = false;
    saveState.textContent = "Saved";
    saveState.classList.remove("dirty");
  }

  // ---------- Table of contents (req #2) ----------
  function slug(text, i) {
    return "h_" + i + "_" + (text || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40);
  }

  // Detect a TOC that came with an imported document: a nav/"contents" container
  // holding at least two in-page (#anchor) links. Returns {items, el} or null.
  function findEmbeddedToc() {
    const scope = editor.querySelector(".imported-html");
    if (!scope) return null;
    let candidates;
    try {
      candidates = Array.prototype.slice.call(scope.querySelectorAll(
        'nav, [class*="toc" i], [id*="toc" i], [class*="contents" i], [id*="contents" i]'
      ));
    } catch (e) {
      candidates = Array.prototype.slice.call(scope.querySelectorAll("nav"));
    }
    const matches = [];
    for (const c of candidates) {
      const links = Array.prototype.slice.call(c.querySelectorAll('a[href^="#"]'));
      const items = [];
      links.forEach((a) => {
        const href = a.getAttribute("href") || "";
        const id = decodeURIComponent(href.slice(1));
        const text = (a.textContent || "").replace(/\s+/g, " ").trim();
        if (!id || !text) return;
        // nesting level = number of ancestor lists between the link and the container
        let level = 0, node = a.parentElement;
        while (node && node !== c) {
          if (node.tagName === "UL" || node.tagName === "OL") level++;
          node = node.parentElement;
        }
        items.push({ text: text, targetId: id, level: Math.max(level, 1) });
      });
      if (items.length >= 2) {
        matches.push({ items: items, el: c, size: c.getElementsByTagName("*").length });
      }
    }
    if (!matches.length) return null;
    // Prefer the most compact container (a dedicated TOC), not a wrapper around the whole doc.
    matches.sort((a, b) => a.size - b.size);
    return matches[0];
  }

  function buildToc() {
    tocList.innerHTML = "";

    // Prefer a TOC that shipped inside an imported document.
    const embedded = findEmbeddedToc();
    if (embedded) {
      tocEmpty.style.display = "none";
      // Hide the inline TOC in the body - the left panel replaces it.
      if (embedded.el && !embedded.el.classList.contains("cms-toc-hidden")) {
        embedded.el.classList.add("cms-toc-hidden");
      }
      embedded.items.forEach((item) => {
        const li = document.createElement("li");
        const a = document.createElement("a");
        a.textContent = item.text;
        a.href = "#" + item.targetId;
        a.className = "lvl-" + Math.min(item.level, 2);
        a.addEventListener("click", (e) => {
          e.preventDefault();
          let target = null;
          try { target = editor.querySelector("#" + (window.CSS && CSS.escape ? CSS.escape(item.targetId) : item.targetId)); }
          catch (err) { target = null; }
          if (!target) {
            target = [].slice.call(editor.querySelectorAll("[id]"))
              .find((el) => el.id === item.targetId) || null;
          }
          if (target) { target.scrollIntoView({ behavior: "smooth", block: "start" }); setActive(a); }
        });
        li.appendChild(a);
        tocList.appendChild(li);
      });
      return;
    }

    const heads = editor.querySelectorAll("h1, h2");
    if (!heads.length) {
      tocEmpty.style.display = "block";
      return;
    }
    tocEmpty.style.display = "none";
    heads.forEach((h, i) => {
      if (!h.id) h.id = slug(h.textContent, i);
      const li = document.createElement("li");
      const a = document.createElement("a");
      a.textContent = h.textContent || "(untitled)";
      a.href = "#" + h.id;
      a.className = h.tagName === "H2" ? "lvl-2" : "lvl-1";
      a.addEventListener("click", (e) => {
        e.preventDefault();
        h.scrollIntoView({ behavior: "smooth", block: "start" });
        setActive(a);
      });
      li.appendChild(a);
      tocList.appendChild(li);
    });
  }
  function setActive(a) {
    tocList.querySelectorAll("a").forEach((x) => x.classList.remove("active"));
    if (a) a.classList.add("active");
  }
  // highlight active header while scrolling
  editor.addEventListener("scroll", () => {
    const heads = [...editor.querySelectorAll("h1, h2")];
    let cur = null;
    const top = editor.scrollTop + 20;
    for (const h of heads) {
      if (h.offsetTop <= top) cur = h;
    }
    if (cur) {
      const link = tocList.querySelector('a[href="#' + cur.id + '"]');
      if (link) setActive(link);
    }
  });

  // ---------- Formatting commands (req #4, #5) ----------
  function exec(cmd, btn) {
    editor.focus();
    switch (cmd) {
      case "h1": formatBlock("H1"); break;
      case "h2": formatBlock("H2"); break;
      case "p":  formatBlock("P");  break;
      case "bold": document.execCommand("bold"); break;
      case "italic": document.execCommand("italic"); break;
      case "forecolor": openColorPalette("fore", btn); return;
      case "hilite": openColorPalette("hilite", btn); return;
      case "fontsize": openFontSizePalette(btn); return;
      case "ul": document.execCommand("insertUnorderedList"); break;
      case "table": openTablePalette(btn); return;
      case "code": insertCodeBlock(); break;
      case "image": pickFile("image/*,.svg,image/svg+xml", insertDiagramFile); break;
      case "attach": pickFile("", insertAttachmentFromFile); break;
      case "find": openFind(); return;
    }
    markDirty();
  }

  // ----- Text & highlight colour -----
  let colorPop = null, savedColorRange = null;
  const FORE_SWATCHES = ["#000000", "#374151", "#64748b", "#e11d48", "#f97316", "#eab308",
    "#16a34a", "#0ea5e9", "#2563eb", "#7c3aed", "#db2777", "#ffffff"];
  const HILITE_SWATCHES = ["#fef08a", "#fde68a", "#bbf7d0", "#bae6fd", "#c7d2fe", "#fbcfe8",
    "#fed7aa", "#e2e8f0", "#fecaca", "#d9f99d"];

  function saveColorSel() {
    const s = window.getSelection();
    if (s && s.rangeCount && editor.contains(s.anchorNode)) savedColorRange = s.getRangeAt(0).cloneRange();
  }
  function restoreColorSel() {
    if (!savedColorRange) return;
    const s = window.getSelection();
    s.removeAllRanges();
    s.addRange(savedColorRange);
  }
  function closeColorPalette() {
    if (colorPop) { colorPop.remove(); colorPop = null; document.removeEventListener("mousedown", outsideCloseColor); }
  }
  function outsideCloseColor(e) { if (colorPop && !colorPop.contains(e.target)) closeColorPalette(); }

  function openColorPalette(kind, anchor) {
    saveColorSel();
    if (colorPop) { closeColorPalette(); return; }
    const list = (kind === "hilite") ? HILITE_SWATCHES : FORE_SWATCHES;
    colorPop = document.createElement("div");
    colorPop.className = "color-pop";
    colorPop.innerHTML =
      '<div class="color-grid">' +
      list.map((c) => '<button type="button" class="color-sw" data-c="' + c +
        '" style="background:' + c + '" title="' + c + '"></button>').join("") +
      '</div>' +
      '<div class="color-actions">' +
        '<label class="color-custom">Custom <input type="color" class="color-input" value="' +
          (kind === "hilite" ? "#ffff00" : "#000000") + '" /></label>' +
        '<button type="button" class="color-none" data-c="__none__">' +
          (kind === "hilite" ? "No highlight" : "Default") + '</button>' +
      '</div>';
    document.body.appendChild(colorPop);
    const r = anchor.getBoundingClientRect();
    const w = colorPop.offsetWidth || 200;
    colorPop.style.left = Math.round(Math.min(r.left, window.innerWidth - w - 8)) + "px";
    colorPop.style.top = Math.round(r.bottom + 4) + "px";

    // Don't let clicks in the popup steal the editor selection (except the native input).
    colorPop.addEventListener("mousedown", (e) => {
      if (!e.target.closest(".color-input")) e.preventDefault();
    });
    colorPop.addEventListener("click", (e) => {
      const sw = e.target.closest("[data-c]");
      if (sw) { applyColor(kind, sw.getAttribute("data-c")); closeColorPalette(); }
    });
    const inp = colorPop.querySelector(".color-input");
    inp.addEventListener("input", () => applyColor(kind, inp.value));
    inp.addEventListener("change", () => { applyColor(kind, inp.value); closeColorPalette(); });
    setTimeout(() => document.addEventListener("mousedown", outsideCloseColor), 0);
  }

  function applyColor(kind, color) {
    editor.focus();
    restoreColorSel();
    try { document.execCommand("styleWithCSS", false, true); } catch (_) {}
    if (kind === "hilite") {
      const c = (color === "__none__") ? "transparent" : color;
      if (!document.execCommand("hiliteColor", false, c)) document.execCommand("backColor", false, c);
      if (color !== "__none__") { const b = $("#hiliteBar"); if (b) b.style.background = c; }
    } else {
      const c = (color === "__none__") ? "#0f172a" : color;
      document.execCommand("foreColor", false, c);
      if (color !== "__none__") { const b = $("#foreBar"); if (b) b.style.background = c; }
    }
    try { document.execCommand("styleWithCSS", false, false); } catch (_) {}
    markDirty();
  }

  // ----- Font size -----
  let fsPop = null;
  const FONT_SIZES = [
    ["Small", "12px"], ["Normal", "16px"], ["Medium", "19px"],
    ["Large", "24px"], ["X-Large", "30px"], ["Huge", "40px"]
  ];
  function closeFontSizePalette() {
    if (fsPop) { fsPop.remove(); fsPop = null; document.removeEventListener("mousedown", outsideCloseFs); }
  }
  function outsideCloseFs(e) { if (fsPop && !fsPop.contains(e.target)) closeFontSizePalette(); }

  function openFontSizePalette(anchor) {
    saveColorSel();
    if (fsPop) { closeFontSizePalette(); return; }
    fsPop = document.createElement("div");
    fsPop.className = "color-pop fs-pop";
    fsPop.innerHTML =
      '<div class="fs-menu">' +
      FONT_SIZES.map((s) => '<button type="button" class="fs-item" data-size="' + s[1] +
        '" style="font-size:' + s[1] + '">' + s[0] + ' <span class="fs-px">' + s[1] + '</span></button>').join("") +
      '</div>';
    document.body.appendChild(fsPop);
    const r = anchor.getBoundingClientRect();
    const w = fsPop.offsetWidth || 160;
    fsPop.style.left = Math.round(Math.min(r.left, window.innerWidth - w - 8)) + "px";
    fsPop.style.top = Math.round(r.bottom + 4) + "px";
    fsPop.addEventListener("mousedown", (e) => e.preventDefault());
    fsPop.addEventListener("click", (e) => {
      const it = e.target.closest("[data-size]");
      if (it) { applyFontSize(it.getAttribute("data-size")); closeFontSizePalette(); }
    });
    setTimeout(() => document.addEventListener("mousedown", outsideCloseFs), 0);
  }

  function applyFontSize(px) {
    editor.focus();
    restoreColorSel();
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || sel.isCollapsed || !editor.contains(sel.anchorNode)) return;
    // Use the fontSize=7 hack, then convert the generated <font> tags to inline-styled spans.
    document.execCommand("fontSize", false, "7");
    editor.querySelectorAll('font[size="7"]').forEach((f) => {
      const span = document.createElement("span");
      span.style.fontSize = px;
      while (f.firstChild) span.appendChild(f.firstChild);
      f.replaceWith(span);
    });
    markDirty();
  }

  // ----- Insert table -----
  let tablePop = null;
  function closeTablePalette() {
    if (tablePop) { tablePop.remove(); tablePop = null; document.removeEventListener("mousedown", outsideCloseTable); }
  }
  function outsideCloseTable(e) { if (tablePop && !tablePop.contains(e.target)) closeTablePalette(); }

  function openTablePalette(anchor) {
    saveColorSel();
    if (tablePop) { closeTablePalette(); return; }
    tablePop = document.createElement("div");
    tablePop.className = "color-pop table-pop";
    tablePop.innerHTML =
      '<div class="tp-row"><label>Rows</label>' +
      '<input type="number" id="tpRows" min="1" max="50" value="3" /></div>' +
      '<div class="tp-row"><label>Columns</label>' +
      '<input type="number" id="tpCols" min="1" max="20" value="3" /></div>' +
      '<label class="tp-check"><input type="checkbox" id="tpHead" checked /> Header row</label>' +
      '<button type="button" id="tpInsert" class="tp-insert">Insert table</button>';
    document.body.appendChild(tablePop);
    const r = anchor.getBoundingClientRect();
    const w = tablePop.offsetWidth || 200;
    tablePop.style.left = Math.round(Math.min(r.left, window.innerWidth - w - 8)) + "px";
    tablePop.style.top = Math.round(r.bottom + 4) + "px";
    tablePop.querySelector("#tpInsert").addEventListener("click", () => {
      const rows = Math.max(1, Math.min(50, parseInt(tablePop.querySelector("#tpRows").value, 10) || 1));
      const cols = Math.max(1, Math.min(20, parseInt(tablePop.querySelector("#tpCols").value, 10) || 1));
      const header = tablePop.querySelector("#tpHead").checked;
      closeTablePalette();
      insertTable(rows, cols, header);
    });
    setTimeout(() => document.addEventListener("mousedown", outsideCloseTable), 0);
    setTimeout(() => { const f = tablePop && tablePop.querySelector("#tpRows"); if (f) f.focus(); }, 0);
  }

  function insertTable(rows, cols, header) {
    let html = '<table class="doc-table"><tbody>';
    let bodyRows = rows;
    if (header) {
      html += "<tr>";
      for (let c = 0; c < cols; c++) html += "<th><br></th>";
      html += "</tr>";
      bodyRows = Math.max(0, rows - 1);
    }
    for (let r = 0; r < bodyRows; r++) {
      html += "<tr>";
      for (let c = 0; c < cols; c++) html += "<td><br></td>";
      html += "</tr>";
    }
    html += "</tbody></table><p><br></p>";

    editor.focus();
    restoreColorSel();
    insertHtmlAtCaret(html);
    // Place the caret in the first cell so the user can start typing right away.
    const tables = editor.querySelectorAll("table.doc-table");
    const last = tables[tables.length - 1];
    if (last) {
      const firstCell = last.querySelector("th,td");
      if (firstCell) placeCaretInside(firstCell);
    }
    markDirty();
  }
  function pickFile(accept, cb) {
    const inp = document.createElement("input");
    inp.type = "file";
    if (accept) inp.accept = accept;
    inp.style.position = "fixed";
    inp.style.left = "-9999px";
    document.body.appendChild(inp);
    inp.addEventListener("change", () => {
      if (inp.files && inp.files[0]) cb(inp.files[0]);
      document.body.removeChild(inp);
    });
    inp.click();
  }

  // Folder picker: returns the full FileList (with webkitRelativePath) of the chosen directory.
  function pickDir(cb) {
    const inp = document.createElement("input");
    inp.type = "file";
    inp.webkitdirectory = true;
    inp.setAttribute("webkitdirectory", "");
    inp.setAttribute("directory", "");
    inp.multiple = true;
    inp.style.position = "fixed";
    inp.style.left = "-9999px";
    document.body.appendChild(inp);
    inp.addEventListener("change", () => {
      if (inp.files && inp.files.length) cb(inp.files);
      document.body.removeChild(inp);
    });
    inp.click();
  }

  function formatBlock(tag) {
    // execCommand formatBlock needs <TAG> in some browsers
    try { document.execCommand("formatBlock", false, tag); }
    catch { document.execCommand("formatBlock", false, "<" + tag + ">"); }
  }

  function insertCodeBlock() {
    const sel = window.getSelection();
    const selected = sel && sel.rangeCount ? sel.toString() : "";
    const pre = document.createElement("pre");
    pre.className = "code-block";
    const code = document.createElement("code");
    code.textContent = selected || "// your code here";
    pre.appendChild(code);

    if (sel && sel.rangeCount) {
      const range = sel.getRangeAt(0);
      range.deleteContents();
      range.insertNode(pre);
      // add an empty paragraph after so user can escape the code block
      const after = document.createElement("p");
      after.innerHTML = "<br>";
      pre.after(after);
      placeCaretInside(code);
    } else {
      editor.appendChild(pre);
    }
  }

  function placeCaretInside(node) {
    const range = document.createRange();
    range.selectNodeContents(node);
    range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  // ---------- Images & attachments (req #3) ----------
  function insertImageFromFile(file) {
    const reader = new FileReader();
    reader.onload = () => {
      insertHtmlAtCaret('<img src="' + reader.result + '" alt="' + escapeAttr(file.name) + '">');
      markDirty();
    };
    reader.readAsDataURL(file);
  }

  function isSvgFile(file) {
    return /svg/i.test(file.type) || /\.svg$/i.test(file.name || "");
  }

  // Sanitize SVG markup: strip scripts, event handlers and javascript: refs.
  // Returns the cleaned <svg> element, or null if it isn't valid SVG.
  function sanitizeSvgMarkup(svgText) {
    let svg = null;
    try {
      const doc = new DOMParser().parseFromString(svgText, "image/svg+xml");
      if (!doc.querySelector("parsererror")) svg = doc.querySelector("svg");
    } catch (e) { svg = null; }
    if (!svg) {
      const doc2 = new DOMParser().parseFromString(svgText, "text/html");
      svg = doc2.querySelector("svg");
    }
    if (!svg) return null;
    svg.querySelectorAll("script,foreignObject").forEach((el) => el.remove());
    const nodes = [svg].concat(Array.prototype.slice.call(svg.querySelectorAll("*")));
    nodes.forEach((el) => {
      Array.prototype.slice.call(el.attributes).forEach((attr) => {
        const n = attr.name.toLowerCase();
        const v = (attr.value || "").trim().toLowerCase();
        if (n.indexOf("on") === 0) el.removeAttribute(attr.name);
        else if ((n === "href" || n === "xlink:href") && v.indexOf("javascript:") === 0) el.removeAttribute(attr.name);
      });
    });
    // Make it responsive: keep aspect ratio, fit the column width.
    if (!svg.getAttribute("viewBox")) {
      const w = parseFloat(svg.getAttribute("width")) || 0;
      const h = parseFloat(svg.getAttribute("height")) || 0;
      if (w && h) svg.setAttribute("viewBox", "0 0 " + w + " " + h);
    }
    svg.removeAttribute("width");
    svg.removeAttribute("height");
    svg.setAttribute("style", "max-width:100%;height:auto;" + (svg.getAttribute("style") || ""));
    return svg;
  }

  // Insert a Lucidchart (or any) SVG diagram inline: crisp, scalable, fully offline.
  function insertSvgFromFile(file) {
    const reader = new FileReader();
    reader.onload = () => {
      const svg = sanitizeSvgMarkup(String(reader.result));
      if (!svg) { insertImageFromFile(file); return; } // fallback: embed as <img>
      const markup = new XMLSerializer().serializeToString(svg);
      insertHtmlAtCaret(
        '<figure class="svg-embed" contenteditable="false">' + markup + "</figure><p><br></p>"
      );
      markDirty();
    };
    reader.readAsText(file);
  }

  // Route a file to the right inserter: SVG -> inline vector, other images -> <img>.
  function insertDiagramFile(file) {
    if (isSvgFile(file)) insertSvgFromFile(file);
    else insertImageFromFile(file);
  }

  function insertAttachmentFromFile(file) {
    const reader = new FileReader();
    reader.onload = () => {
      const a =
        '<a class="attachment" href="' + reader.result +
        '" download="' + escapeAttr(file.name) + '">📎 ' + escapeHtml(file.name) +
        ' <small>(' + formatBytes(file.size) + ")</small></a>&nbsp;";
      insertHtmlAtCaret(a);
      markDirty();
    };
    reader.readAsDataURL(file);
  }

  // paste image directly (req #3)
  editor.addEventListener("paste", (e) => {
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (const it of items) {
      if (it.type && it.type.indexOf("image") === 0) {
        e.preventDefault();
        const file = it.getAsFile();
        if (file) insertImageFromFile(file);
        return;
      }
    }
  });

  // drag & drop files
  editor.addEventListener("dragover", (e) => e.preventDefault());
  editor.addEventListener("drop", (e) => {
    if (!e.dataTransfer || !e.dataTransfer.files.length) return;
    e.preventDefault();
    [...e.dataTransfer.files].forEach((f) => {
      if (f.type.indexOf("image") === 0 || isSvgFile(f)) insertDiagramFile(f);
      else insertAttachmentFromFile(f);
    });
  });

  function insertHtmlAtCaret(html) {
    editor.focus();
    const sel = window.getSelection();
    if (sel && sel.rangeCount) {
      const range = sel.getRangeAt(0);
      range.deleteContents();
      const el = document.createElement("div");
      el.innerHTML = html;
      const frag = document.createDocumentFragment();
      let node;
      while ((node = el.firstChild)) frag.appendChild(node);
      range.insertNode(frag);
      sel.collapseToEnd();
    } else {
      editor.insertAdjacentHTML("beforeend", html);
    }
  }

  // ---------- Text note import (req #6) ----------
  /* Rules:
     - A line that is a LIST ITEM ( -, *, +, or "1." / "1)" ) becomes a HEADER.
       * Top-level list item  -> H1 (major title, shows in TOC)
       * Indented list item   -> H2 (sub title, shows in TOC)
     - A line inside a fenced ``` block, or an indented (4-space / tab) block,
       becomes a CODE snippet block (black background).
     - Everything else becomes a paragraph. Blank lines are separators. */
  function textToHtml(text) {
    const lines = text.replace(/\r\n?/g, "\n").split("\n");
    const out = [];
    let inFence = false;
    let codeBuf = [];

    const flushCode = () => {
      if (codeBuf.length) {
        out.push('<pre class="code-block"><code>' +
          escapeHtml(codeBuf.join("\n")) + "</code></pre>");
        codeBuf = [];
      }
    };

    const listItem = (line) => {
      // returns {level, text} if the line is a list item, else null
      const m = line.match(/^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/);
      if (!m) return null;
      const indent = m[1].replace(/\t/g, "    ").length;
      return { level: indent >= 2 ? 2 : 1, text: m[2].trim() };
    };

    for (let raw of lines) {
      // fenced code block ```
      if (/^\s*```/.test(raw)) {
        if (inFence) { flushCode(); inFence = false; }
        else { inFence = true; }
        continue;
      }
      if (inFence) { codeBuf.push(raw); continue; }

      // indented code (4 spaces or a tab) -> code block
      if (/^(\t|    )/.test(raw) && raw.trim() !== "") {
        codeBuf.push(raw.replace(/^(\t|    )/, ""));
        continue;
      } else {
        flushCode();
      }

      if (raw.trim() === "") continue;

      const li = listItem(raw);
      if (li) {
        out.push("<h" + li.level + ">" + escapeHtml(li.text) + "</h" + li.level + ">");
      } else {
        out.push("<p>" + inlineFormat(raw.trim()) + "</p>");
      }
    }
    flushCode();
    return out.join("\n") || "<p></p>";
  }

  // minimal inline formatting for imported text: `code`, **bold**, *italic*
  function inlineFormat(s) {
    s = escapeHtml(s);
    s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, "$1<em>$2</em>");
    return s;
  }

  function importTextFile(file) {
    const reader = new FileReader();
    reader.onload = () => {
      const html = textToHtml(String(reader.result));
      const title = file.name.replace(/\.[^.]+$/, "");
      newDoc(title, html);
    };
    reader.readAsText(file);
  }

  // Extract usable body content + title from a full/partial HTML file, sanitized.
  function sanitizeImportedHtml(rawHtml) {
    const doc = new DOMParser().parseFromString(rawHtml, "text/html");
    // pull a title before we discard the head
    let title = "";
    const t = doc.querySelector("title");
    if (t && t.textContent.trim()) title = t.textContent.trim();
    const h1 = doc.body ? doc.body.querySelector("h1") : null;
    if (!title && h1 && h1.textContent.trim()) title = h1.textContent.trim();

    const body = doc.body || doc.createElement("body");
    // strip dangerous / unwanted elements
    body.querySelectorAll("script,style,link,meta,noscript,iframe,object,embed,base").forEach((el) => el.remove());
    // strip inline event handlers and javascript: URLs
    body.querySelectorAll("*").forEach((el) => {
      for (const attr of Array.prototype.slice.call(el.attributes)) {
        const name = attr.name.toLowerCase();
        const val = (attr.value || "").trim().toLowerCase();
        if (name.startsWith("on")) el.removeAttribute(attr.name);
        else if ((name === "href" || name === "src") && val.startsWith("javascript:")) el.removeAttribute(attr.name);
      }
    });
    return { html: body.innerHTML.trim() || "<p></p>", title };
  }

  function importHtmlFile(file) {
    const reader = new FileReader();
    reader.onload = () => {
      const { wrapped, name } = wrapImported(
        String(reader.result), "", file.name.replace(/\.[^.]+$/, "")
      );
      newDoc(name, wrapped);
      embedExternalImages();
    };
    reader.readAsText(file);
  }

  // Join a base directory (relative, "/"-separated) with a relative src, resolving . and ..
  function joinRelPath(baseDir, src) {
    const clean = src.split(/[?#]/)[0]; // drop query/hash
    const baseParts = baseDir ? baseDir.split("/").filter(Boolean) : [];
    const srcParts = clean.split("/");
    const stack = clean.charAt(0) === "/" ? [] : baseParts.slice();
    for (const part of srcParts) {
      if (part === "" || part === ".") continue;
      if (part === "..") { stack.pop(); continue; }
      stack.push(part);
    }
    return stack.join("/");
  }

  // Read a File as a base64 data URL.
  function fileToDataUrl(file) {
    return new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(fr.result);
      fr.onerror = rej;
      fr.readAsDataURL(file);
    });
  }

  // Read a File as plain text.
  function readTextFile(file) {
    return new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(String(fr.result));
      fr.onerror = rej;
      fr.readAsText(file);
    });
  }

  // Look up a File from folder maps given a (possibly relative/encoded) reference.
  function lookupFile(ref, baseDir, byPath, byName) {
    if (!ref) return null;
    const resolved = joinRelPath(baseDir, ref).toLowerCase();
    const decoded = decodeURIComponent(resolved);
    const base = decodeURIComponent(ref.split(/[?#]/)[0].split("/").pop()).toLowerCase();
    return byPath[decoded] || byPath[resolved] || byName[base] || null;
  }

  // Split CSS into top-level rules/blocks (brace-aware).
  function splitCssTopLevel(str) {
    const rules = [];
    let buf = "", depth = 0;
    for (let k = 0; k < str.length; k++) {
      const ch = str[k];
      buf += ch;
      if (ch === "{") depth++;
      else if (ch === "}") { depth--; if (depth === 0) { rules.push(buf); buf = ""; } }
    }
    if (buf.trim()) rules.push(buf);
    return rules;
  }

  function scopeSelector(sel, scope) {
    sel = sel.trim();
    if (!sel) return sel;
    if (/^(html|body|:root)$/i.test(sel)) return scope;
    if (/^(html|body)\b/i.test(sel)) return sel.replace(/^(html|body)\b/i, scope);
    return scope + " " + sel;
  }

  function transformCssRule(rule, scope) {
    const braceIdx = rule.indexOf("{");
    if (braceIdx === -1) return "";
    const prelude = rule.slice(0, braceIdx).trim();
    const body = rule.slice(braceIdx + 1, rule.lastIndexOf("}"));
    if (prelude.charAt(0) === "@") {
      const m = prelude.match(/^@([a-zA-Z-]+)/);
      const name = m ? ("@" + m[1].toLowerCase()) : "";
      if (name === "@media" || name === "@supports") {
        const inner = splitCssTopLevel(body).map((r) => transformCssRule(r, scope)).join("\n");
        return prelude + " {\n" + inner + "\n}";
      }
      return rule; // @keyframes, @font-face, @page, @import, etc. left intact
    }
    const scoped = prelude.split(",").map((s) => scopeSelector(s, scope)).join(", ");
    return scoped + " { " + body.trim() + " }";
  }

  // Prefix every selector so imported CSS styles only the wrapper, never the app UI.
  function scopeCss(css, scope) {
    css = css.replace(/\/\*[\s\S]*?\*\//g, "");
    return splitCssTopLevel(css).map((r) => transformCssRule(r, scope)).join("\n");
  }

  // Build a saved document body from imported HTML: scoped <style> + wrapped content.
  // extraCss is any CSS pulled from local stylesheet files (folder import).
  function wrapImported(rawHtml, extraCss, fallbackName) {
    const parsed = new DOMParser().parseFromString(rawHtml, "text/html");
    let css = "";
    parsed.querySelectorAll("style").forEach((s) => { css += "\n" + (s.textContent || ""); });
    if (extraCss) css += "\n" + extraCss;
    const scoped = css.trim() ? scopeCss(css, ".imported-html") : "";
    const { html, title } = sanitizeImportedHtml(rawHtml);
    const styleTag = scoped ? '<style class="imported-css">' + scoped + "</style>" : "";
    const wrapped = styleTag + '<div class="imported-html">' + html + "</div>";
    return { wrapped: wrapped, name: title || fallbackName };
  }

  // Import a whole folder: an .html file plus its (relative) images/attachments.
  function importHtmlFolder(fileList) {
    const files = Array.prototype.slice.call(fileList || []);
    if (!files.length) return;

    const htmlFiles = files.filter((f) => /\.html?$/i.test(f.name));
    if (!htmlFiles.length) { alert("No .html file found in that folder."); return; }
    // Prefer the shallowest .html (fewest path segments), then shortest name.
    htmlFiles.sort((a, b) => {
      const da = (a.webkitRelativePath || a.name).split("/").length;
      const db = (b.webkitRelativePath || b.name).split("/").length;
      return da - db || a.name.length - b.name.length;
    });
    const htmlFile = htmlFiles[0];
    const htmlPath = htmlFile.webkitRelativePath || htmlFile.name;
    const baseDir = htmlPath.indexOf("/") >= 0 ? htmlPath.slice(0, htmlPath.lastIndexOf("/")) : "";

    // Build lookup maps: by full relative path, and by basename (both decoded + lowercased).
    const byPath = {};
    const byName = {};
    files.forEach((f) => {
      const rel = (f.webkitRelativePath || f.name);
      byPath[decodeURIComponent(rel).toLowerCase()] = f;
      const base = rel.split("/").pop();
      byName[decodeURIComponent(base).toLowerCase()] = f;
    });

    const reader = new FileReader();
    reader.onload = () => {
      const rawHtml = String(reader.result);
      const parsed = new DOMParser().parseFromString(rawHtml, "text/html");

      // Pull CSS from local <link rel="stylesheet"> files in the folder.
      const cssJobs = [];
      Array.prototype.slice.call(parsed.querySelectorAll('link[rel~="stylesheet"]')).forEach((lnk) => {
        const href = lnk.getAttribute("href") || "";
        if (!href || /^(https?:|data:)/i.test(href)) return; // remote/inline handled elsewhere
        const f = lookupFile(href, baseDir, byPath, byName);
        if (f) cssJobs.push(readTextFile(f).catch(() => ""));
      });

      Promise.all(cssJobs).then((cssTexts) => {
        const extraCss = cssTexts.join("\n");
        const { wrapped, name } = wrapImported(
          rawHtml, extraCss, htmlFile.name.replace(/\.[^.]+$/, "")
        );
        newDoc(name, wrapped);

        // Embed local (relative) images and attachments as base64 data URLs.
        const nodes = Array.prototype.slice.call(
          editor.querySelectorAll('img[src], a.attachment[href], a[download][href]')
        );
        const jobs = [];
        let embedded = 0, missing = 0;
        nodes.forEach((el) => {
          const isImg = el.tagName === "IMG";
          const attr = isImg ? "src" : "href";
          const raw = el.getAttribute(attr) || "";
          if (!raw || /^(data:|https?:|mailto:|tel:|#)/i.test(raw)) return; // skip embedded/remote
          const match = lookupFile(raw, baseDir, byPath, byName);
          if (!match) { missing++; return; }
          jobs.push(
            fileToDataUrl(match).then((dataUrl) => { el.setAttribute(attr, dataUrl); embedded++; })
          );
        });

        if (!jobs.length) { saveCurrent(); if (missing) alert(missing + " image(s) could not be matched in the folder."); return; }
        saveState.textContent = "Embedding " + jobs.length + " file(s)\u2026";
        Promise.all(jobs).then(() => {
          saveCurrent();
          if (missing) alert("Imported. Embedded " + embedded + " file(s); " + missing + " could not be found in the folder.");
        });
      });
    };
    reader.readAsText(htmlFile);
  }

  function importDocxFile(file) {
    if (typeof mammoth === "undefined") {
      alert("Word import needs mammoth.browser.min.js next to index.html.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      saveState.textContent = "Converting Word\u2026";
      mammoth.convertToHtml({ arrayBuffer: reader.result })
        .then((result) => {
          const clean = sanitizeImportedHtml(result.value || "");
          const name = clean.title || file.name.replace(/\.[^.]+$/, "");
          newDoc(name, clean.html);
        })
        .catch((err) => {
          alert("Could not import Word document: " + (err && err.message ? err.message : err));
          saveState.textContent = "Saved";
        });
    };
    reader.readAsArrayBuffer(file);
  }
  // Fetch http(s) images in the editor and inline them as base64 data URLs.
  // Falls back silently to the original URL if a fetch fails (e.g. CORS).
  function embedExternalImages() {
    const imgs = Array.prototype.slice.call(editor.querySelectorAll('img[src^="http"]'));
    if (!imgs.length) return;
    saveState.textContent = "Embedding images\u2026";
    let remaining = imgs.length;
    const done = () => {
      if (--remaining <= 0) { saveCurrent(); }
    };
    imgs.forEach((img) => {
      const url = img.getAttribute("src");
      fetch(url)
        .then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); return r.blob(); })
        .then((blob) => new Promise((res, rej) => {
          const fr = new FileReader();
          fr.onload = () => res(fr.result);
          fr.onerror = rej;
          fr.readAsDataURL(blob);
        }))
        .then((dataUrl) => { img.src = dataUrl; })
        .catch(() => { /* leave original URL on failure */ })
        .then(done);
    });
  }

  // ---------- Library / Storage manager ----------
  let libraryModal = null;
  let librarySort = "updated"; // 'updated' | 'title' | 'size'
  let libraryFilter = "";
  const LS_LIB_W = "jlou_cms_lib_w";
  let libraryWidth = (function () {
    const v = parseInt(localStorage.getItem(LS_LIB_W) || "", 10);
    return v > 0 ? v : 0;
  })();

  function docSize(d) {
    // byte length of this doc's JSON entry (approx storage footprint)
    return new Blob([JSON.stringify(d)]).size;
  }
  function totalStorageBytes() {
    return new Blob([JSON.stringify(docs)]).size;
  }

  // ----- Bulk rename dialog: pattern-match Find/Replace across all doc titles -----
  let bulkModal = null;
  function openBulkRename() {
    ensureBulkModal();
    bulkModal.hidden = false;
    const find = bulkModal.querySelector("#bulkFind");
    renderBulkPreview();
    setTimeout(() => { find.focus(); find.select(); }, 0);
  }
  function closeBulkRename() { if (bulkModal) bulkModal.hidden = true; }

  function ensureBulkModal() {
    if (bulkModal) return;
    bulkModal = document.createElement("div");
    bulkModal.id = "bulkModal";
    bulkModal.className = "bulk-overlay";
    bulkModal.hidden = true;
    bulkModal.innerHTML =
      '<div class="bulk-dialog" role="dialog" aria-label="Bulk rename">' +
        '<div class="bulk-head"><h2>Bulk rename titles</h2>' +
          '<button id="bulkClose" class="modal-x" title="Close">\u2715</button></div>' +
        '<div class="bulk-row"><label for="bulkFind">Find (pattern)</label>' +
          '<input id="bulkFind" type="text" autocomplete="off" placeholder="e.g. ^\\d+[a-z]?[.\\-]\\s* " value="^\\d+[a-zA-Z]?\\s*[.\\-)]\\s*" /></label></div>' +
        '<div class="bulk-row"><label for="bulkRepl">Replace with</label>' +
          '<input id="bulkRepl" type="text" autocomplete="off" placeholder="e.g. nzpost." value="nzpost." /></div>' +
        '<div class="bulk-opts">' +
          '<label><input type="checkbox" id="bulkRegex" checked /> Regular expression</label>' +
          '<label><input type="checkbox" id="bulkCase" /> Case sensitive</label>' +
          '<label><input type="checkbox" id="bulkStart" /> Match start of title only</label>' +
        '</div>' +
        '<div class="bulk-hint">Not regex? Turn it off to match plain text; <b>*</b> and <b>?</b> act as wildcards. Regex on: use groups like <b>$1</b> in the replacement.</div>' +
        '<div id="bulkError" class="bulk-error" hidden></div>' +
        '<div id="bulkCount" class="bulk-count"></div>' +
        '<div id="bulkPreview" class="bulk-preview"></div>' +
        '<div class="bulk-actions">' +
          '<button id="bulkCancel" class="lib-tool-btn">Cancel</button>' +
          '<button id="bulkApply" class="bulk-apply">Rename</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(bulkModal);

    bulkModal.addEventListener("click", (e) => { if (e.target === bulkModal) closeBulkRename(); });
    bulkModal.querySelector("#bulkClose").addEventListener("click", closeBulkRename);
    bulkModal.querySelector("#bulkCancel").addEventListener("click", closeBulkRename);
    bulkModal.querySelector("#bulkApply").addEventListener("click", applyBulkRename);
    ["#bulkFind", "#bulkRepl"].forEach((s) =>
      bulkModal.querySelector(s).addEventListener("input", renderBulkPreview));
    ["#bulkRegex", "#bulkCase", "#bulkStart"].forEach((s) =>
      bulkModal.querySelector(s).addEventListener("change", renderBulkPreview));
    bulkModal.querySelector("#bulkFind").addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeBulkRename();
    });
  }

  // Build the RegExp objects from the dialog inputs. Returns {test, global} or throws.
  function buildBulkRegex() {
    const find = bulkModal.querySelector("#bulkFind").value;
    if (!find) return null;
    const isRegex = bulkModal.querySelector("#bulkRegex").checked;
    const caseSensitive = bulkModal.querySelector("#bulkCase").checked;
    const startOnly = bulkModal.querySelector("#bulkStart").checked;
    let source;
    if (isRegex) {
      source = find;
    } else {
      // Escape literal, then let * and ? behave as wildcards.
      source = find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
                   .replace(/\\\*/g, ".*").replace(/\\\?/g, ".");
    }
    if (startOnly && source.charAt(0) !== "^") source = "^" + source;
    const flags = caseSensitive ? "" : "i";
    return { test: new RegExp(source, flags), global: new RegExp(source, flags + "g") };
  }

  function renderBulkPreview() {
    ensureBulkModal();
    const errEl = bulkModal.querySelector("#bulkError");
    const countEl = bulkModal.querySelector("#bulkCount");
    const listEl = bulkModal.querySelector("#bulkPreview");
    const applyBtn = bulkModal.querySelector("#bulkApply");
    const repl = bulkModal.querySelector("#bulkRepl").value;
    let rx;
    try { rx = buildBulkRegex(); errEl.hidden = true; }
    catch (e) { errEl.textContent = "Invalid pattern: " + e.message; errEl.hidden = false;
      countEl.textContent = ""; listEl.innerHTML = ""; applyBtn.disabled = true; return; }

    if (!rx) { countEl.textContent = "Enter a pattern to see matches."; listEl.innerHTML = "";
      applyBtn.disabled = true; return; }

    const changes = [];
    Object.values(docs).forEach((d) => {
      const t = d.title || "";
      if (!rx.test.test(t)) return;
      const nt = t.replace(rx.global, repl);
      if (nt !== t) changes.push({ id: d.id, from: t, to: nt });
    });

    applyBtn.disabled = changes.length === 0;
    countEl.textContent = changes.length
      ? (changes.length + " document(s) will be renamed:")
      : "No documents match (or the result is unchanged).";
    listEl.innerHTML = changes.slice(0, 200).map((c) =>
      '<div class="bulk-item"><span class="bulk-from">' + escapeHtml(c.from) +
      '</span><span class="bulk-arrow">\u2192</span><span class="bulk-to">' +
      escapeHtml(c.to) + '</span></div>').join("") +
      (changes.length > 200 ? '<div class="bulk-more">\u2026and ' + (changes.length - 200) + ' more</div>' : "");
    bulkPendingChanges = changes;
  }

  let bulkPendingChanges = [];
  function applyBulkRename() {
    renderBulkPreview();
    const changes = bulkPendingChanges;
    if (!changes.length) return;
    if (!confirm("Rename " + changes.length + " document title(s)? This cannot be undone.")) return;
    let n = 0;
    changes.forEach((c) => {
      const d = docs[c.id];
      if (d && d.title !== c.to) { d.title = c.to; d.updated = Date.now(); n++; }
    });
    persistSafe();
    refreshDocSelect(true);
    if (currentId && docs[currentId]) titleInput.value = docs[currentId].title;
    if (libraryModal && !libraryModal.hidden) renderLibrary();
    closeBulkRename();
    alert("Renamed " + n + " document(s).");
  }

  function buildLibraryModal() {
    libraryModal = document.createElement("aside");
    libraryModal.id = "libraryModal";
    libraryModal.className = "lib-dock";
    libraryModal.hidden = true;
    libraryModal.innerHTML =
      '<div class="lib-grip" id="libraryGrip" title="Drag to resize"></div>' +
      '<div class="modal" role="dialog" aria-label="Library">' +
        '<div class="modal-head">' +
          '<h2>Library</h2>' +
          '<div class="lib-tools">' +
            '<label>Sort: <select id="librarySort">' +
              '<option value="updated">Last updated</option>' +
              '<option value="title">Title (A-Z)</option>' +
              '<option value="size">Size</option>' +
            '</select></label>' +
            '<button id="libraryBulkRename" class="lib-tool-btn" title="Replace a numeric title prefix (e.g. \u201c80. \u201d) with a text prefix">Bulk rename\u2026</button>' +
            '<button id="libraryClose" class="modal-x" title="Close">\u2715</button>' +
          '</div>' +
        '</div>' +
        '<div class="lib-filter-wrap">' +
          '<input id="libraryFilter" type="text" placeholder="Filter documents\u2026" autocomplete="off" />' +
        '</div>' +
        '<div id="libraryUsage" class="lib-usage"></div>' +
        '<div id="libraryList" class="lib-list"></div>' +
      '</div>';
    (document.querySelector(".layout") || document.body).appendChild(libraryModal);

    if (libraryWidth) libraryModal.style.width = libraryWidth + "px";

    libraryModal.querySelector("#libraryClose").addEventListener("click", closeLibrary);
    libraryModal.querySelector("#libraryBulkRename").addEventListener("click", openBulkRename);
    libraryModal.querySelector("#librarySort").addEventListener("change", (e) => {
      librarySort = e.target.value;
      renderLibrary();
    });
    const filterEl = libraryModal.querySelector("#libraryFilter");
    const onFilter = (e) => { libraryFilter = e.target.value; renderLibrary(); };
    filterEl.addEventListener("input", onFilter);
    filterEl.addEventListener("keyup", onFilter);
    setupLibraryResize(libraryModal.querySelector("#libraryGrip"));
  }

  // Drag the left edge of the Library dock to resize its width.
  function setupLibraryResize(grip) {
    let startX = 0, startW = 0, dragging = false;
    const onMove = (e) => {
      if (!dragging) return;
      const dx = startX - e.clientX;              // drag left = wider
      let w = startW + dx;
      const max = Math.min(window.innerWidth - 360, 900);
      w = Math.max(280, Math.min(w, max));
      libraryModal.style.width = w + "px";
    };
    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      document.body.classList.remove("resizing-x");
      libraryWidth = parseInt(libraryModal.style.width, 10) || libraryWidth;
      try { localStorage.setItem(LS_LIB_W, String(libraryWidth)); } catch (_) {}
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    grip.addEventListener("mousedown", (e) => {
      dragging = true;
      startX = e.clientX;
      startW = libraryModal.getBoundingClientRect().width;
      document.body.classList.add("resizing-x");
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
      e.preventDefault();
    });
  }

  function openLibrary() {
    saveCurrent();
    if (!libraryModal) buildLibraryModal();
    libraryModal.querySelector("#librarySort").value = librarySort;
    libraryModal.querySelector("#libraryFilter").value = libraryFilter;
    renderLibrary();
    libraryModal.hidden = false;
    const f = libraryModal.querySelector("#libraryFilter");
    if (f) setTimeout(() => f.focus(), 0);
  }
  function closeLibrary() { if (libraryModal) libraryModal.hidden = true; }

  function renderLibrary() {
    const list = libraryModal.querySelector("#libraryList");
    const usage = libraryModal.querySelector("#libraryUsage");
    let items = Object.values(docs).slice();

    const totalCount = items.length;
    const fq = libraryFilter.trim().toLowerCase();
    if (fq) {
      items = items.filter((d) =>
        (d.title || "").toLowerCase().indexOf(fq) !== -1 ||
        htmlToText(d.html || "").toLowerCase().indexOf(fq) !== -1
      );
    }

    items.sort((a, b) => {
      if (librarySort === "title") return (a.title || "").localeCompare(b.title || "");
      if (librarySort === "size") return docSize(b) - docSize(a);
      return (b.updated || 0) - (a.updated || 0);
    });

    // usage bar - IndexedDB allows far more than the old ~5 MB localStorage cap.
    const usedBytes = totalStorageBytes();
    const store = _db ? "IndexedDB" : "localStorage (fallback)";
    const softCap = _db ? (500 * 1024 * 1024) : (5 * 1024 * 1024);
    const pct = Math.min(100, Math.round((usedBytes / softCap) * 100));
    const countLabel = fq
      ? (items.length + ' of ' + totalCount + ' match')
      : (totalCount + ' document' + (totalCount === 1 ? '' : 's'));
    usage.innerHTML =
      '<div class="lib-usage-row"><span>' + countLabel +
      '</span><span>' + formatBytes(usedBytes) + ' used \u00b7 ' + store + '</span></div>' +
      '<div class="lib-bar"><div class="lib-bar-fill" style="width:' + pct + '%"></div></div>';
    // Refine with the real browser storage estimate when available (async).
    if (navigator.storage && navigator.storage.estimate) {
      navigator.storage.estimate().then((est) => {
        if (!est || !est.quota) return;
        const live = libraryModal && libraryModal.querySelector("#libraryUsage");
        if (!live || libraryModal.hidden) return;
        const q = est.quota;
        const p = Math.min(100, Math.round(((est.usage || usedBytes) / q) * 100));
        const row = live.querySelector(".lib-usage-row span:last-child");
        const fill = live.querySelector(".lib-bar-fill");
        if (row) row.textContent = formatBytes(usedBytes) + ' used \u00b7 ' +
          formatBytes(q) + ' available \u00b7 ' + store;
        if (fill) fill.style.width = p + "%";
      }).catch(() => {});
    }

    if (!items.length) {
      list.innerHTML = fq
        ? '<div class="lib-empty">No documents match \u201c' + escapeHtml(libraryFilter) + '\u201d.</div>'
        : '<div class="lib-empty">No documents yet. Click <b>+ New</b> or <b>Import&hellip;</b>.</div>';
      return;
    }

    list.innerHTML = items.map((d) => {
      const preview = htmlToText(d.html || "").replace(/\s+/g, " ").trim().slice(0, 120);
      const when = d.updated ? new Date(d.updated).toLocaleString() : "";
      const isCur = d.id === currentId;
      return (
        '<div class="lib-item' + (isCur ? ' current' : '') + '" data-id="' + escapeAttr(d.id) + '">' +
          '<div class="lib-main">' +
            '<div class="lib-title">' + escapeHtml(d.title || "Untitled") +
              (isCur ? ' <span class="lib-badge">open</span>' : '') + '</div>' +
            '<div class="lib-meta">' + escapeHtml(when) + ' &middot; ' + formatBytes(docSize(d)) + '</div>' +
            (preview ? '<div class="lib-preview">' + escapeHtml(preview) + '</div>' : '') +
          '</div>' +
          '<div class="lib-actions">' +
            '<button data-act="open" title="Open">Open</button>' +
            '<button data-act="rename" title="Rename">Rename</button>' +
            '<button data-act="export" title="Export .html">Export</button>' +
            '<button data-act="delete" class="danger" title="Delete">Delete</button>' +
          '</div>' +
        '</div>'
      );
    }).join("");

    list.querySelectorAll(".lib-item").forEach((row) => {
      const id = row.getAttribute("data-id");
      row.querySelectorAll("button[data-act]").forEach((btn) => {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          libraryAction(btn.getAttribute("data-act"), id);
        });
      });
      row.querySelector(".lib-main").addEventListener("click", () => libraryAction("open", id));
    });
  }

  function libraryAction(act, id) {
    const d = docs[id];
    if (!d) return;
    if (act === "open") {
      saveCurrent();
      openDoc(id);
      renderLibrary(); // keep Library open; refresh so the opened item shows as current
    } else if (act === "export") {
      exportDoc(id);
    } else if (act === "rename") {
      const name = prompt("Rename document:", d.title);
      if (name === null) return;
      d.title = name.trim() || "Untitled document";
      d.updated = Date.now();
      persistSafe();
      refreshDocSelect(true);
      if (id === currentId) titleInput.value = d.title;
      renderLibrary();
    } else if (act === "delete") {
      if (!confirm('Delete "' + d.title + '"? This cannot be undone.')) return;
      delete docs[id];
      recordTombstone(id);
      persistSafe();
      const ids = Object.keys(docs);
      if (id === currentId) {
        if (ids.length) openDoc(ids[0]);
        else newDoc("Welcome", welcomeHtml());
      }
      refreshDocSelect(true);
      renderLibrary();
    }
  }

  // ---------- Backup / Restore (all documents as one .json file) ----------
  function backupAll() {
    saveCurrent();
    const payload = {
      app: "JLou Content Manager",
      type: "jlou-cms-backup",
      version: 1,
      exportedAt: new Date().toISOString(),
      docs: docs,
      last: localStorage.getItem(LS_LAST) || null,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    a.download = "jlou-cms-backup-" + stamp + ".json";
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function restoreFromFile(file) {
    if (!file) { alert("No file selected."); return; }
    const reader = new FileReader();
    reader.onerror = () => alert("Could not read the file: " + (reader.error && reader.error.message || "unknown error"));
    reader.onload = async () => {
      try {
        let data;
        try { data = JSON.parse(String(reader.result)); }
        catch (e) { alert("That file is not valid JSON: " + e.message); return; }

        const incoming = (data && data.docs && typeof data.docs === "object") ? data.docs : null;
        if (!incoming) { alert("This doesn't look like a JLou CMS backup (no 'docs' found)."); return; }

        const ids = Object.keys(incoming);
        if (!ids.length) { alert("The backup contains no documents."); return; }

        const merge = confirm(
          ids.length + " document(s) found in the backup.\n\n" +
          "OK = Merge into current library (keep existing docs).\n" +
          "Cancel = Replace everything (wipe current library first)."
        );

        saveCurrent();
        const snapshot = JSON.parse(JSON.stringify(docs)); // for rollback on failure
        if (!merge) { docs = {}; }

        let added = 0;
        for (const id of ids) {
          const src = incoming[id] || {};
          const newId = (merge && docs[id]) ? uid() : (id || uid());
          docs[newId] = {
            id: newId,
            title: (src.title || "Untitled document"),
            html: (src.html || ""),
            updated: (typeof src.updated === "number" ? src.updated : Date.now()),
          };
          added++;
        }

        try {
          await persist();
        } catch (e) {
          alert("Storage limit reached while saving (" + (e && e.name ? e.name : e) + ").\n" +
                "Try removing some large documents first, then restore again. No changes were saved.");
          docs = snapshot; // roll back to what we had before
          refreshDocSelect();
          return;
        }

        refreshDocSelect();
        const firstId = (data.last && docs[data.last]) ? data.last : Object.keys(docs)[0];
        if (firstId) openDoc(firstId);
        alert("Restored " + added + " document(s).");
      } catch (err) {
        alert("Restore failed: " + (err && err.message ? err.message : err));
      }
    };
    reader.readAsText(file);
  }

  // ---------- Export standalone HTML ----------
  function exportHtml() { if (currentId) exportDoc(currentId); }

  function exportDoc(id) {
    const d = docs[id];
    if (!d) return;
    const bodyHtml = (id === currentId) ? cleanEditorHtml() : (d.html || "");
    const css = `body{font-family:-apple-system,"Segoe UI",Roboto,Arial,sans-serif;max-width:820px;margin:40px auto;padding:0 20px;line-height:1.7;color:#24292f}
h1,h2{color:#b91c1c;font-weight:800}
h1{border-bottom:2px solid #f0d0d0;padding-bottom:4px}
pre.code-block{background:#000;color:#fff;padding:14px 16px;border-radius:8px;overflow-x:auto;font-family:Consolas,monospace;white-space:pre-wrap}
table.doc-table{border-collapse:collapse;margin:14px 0;font-size:15px}
table.doc-table th,table.doc-table td{border:1px solid #cbd5e1;padding:7px 10px;vertical-align:top}
table.doc-table th{background:#f1f5f9;font-weight:600;text-align:left}
img{max-width:100%;height:auto;border-radius:6px}
a.attachment{display:inline-block;background:#eef2ff;border:1px solid #d6e0ff;border-radius:6px;padding:4px 10px;color:#2563eb;text-decoration:none}
.cms-toc-hidden{display:none}
code{font-family:Consolas,monospace}`;
    const doc =
      "<!DOCTYPE html><html><head><meta charset='utf-8'><title>" +
      escapeHtml(d.title) + "</title><style>" + css + "</style></head><body>" +
      "<h1 style='border:none'>" + escapeHtml(d.title) + "</h1>" +
      bodyHtml + "</body></html>";
    const blob = new Blob([doc], { type: "text/html" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = d.title.replace(/[^\w.-]+/g, "_") + ".html";
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // ---------- Helpers ----------
  function escapeHtml(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function escapeAttr(s) {
    return escapeHtml(s).replace(/"/g, "&quot;");
  }
  function formatBytes(n) {
    if (n < 1024) return n + " B";
    if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
    return (n / 1048576).toFixed(1) + " MB";
  }

  // ---------- Cross-document search (req: find across all storage) ----------
  const searchInput = $("#searchInput");
  const searchResults = $("#searchResults");
  let pendingScrollTerm = null;

  function htmlToText(html) {
    const tmp = document.createElement("div");
    tmp.innerHTML = html;
    return tmp.textContent || "";
  }

  function makeSnippet(text, idx, term) {
    const start = Math.max(0, idx - 35);
    const end = Math.min(text.length, idx + term.length + 45);
    let snip = (start > 0 ? "…" : "") + text.slice(start, end) + (end < text.length ? "…" : "");
    // highlight (snippet is escaped first)
    const rx = new RegExp("(" + escapeRegex(term) + ")", "ig");
    return escapeHtml(snip).replace(rx, "<mark>$1</mark>");
  }

  function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

  function runSearch(q) {
    q = q.trim();
    if (!q) { searchResults.hidden = true; searchResults.innerHTML = ""; return; }
    const ql = q.toLowerCase();
    const hits = [];
    Object.values(docs).forEach((d) => {
      const title = d.title || "";
      const body = htmlToText(d.html || "");
      const hay = (title + "\n" + body);
      let count = 0;
      let low = hay.toLowerCase();
      let from = 0, idx;
      while ((idx = low.indexOf(ql, from)) !== -1) { count++; from = idx + ql.length; if (count > 999) break; }
      if (count > 0) {
        const bodyIdx = body.toLowerCase().indexOf(ql);
        const snippet = bodyIdx !== -1 ? makeSnippet(body, bodyIdx, q)
          : "<i>(match in title)</i>";
        hits.push({ id: d.id, title, count, snippet, updated: d.updated });
      }
    });
    hits.sort((a, b) => b.count - a.count || b.updated - a.updated);
    renderResults(hits, q);
  }

  function renderResults(hits, q) {
    if (!hits.length) {
      searchResults.innerHTML = '<div class="sr-empty">No matches for “' + escapeHtml(q) + '”.</div>';
      searchResults.hidden = false;
      return;
    }
    searchResults.innerHTML =
      '<div class="sr-head">' + hits.length + " document" + (hits.length > 1 ? "s" : "") + " matched</div>" +
      hits.map((h) =>
        '<div class="sr-item" data-id="' + h.id + '">' +
        '<div class="sr-title">' + escapeHtml(h.title) +
        ' <span class="sr-count">' + h.count + "</span></div>" +
        '<div class="sr-snip">' + h.snippet + "</div></div>"
      ).join("");
    searchResults.hidden = false;
    searchResults.querySelectorAll(".sr-item").forEach((el) => {
      el.addEventListener("click", () => {
        const id = el.getAttribute("data-id");
        saveCurrent();
        pendingScrollTerm = q;
        openDoc(id);
        searchResults.hidden = true;
        scrollToTerm(q);
      });
    });
  }

  // ---------- Find in current document: highlight ALL + prev/next ----------
  let findMarks = [];
  let findIdx = -1;
  let activeFindTerm = "";

  function clearFindHighlights() {
    editor.querySelectorAll("mark.find-hl").forEach((m) => {
      const parent = m.parentNode;
      if (!parent) return;
      parent.replaceChild(document.createTextNode(m.textContent), m);
      parent.normalize();
    });
    findMarks = [];
    findIdx = -1;
    activeFindTerm = "";
    hideFindBar();
  }

  function highlightAll(term) {
    clearFindHighlights();
    if (!term) return;
    activeFindTerm = term;
    const tl = term.toLowerCase();
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) =>
        n.nodeValue && n.nodeValue.toLowerCase().indexOf(tl) !== -1
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT,
    });
    const targets = [];
    let node;
    while ((node = walker.nextNode())) targets.push(node);
    targets.forEach((textNode) => {
      const text = textNode.nodeValue;
      const low = text.toLowerCase();
      const frag = document.createDocumentFragment();
      let from = 0, idx;
      while ((idx = low.indexOf(tl, from)) !== -1) {
        if (idx > from) frag.appendChild(document.createTextNode(text.slice(from, idx)));
        const mark = document.createElement("mark");
        mark.className = "find-hl";
        mark.textContent = text.slice(idx, idx + term.length);
        frag.appendChild(mark);
        from = idx + term.length;
      }
      if (from < text.length) frag.appendChild(document.createTextNode(text.slice(from)));
      textNode.parentNode.replaceChild(frag, textNode);
    });
    findMarks = Array.prototype.slice.call(editor.querySelectorAll("mark.find-hl"));
    if (findMarks.length) { showFindBar(); gotoMatch(0); }
    if (findListPanel && !findListPanel.hidden) buildFindList();
  }

  function gotoMatch(i) {
    if (!findMarks.length) return;
    if (i < 0) i = findMarks.length - 1;
    if (i >= findMarks.length) i = 0;
    findIdx = i;
    findMarks.forEach((m) => m.classList.remove("current"));
    const cur = findMarks[findIdx];
    cur.classList.add("current");
    const rect = cur.getBoundingClientRect();
    const edRect = editor.getBoundingClientRect();
    editor.scrollTop += (rect.top - edRect.top) - editor.clientHeight / 2;
    updateFindCounter();
    updateFindListActive();
  }

  // Build a short context snippet (with the match bolded) for one highlight mark.
  function snippetFor(mark) {
    const block = mark.closest("p,li,h1,h2,h3,h4,h5,h6,td,th,pre,blockquote,figcaption,div") || mark.parentNode;
    const full = (block.textContent || "").replace(/\s+/g, " ").trim();
    const matchText = mark.textContent || "";
    // character offset of this mark within the block
    let off = 0;
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, null);
    let node;
    while ((node = walker.nextNode())) {
      if (mark.contains(node)) break;
      off += (node.nodeValue || "").length;
    }
    // account for whitespace collapsing done above (approximate but fine for display)
    const raw = block.textContent || "";
    const collapsedBefore = raw.slice(0, off).replace(/\s+/g, " ").replace(/^\s/, "");
    const start = collapsedBefore.length;
    const pad = 40;
    const from = Math.max(0, start - pad);
    const pre = (from > 0 ? "\u2026" : "") + full.slice(from, start);
    const mid = full.slice(start, start + matchText.length);
    const post = full.slice(start + matchText.length, start + matchText.length + pad) +
                 (start + matchText.length + pad < full.length ? "\u2026" : "");
    return escapeHtml(pre) + "<b>" + escapeHtml(mid || matchText) + "</b>" + escapeHtml(post);
  }

  // Floating find navigation bar
  let findBar = null, findCounter = null, findInput = null, findListPanel = null;
  function ensureFindBar() {
    if (findBar) return;
    findBar = document.createElement("div");
    findBar.id = "findBar";
    findBar.hidden = true;
    findBar.innerHTML =
      '<span class="fb-label">Find</span>' +
      '<input type="text" id="findInput" class="fb-input" placeholder="Find in page\u2026" autocomplete="off" />' +
      '<span id="findCounter" class="fb-count">0 / 0</span>' +
      '<button type="button" id="findPrev" title="Previous (Shift+Enter)">\u25B2</button>' +
      '<button type="button" id="findNext" title="Next (Enter)">\u25BC</button>' +
      '<button type="button" id="findListBtn" title="List all matches">\u2630</button>' +
      '<button type="button" id="findClose" title="Close (Esc)">\u2715</button>' +
      '<div id="findList" class="fb-list" hidden></div>';
    document.body.appendChild(findBar);
    findCounter = findBar.querySelector("#findCounter");
    findInput = findBar.querySelector("#findInput");
    findListPanel = findBar.querySelector("#findList");
    findBar.querySelector("#findPrev").addEventListener("click", () => gotoMatch(findIdx - 1));
    findBar.querySelector("#findNext").addEventListener("click", () => gotoMatch(findIdx + 1));
    findBar.querySelector("#findListBtn").addEventListener("click", toggleFindList);
    findBar.querySelector("#findClose").addEventListener("click", () => closeFind());
    findListPanel.addEventListener("click", (e) => {
      const row = e.target.closest(".fb-list-item");
      if (!row) return;
      gotoMatch(parseInt(row.getAttribute("data-i"), 10) || 0);
    });

    let inTimer = null;
    findInput.addEventListener("input", () => {
      clearTimeout(inTimer);
      const term = findInput.value;
      inTimer = setTimeout(() => highlightAll(term), 120);
    });
    findInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        if (!findMarks.length) { highlightAll(findInput.value); return; }
        gotoMatch(findIdx + (e.shiftKey ? -1 : 1));
      } else if (e.key === "Escape") {
        e.preventDefault();
        if (findListPanel && !findListPanel.hidden) { findListPanel.hidden = true; return; }
        closeFind();
      }
    });
  }
  function toggleFindList() {
    ensureFindBar();
    if (!findListPanel.hidden) { findListPanel.hidden = true; return; }
    buildFindList();
    findListPanel.hidden = false;
  }
  function buildFindList() {
    if (!findListPanel) return;
    if (!findMarks.length) {
      findListPanel.innerHTML = '<div class="fb-list-empty">No matches' +
        (activeFindTerm ? ' for \u201c' + escapeHtml(activeFindTerm) + '\u201d' : '') + '.</div>';
      return;
    }
    const head = '<div class="fb-list-head">' + findMarks.length + ' match' +
      (findMarks.length === 1 ? '' : 'es') +
      (activeFindTerm ? ' for \u201c' + escapeHtml(activeFindTerm) + '\u201d' : '') + '</div>';
    const rows = findMarks.map((m, i) =>
      '<div class="fb-list-item' + (i === findIdx ? ' current' : '') + '" data-i="' + i + '">' +
      '<span class="fb-list-n">' + (i + 1) + '</span>' +
      '<span class="fb-list-txt">' + snippetFor(m) + '</span></div>'
    ).join("");
    findListPanel.innerHTML = head + rows;
  }
  function updateFindListActive() {
    if (!findListPanel || findListPanel.hidden) return;
    findListPanel.querySelectorAll(".fb-list-item").forEach((el) => {
      const on = (parseInt(el.getAttribute("data-i"), 10) === findIdx);
      el.classList.toggle("current", on);
      if (on) el.scrollIntoView({ block: "nearest" });
    });
  }
  function openFind() {
    ensureFindBar();
    findBar.hidden = false;
    // Seed with the current selection, if any.
    const sel = String(window.getSelection ? window.getSelection() : "").trim();
    if (sel && sel.length <= 100) { findInput.value = sel; highlightAll(sel); }
    findInput.focus();
    findInput.select();
  }
  function closeFind() {
    clearFindHighlights();
    if (findInput) findInput.value = "";
    if (findListPanel) findListPanel.hidden = true;
    editor.focus();
  }
  function showFindBar() { ensureFindBar(); findBar.hidden = false; if (findInput) findInput.value = activeFindTerm; }
  function hideFindBar() { if (findBar) findBar.hidden = true; if (findListPanel) findListPanel.hidden = true; }
  function updateFindCounter() {
    if (findCounter) findCounter.textContent = (findMarks.length ? findIdx + 1 : 0) + " / " + findMarks.length;
  }

  // Existing callers use scrollToTerm(term) -> now highlights every match
  function scrollToTerm(term) { highlightAll(term); }

  // Editor html without transient find highlights (for save/export)
  function cleanEditorHtml() {
    if (!editor.querySelector("mark.find-hl")) return editor.innerHTML;
    const clone = editor.cloneNode(true);
    clone.querySelectorAll("mark.find-hl").forEach((m) => {
      m.replaceWith(document.createTextNode(m.textContent));
    });
    clone.normalize();
    return clone.innerHTML;
  }

  let searchTimer = null;
  searchInput.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => runSearch(searchInput.value), 180);
  });
  searchInput.addEventListener("focus", () => { if (searchInput.value.trim()) runSearch(searchInput.value); });
  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { searchResults.hidden = true; searchInput.blur(); }
    if (e.key === "Enter") {
      const first = searchResults.querySelector(".sr-item");
      if (first) first.click();
    }
  });
  // close results when clicking elsewhere
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".search-box")) searchResults.hidden = true;
  });
  // Ctrl+F opens in-page find; F3 / Shift+F3 cycle matches; Esc clears
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
      e.preventDefault();
      openFind();
      return;
    }
    if (!findMarks.length) return;
    if (e.key === "F3") { e.preventDefault(); gotoMatch(findIdx + (e.shiftKey ? -1 : 1)); }
    else if (e.key === "Escape" && document.activeElement !== searchInput) { closeFind(); }
  });

  // ---------- Cloud sync (GitHub Gist) ----------
  let autoTimer = null, lastFocusSync = 0, syncBusy = false;

  const getToken = () => (localStorage.getItem(LS_SYNC_TOKEN) || "").trim();
  const getGistId = () => (localStorage.getItem(LS_SYNC_GIST) || "").trim();
  const syncEnabled = () => localStorage.getItem(LS_SYNC_ON) === "1";
  const syncConfigured = () => !!getToken() && !!getGistId();

  function ghHeaders() {
    return {
      "Authorization": "token " + getToken(),
      "Accept": "application/vnd.github+json",
      "Content-Type": "application/json",
    };
  }

  // fetch with an abort timeout so a hung request can never freeze sync (rejects instead).
  function fetchWithTimeout(url, opts, ms) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), ms || 20000);
    return fetch(url, Object.assign({}, opts || {}, { signal: ctl.signal }))
      .finally(() => clearTimeout(t));
  }

  // Small transient toast so sync results are always visible.
  function toast(msg, kind) {
    let el = document.getElementById("syncToast");
    if (!el) {
      el = document.createElement("div");
      el.id = "syncToast";
      el.className = "sync-toast";
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.style.background = kind === "error" ? "#dc2626" : (kind === "info" ? "#334155" : "#16a34a");
    el.classList.add("show");
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove("show"), 3200);
  }

  function setSyncStatus(state, info) {
    const btn = $("#syncBtn");
    if (!btn) return;
    const dot = btn.querySelector(".sync-dot");
    const map = { off: "#94a3b8", ok: "#16a34a", syncing: "#eab308", error: "#dc2626" };
    if (dot) dot.style.background = map[state] || map.off;
    let tip = "Cloud sync (GitHub Gist)";
    if (state === "syncing") tip = "Syncing\u2026";
    else if (state === "ok") tip = "Synced" + (getSyncMeta() ? " \u2013 " + new Date(getSyncMeta()).toLocaleString() : "");
    else if (state === "error") tip = "Sync error: " + (info && info.message ? info.message : info);
    else if (state === "off") tip = "Cloud sync is off \u2013 click to set up";
    btn.title = tip;
  }
  const getSyncMeta = () => parseInt(localStorage.getItem(LS_SYNC_META) || "0", 10) || 0;
  function setSyncMeta(ms) { localStorage.setItem(LS_SYNC_META, String(ms)); }

  // ----- Chunked gist storage (keeps every file < 1 MB so it's inline & CORS-safe) -----
  const GIST_PREFIX = "jlou-cms";      // chunk files: jlou-cms-000.json, jlou-cms-001.json ...
  const CHUNK_LIMIT = 900000;          // ~0.9 MB per file (GitHub truncates >1 MB)
  const CHUNK_RE = /^jlou-cms.*\.json$/;

  // Split docs into groups whose serialized size stays under CHUNK_LIMIT.
  function chunkDocs(docsObj) {
    const chunks = [];
    let cur = {}, curSize = 2, count = 0;
    for (const id of Object.keys(docsObj)) {
      const add = JSON.stringify(docsObj[id]).length + id.length + 6;
      if (curSize + add > CHUNK_LIMIT && count > 0) { chunks.push(cur); cur = {}; curSize = 2; count = 0; }
      cur[id] = docsObj[id]; curSize += add; count++;
    }
    if (count > 0 || chunks.length === 0) chunks.push(cur);
    return chunks;
  }
  // Build the gist `files` object for a given state (tombstones ride in the first chunk).
  function buildChunkFiles(state) {
    const chunks = chunkDocs(state.docs || {});
    const files = {};
    chunks.forEach((c, i) => {
      const name = GIST_PREFIX + "-" + String(i).padStart(3, "0") + ".json";
      files[name] = { content: JSON.stringify({
        type: "jlou-cms-chunk", version: 2, part: i, parts: chunks.length,
        docs: c, tombstones: i === 0 ? (state.tombstones || {}) : undefined,
      }) };
    });
    return files;
  }

  // Pull the shared library from the gist (reads every jlou-cms*.json chunk). Returns {docs, tombstones, fileNames}.
  async function syncPull() {
    const res = await fetchWithTimeout("https://api.github.com/gists/" + getGistId(), { headers: ghHeaders() });
    if (res.status === 401) throw new Error("Unauthorized \u2013 check your token.");
    if (res.status === 404) throw new Error("Gist not found \u2013 check the Gist ID.");
    if (!res.ok) throw new Error("GitHub API " + res.status);
    const data = await res.json();
    const files = data.files || {};
    const outDocs = {}, outTombs = {};
    for (const [name, f] of Object.entries(files)) {
      if (!CHUNK_RE.test(name) || !f) continue;
      let content = f.content;
      if (f.truncated && f.raw_url) { // over the gist inline budget -> fetch full content (CORS-open, no auth needed)
        const raw = await fetchWithTimeout(f.raw_url, {}, 30000);
        content = await raw.text();
      }
      let parsed = {};
      try { parsed = JSON.parse(content || "{}"); } catch (_) { parsed = {}; }
      Object.assign(outDocs, parsed.docs || {});
      if (parsed.tombstones) Object.assign(outTombs, parsed.tombstones);
    }
    return { docs: outDocs, tombstones: outTombs, fileNames: Object.keys(files) };
  }

  // Push state as chunk files, deleting any stale chunk files from a previous larger set.
  async function syncPush(state, prevFileNames) {
    const files = buildChunkFiles(state);
    (prevFileNames || []).forEach((n) => { if (CHUNK_RE.test(n) && !files[n]) files[n] = null; });
    const res = await fetchWithTimeout("https://api.github.com/gists/" + getGistId(), {
      method: "PATCH", headers: ghHeaders(), body: JSON.stringify({ files: files }),
    }, 30000);
    if (!res.ok) throw new Error("Push failed: GitHub API " + res.status);
  }

  // Last-write-wins merge of two {docs, tombstones} states, honouring deletions.
  function mergeStates(local, remote) {
    const tombs = Object.assign({}, local.tombstones || {});
    for (const [id, t] of Object.entries(remote.tombstones || {})) {
      tombs[id] = Math.max(tombs[id] || 0, t);
    }
    const docsOut = {};
    const ids = new Set([...Object.keys(local.docs || {}), ...Object.keys(remote.docs || {})]);
    for (const id of ids) {
      const a = (local.docs || {})[id], b = (remote.docs || {})[id];
      const winner = (a && b) ? (b.updated > a.updated ? b : a) : (a || b);
      if (!winner) continue;
      const tomb = tombs[id] || 0;
      if (winner.updated >= tomb) {
        docsOut[id] = winner;
        if (tomb) delete tombs[id]; // doc is newer than its deletion -> the delete is stale
      }
    }
    return { docs: docsOut, tombstones: tombs };
  }

  // Replace local state with a merged result and refresh the UI (without clobbering active edits).
  function applyMerged(merged) {
    applyingRemote = true;
    docs = merged.docs;
    tombstones = merged.tombstones;
    persist().catch((e) => console.error("Save after merge failed", e));
    persistTombs();
    applyingRemote = false;

    refreshDocSelect(true);
    if (currentId && docs[currentId]) {
      if (!dirty) {
        const d = docs[currentId];
        if (editor.innerHTML !== d.html) { editor.innerHTML = d.html; buildToc(); }
        if (titleInput.value !== d.title) titleInput.value = d.title;
      }
    } else if (currentId && !docs[currentId]) {
      const ids = Object.keys(docs);
      if (ids.length) openDoc(ids[0]); else newDoc("Welcome", welcomeHtml());
    }
  }

  // Full sync: pull -> merge -> apply -> push. `silent` suppresses pop-ups (used for auto-sync).
  async function syncNow(silent) {
    if (!syncConfigured()) { if (!silent) openSyncModal(); return; }
    if (syncBusy) { if (!silent) toast("A sync is already in progress\u2026", "info"); return; }
    syncBusy = true;
    const watchdog = setTimeout(() => { syncBusy = false; }, 40000); // never stay stuck
    setSyncStatus("syncing");
    try {
      if (currentId && dirty) saveCurrent();
      const remote = await syncPull();
      const merged = mergeStates({ docs: docs, tombstones: tombstones }, remote);
      applyMerged(merged);
      await syncPush(merged, remote.fileNames);
      setSyncMeta(Date.now());
      setSyncStatus("ok");
      updateSyncModal();
      if (!silent) toast("Synced \u2713  " + Object.keys(docs).length + " document(s)");
    } catch (e) {
      console.error("Sync failed", e);
      setSyncStatus("error", e);
      updateSyncModal(e);
      const msg = (e && e.name === "AbortError") ? "Network timed out" : (e && e.message ? e.message : String(e));
      toast("Sync failed: " + msg, "error");
    } finally {
      clearTimeout(watchdog);
      syncBusy = false;
    }
  }

  // Debounced auto-sync after local changes.
  function scheduleAutoSync() {
    if (applyingRemote || !syncEnabled() || !syncConfigured()) return;
    clearTimeout(autoTimer);
    autoTimer = setTimeout(() => syncNow(true), 2500);
  }

  // ----- Sync setup dialog -----
  let syncModal = null;
  function ensureSyncModal() {
    if (syncModal) return syncModal;
    syncModal = document.createElement("div");
    syncModal.className = "sync-modal";
    syncModal.hidden = true;
    syncModal.innerHTML =
      '<div class="sync-card">' +
        '<div class="sync-head"><b>\u2601 Cloud sync</b> <button class="sync-x" title="Close">\u2715</button></div>' +
        '<p class="sync-note">Sync your whole library to a <b>private GitHub Gist</b> so you can open it on any device (including your phone). ' +
          'Paste a GitHub token with the <code>gist</code> scope. It is stored only in this browser.</p>' +
        '<label class="sync-row">Token <input type="password" id="syncTokenInp" placeholder="ghp_\u2026 (gist scope)" autocomplete="off" /></label>' +
        '<label class="sync-row">Gist ID <input type="text" id="syncGistInp" placeholder="(leave blank and Create a new gist)" autocomplete="off" /></label>' +
        '<div class="sync-actions">' +
          '<button id="syncCreateBtn" class="sync-btn2">Create new private gist</button>' +
          '<button id="syncSaveBtn" class="sync-btn2">Save</button>' +
        '</div>' +
        '<label class="sync-check"><input type="checkbox" id="syncEnableChk" /> Auto-sync after every change and on startup</label>' +
        '<div class="sync-actions">' +
          '<button id="syncNowBtn" class="sync-btn2 primary">Sync now</button>' +
          '<button id="syncDisconnectBtn" class="sync-btn2 danger">Disconnect</button>' +
        '</div>' +
        '<div class="sync-status" id="syncStatusLine"></div>' +
      '</div>';
    document.body.appendChild(syncModal);
    syncModal.addEventListener("click", (e) => { if (e.target === syncModal) closeSyncModal(); });
    syncModal.querySelector(".sync-x").addEventListener("click", closeSyncModal);

    $("#syncSaveBtn").addEventListener("click", () => {
      localStorage.setItem(LS_SYNC_TOKEN, syncModal.querySelector("#syncTokenInp").value.trim());
      localStorage.setItem(LS_SYNC_GIST, syncModal.querySelector("#syncGistInp").value.trim());
      localStorage.setItem(LS_SYNC_ON, syncModal.querySelector("#syncEnableChk").checked ? "1" : "0");
      updateSyncModal();
      setSyncStatus(syncConfigured() ? (syncEnabled() ? "ok" : "off") : "off");
      flashSyncStatus("Saved.");
    });
    syncModal.querySelector("#syncEnableChk").addEventListener("change", (e) => {
      localStorage.setItem(LS_SYNC_ON, e.target.checked ? "1" : "0");
    });
    syncModal.querySelector("#syncCreateBtn").addEventListener("click", createGist);
    syncModal.querySelector("#syncNowBtn").addEventListener("click", () => {
      // Persist field values first so Sync uses them.
      localStorage.setItem(LS_SYNC_TOKEN, syncModal.querySelector("#syncTokenInp").value.trim());
      localStorage.setItem(LS_SYNC_GIST, syncModal.querySelector("#syncGistInp").value.trim());
      syncNow(false);
    });
    syncModal.querySelector("#syncDisconnectBtn").addEventListener("click", () => {
      if (!confirm("Disconnect cloud sync on this device? Your local documents stay; the gist is not deleted.")) return;
      localStorage.removeItem(LS_SYNC_TOKEN);
      localStorage.removeItem(LS_SYNC_GIST);
      localStorage.setItem(LS_SYNC_ON, "0");
      updateSyncModal();
      setSyncStatus("off");
    });
    return syncModal;
  }

  async function createGist() {
    const token = syncModal.querySelector("#syncTokenInp").value.trim();
    if (!token) { flashSyncStatus("Enter a token first.", true); return; }
    localStorage.setItem(LS_SYNC_TOKEN, token);
    flashSyncStatus("Creating gist\u2026");
    try {
      const body = {
        description: "JLou Content Manager - synced library",
        public: false,
        files: buildChunkFiles({ docs: docs, tombstones: tombstones }),
      };
      const res = await fetchWithTimeout("https://api.github.com/gists", {
        method: "POST", headers: ghHeaders(), body: JSON.stringify(body),
      }, 30000);
      if (!res.ok) throw new Error("GitHub API " + res.status);
      const data = await res.json();
      localStorage.setItem(LS_SYNC_GIST, data.id);
      localStorage.setItem(LS_SYNC_ON, "1");
      updateSyncModal();
      setSyncMeta(Date.now());
      setSyncStatus("ok");
      flashSyncStatus("Gist created and library uploaded. Use this same token + Gist ID on your other devices.");
      toast("Private gist created \u2713  Auto-sync is on.");
    } catch (e) {
      console.error(e);
      const msg = (e && e.name === "AbortError") ? "Network timed out" : (e && e.message ? e.message : String(e));
      flashSyncStatus("Could not create gist: " + msg, true);
      toast("Could not create gist: " + msg, "error");
    }
  }

  function flashSyncStatus(msg, isErr) {
    const el = syncModal && syncModal.querySelector("#syncStatusLine");
    if (!el) return;
    el.textContent = msg;
    el.style.color = isErr ? "#dc2626" : "#334155";
  }
  function updateSyncModal(err) {
    if (!syncModal) return;
    syncModal.querySelector("#syncTokenInp").value = getToken();
    syncModal.querySelector("#syncGistInp").value = getGistId();
    syncModal.querySelector("#syncEnableChk").checked = syncEnabled();
    if (err) { flashSyncStatus("Sync error: " + (err.message || err), true); return; }
    const meta = getSyncMeta();
    const n = Object.keys(docs).length;
    flashSyncStatus((meta ? "Last synced " + new Date(meta).toLocaleString() + ". " : "") + n + " document(s) locally.");
  }
  function openSyncModal() { ensureSyncModal(); updateSyncModal(); syncModal.hidden = false; }
  function closeSyncModal() { if (syncModal) syncModal.hidden = true; }

  // ---------- Wire up UI ----------
  $("#toolbar").addEventListener("mousedown", (e) => {
    // Keep the editor selection when opening a colour palette (button won't steal focus).
    const cb = e.target.closest('button[data-cmd="forecolor"],button[data-cmd="hilite"],button[data-cmd="fontsize"],button[data-cmd="table"]');
    if (cb) { saveColorSel(); e.preventDefault(); }
  });
  $("#toolbar").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-cmd]");
    if (btn) exec(btn.getAttribute("data-cmd"), btn);
  });
  $("#newDocBtn").addEventListener("click", () => newDoc());
  $("#deleteDocBtn").addEventListener("click", deleteCurrent);
  $("#renameDocBtn").addEventListener("click", renameCurrent);
  docSelect.addEventListener("change", () => { saveCurrent(); openDoc(docSelect.value); });

  const importSelect = $("#importSelect");
  importSelect.addEventListener("change", () => {
    const kind = importSelect.value;
    importSelect.value = "";           // reset so same choice can be re-picked
    if (kind === "txt") pickFile(".txt,text/plain", importTextFile);
    else if (kind === "html") pickFile(".html,.htm,text/html", importHtmlFile);
    else if (kind === "htmldir") pickDir(importHtmlFolder);
    else if (kind === "docx") pickFile(".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document", importDocxFile);
  });
  $("#exportBtn").addEventListener("click", exportHtml);
  $("#backupBtn").addEventListener("click", backupAll);
  $("#restoreBtn").addEventListener("click", () => pickFile(".json,application/json", restoreFromFile));
  $("#helpBtn").addEventListener("click", showHelp);
  var versionBadge = document.getElementById("versionBadge");
  if (versionBadge) versionBadge.addEventListener("click", showHelp);
  $("#libraryBtn").addEventListener("click", openLibrary);
  $("#syncBtn").addEventListener("click", openSyncModal);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && syncModal && !syncModal.hidden) closeSyncModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && libraryModal && !libraryModal.hidden) closeLibrary();
  });

  editor.addEventListener("input", markDirty);
  titleInput.addEventListener("input", markDirty);

  // Ctrl+S saves
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      saveCurrent();
    }
  });
  window.addEventListener("beforeunload", () => { if (dirty) saveCurrent(); });

  // ---------- Boot ----------
  (async function boot() {
    try {
      _db = await idbOpen();
      let stored = await idbGet(DB_KEY_DOCS);
      if (stored === undefined || stored === null) {
        // One-time migration from the older localStorage store.
        const legacy = loadDocsLS();
        if (legacy && Object.keys(legacy).length) {
          stored = legacy;
          try { await idbSet(DB_KEY_DOCS, stored); } catch (_) {}
        } else {
          stored = {};
        }
      }
      docs = stored || {};
      let tombs = await idbGet(DB_KEY_TOMBS);
      tombstones = tombs || {};
    } catch (e) {
      console.error("IndexedDB unavailable - using localStorage fallback", e);
      _db = null;
      docs = loadDocsLS();
      try { tombstones = JSON.parse(localStorage.getItem(DB_KEY_TOMBS)) || {}; } catch (_) { tombstones = {}; }
    }

    refreshDocSelect();
    const last = localStorage.getItem(LS_LAST);
    const ids = Object.keys(docs);
    if (last && docs[last]) openDoc(last);
    else if (ids.length) openDoc(ids[0]);
    else newDoc("Welcome", welcomeHtml());

    // Cloud sync: show status and, if configured + enabled, pull/merge on startup.
    setSyncStatus(syncConfigured() ? (syncEnabled() ? "ok" : "off") : "off");
    if (syncEnabled() && syncConfigured()) syncNow(true);
    window.addEventListener("focus", () => {
      if (!(syncEnabled() && syncConfigured())) return;
      const now = Date.now();
      if (now - lastFocusSync < 10000) return; // throttle refocus pulls
      lastFocusSync = now;
      syncNow(true);
    });
  })();
})();

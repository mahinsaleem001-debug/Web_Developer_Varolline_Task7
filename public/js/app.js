/* Taskflow front end. One state object, hash routing (#/login, #/boards, #/board/ID).
   Board changes are saved without reloads: drag-and-drop is optimistic (UI moves first,
   rolls back with a Retry toast if the server says no); everything else shows a pending
   state and clear errors. A light poll picks up changes made by teammates. */
(function () {
  'use strict';
  const { el, icon, toast, confirmDialog, avatar, todayISO, dueLabel, timeAgo } = window.UI;
  const V = window.Validate;

  const state = {
    user: null, boards: null, board: null, knownVersion: 0,
    filter: { q: '', mine: false }, pending: 0, drag: null, openTaskId: null
  };
  const $ = (id) => document.getElementById(id);
  const view = $('view');
  const PRIORITY_LABEL = { low: 'Low', medium: 'Medium', high: 'High' };

  /* =============== helpers =============== */
  const msgOf = (e) => (e && e.message) || 'Something went wrong.';
  const sorted = (tasks) => tasks.slice().sort((a, b) => a.position - b.position || a.id - b.id);
  const colTasks = (colId) => sorted(state.board.tasks.filter((t) => t.columnId === colId));
  const memberById = (id) => state.board && state.board.members.find((m) => m.id === id);
  const isOwner = () => state.board && state.board.role === 'owner';
  const taskById = (id) => state.board && state.board.tasks.find((t) => t.id === id);

  async function tracked(fn) { // counts in-flight requests so polling never overwrites an unsaved change
    state.pending++;
    try { return await fn(); } finally { state.pending--; }
  }

  function setBusy(btn, busy, label) {
    if (!btn) return;
    if (busy) { btn.dataset.label = btn.textContent; btn.textContent = label || 'Saving…'; btn.disabled = true; btn.classList.add('busy'); }
    else { if (btn.dataset.label) btn.textContent = btn.dataset.label; btn.disabled = false; btn.classList.remove('busy'); }
  }

  function showFieldErrors(form, fields, fallback) {
    form.querySelectorAll('.field-error').forEach((n) => n.remove());
    form.querySelectorAll('[aria-invalid]').forEach((n) => n.removeAttribute('aria-invalid'));
    let first = null;
    Object.keys(fields || {}).forEach((name) => {
      const input = form.elements[name];
      if (!input) return;
      input.setAttribute('aria-invalid', 'true');
      const err = el('p', { class: 'field-error', text: fields[name], id: 'err-' + name + '-' + Math.random().toString(36).slice(2, 7) });
      input.setAttribute('aria-describedby', err.id);
      input.insertAdjacentElement('afterend', err);
      first = first || input;
    });
    let banner = form.querySelector('.form-error');
    if (banner) banner.remove();
    if (fallback) {
      banner = el('p', { class: 'form-error', role: 'alert', text: fallback });
      form.prepend(banner);
    }
    if (first) first.focus();
  }

  function field(label, input, hint) {
    const id = 'f-' + (input.name || Math.random().toString(36).slice(2, 7));
    input.id = id;
    return el('div', { class: 'field' }, [el('label', { for: id, text: label }), input, hint ? el('p', { class: 'hint', text: hint }) : null]);
  }

  /* =============== auth state, session expiry =============== */
  window.Api.onUnauthorized = () => {
    if (!state.user) return;
    state.user = null; state.board = null; state.boards = null;
    stopPolling();
    toast('Your session has expired. Please log in again.', { type: 'error' });
    location.hash = '#/login';
    route();
  };
  window.Api.onBoardVersion = (boardId, v) => {
    if (state.board && state.board.board.id === boardId && v === state.knownVersion + 1) state.knownVersion = v;
  };

  /* =============== top bar =============== */
  function renderTopbar() {
    const bar = $('topbar');
    if (!state.user) { bar.hidden = true; bar.replaceChildren(); return; }
    bar.hidden = false;
    const dark = document.documentElement.getAttribute('data-theme') === 'dark';
    bar.replaceChildren(
      el('a', { href: '#/boards', class: 'brand', 'aria-label': 'Taskflow home' }, [el('span', { class: 'logo' }, icon('layout', 20)), el('span', { class: 'brand-name', text: 'Taskflow' })]),
      el('div', { class: 'spacer' }),
      el('div', { class: 'who' }, [avatar(state.user, 30), el('span', { class: 'who-name hide-sm', text: state.user.name })]),
      el('button', { type: 'button', class: 'btn icon', id: 'theme', 'aria-label': dark ? 'Switch to light theme' : 'Switch to dark theme', onclick: toggleTheme }, icon(dark ? 'sun' : 'moon')),
      el('button', { type: 'button', class: 'btn', onclick: logout }, [icon('logout', 16), el('span', { class: 'hide-sm', text: 'Log out' })])
    );
  }
  function toggleTheme() {
    const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem('taskflow-theme', next); } catch (e) { /* ignore */ }
    renderTopbar();
  }
  async function logout() {
    try { await window.Api.post('/api/auth/logout'); } catch (e) { /* session cookie is cleared server-side; ignore network errors */ }
    state.user = null; state.board = null; state.boards = null;
    stopPolling();
    location.hash = '#/login';
    route();
  }

  /* =============== router =============== */
  function parseRoute() {
    const h = location.hash.replace(/^#/, '') || '/';
    const parts = h.split('/').filter(Boolean);
    if (parts[0] === 'board' && /^\d+$/.test(parts[1] || '')) return { name: 'board', id: Number(parts[1]) };
    if (parts[0] === 'boards') return { name: 'boards' };
    if (parts[0] === 'signup') return { name: 'signup' };
    if (parts[0] === 'login') return { name: 'login' };
    return { name: state.user ? 'boards' : 'login' };
  }
  function route() {
    const r = parseRoute();
    renderTopbar();
    stopPolling();
    if (!state.user && r.name !== 'login' && r.name !== 'signup') { location.hash = '#/login'; return; }
    if (state.user && (r.name === 'login' || r.name === 'signup')) { location.hash = '#/boards'; return; }
    if (r.name !== 'board') state.board = null;
    if (r.name === 'login' || r.name === 'signup') renderAuth(r.name);
    else if (r.name === 'boards') showBoards();
    else showBoard(r.id);
    document.title = (r.name === 'board' ? 'Board' : r.name === 'boards' ? 'Your boards' : r.name === 'signup' ? 'Sign up' : 'Log in') + ' · Taskflow';
  }
  window.addEventListener('hashchange', route);

  /* =============== auth screens =============== */
  function renderAuth(mode) {
    const signup = mode === 'signup';
    const form = el('form', { class: 'auth-form', novalidate: true, 'aria-labelledby': 'auth-title' });
    const name = el('input', { name: 'name', type: 'text', autocomplete: 'name', maxlength: 50 });
    const email = el('input', { name: 'email', type: 'email', autocomplete: 'email', maxlength: 120 });
    const pw = el('input', { name: 'password', type: 'password', autocomplete: signup ? 'new-password' : 'current-password', maxlength: 72 });
    const submit = el('button', { type: 'submit', class: 'btn primary wide', text: signup ? 'Create account' : 'Log in' });
    if (signup) form.append(field('Full name', name));
    form.append(
      field('Email', email),
      field('Password', pw, signup ? 'At least 8 characters, with a letter and a number.' : null),
      submit
    );
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const payload = { name: name.value, email: email.value, password: pw.value };
      const v = (signup ? V.signup : V.login)(payload);
      if (!v.ok) return showFieldErrors(form, v.errors);
      showFieldErrors(form, {});
      setBusy(submit, true, signup ? 'Creating account…' : 'Logging in…');
      try {
        const data = await window.Api.post(signup ? '/api/auth/signup' : '/api/auth/login', v.value, { noAuthRedirect: true });
        state.user = data.user;
        location.hash = '#/boards';
        route();
      } catch (e) {
        showFieldErrors(form, e.fields, e.fields ? null : msgOf(e));
        setBusy(submit, false);
      }
    });

    const mock = el('div', { class: 'mock', 'aria-hidden': 'true' }, [
      ['To do', ['Write launch email', 'Fix mobile menu'], ''], ['In progress', ['Design pricing page'], 'high'], ['Done', ['Pick colours', 'Buy domain'], 'low']
    ].map((c) => el('div', { class: 'mock-col' }, [el('b', { text: c[0] })].concat(c[1].map((t, i) => el('div', { class: 'mock-card' }, [el('span', { text: t }), el('i', { class: 'dot ' + (c[2] || (i ? 'low' : 'medium')) })]))))));

    view.replaceChildren(el('div', { class: 'auth' }, [
      el('section', { class: 'auth-hero' }, [
        el('div', { class: 'brand light' }, [el('span', { class: 'logo' }, icon('layout', 22)), el('span', { class: 'brand-name', text: 'Taskflow' })]),
        el('h1', { text: 'Plan work together, one card at a time.' }),
        el('p', { text: 'Boards, lists, tasks, comments and teammates, all in one place. Drag a card and it is saved instantly.' }),
        mock
      ]),
      el('section', { class: 'auth-card' }, [
        el('h2', { id: 'auth-title', text: signup ? 'Create your account' : 'Welcome back' }),
        el('p', { class: 'muted', text: signup ? 'Start your first board in under a minute.' : 'Log in to see your boards.' }),
        form,
        el('p', { class: 'switch' }, [signup ? 'Already have an account? ' : 'New to Taskflow? ', el('a', { href: signup ? '#/login' : '#/signup', text: signup ? 'Log in' : 'Create an account' })])
      ])
    ]));
    (signup ? name : email).focus();
  }

  /* =============== boards list =============== */
  async function showBoards() {
    view.replaceChildren(el('div', { class: 'page' }, [
      el('div', { class: 'page-head' }, el('h1', { text: 'Your boards' })),
      el('div', { class: 'board-grid' }, [1, 2, 3].map(() => el('div', { class: 'board-card skeleton' })))
    ]));
    try {
      state.boards = (await window.Api.get('/api/boards')).boards;
    } catch (e) {
      if (e.status === 401) return;
      return view.replaceChildren(errorState('Could not load your boards', msgOf(e), showBoards));
    }
    renderBoards();
  }

  function errorState(title, message, retry) {
    return el('div', { class: 'state card' }, [
      el('div', { class: 'state-icon danger' }, icon('alert', 28)),
      el('h2', { text: title }), el('p', { class: 'muted', text: message }),
      retry ? el('button', { type: 'button', class: 'btn primary', text: 'Try again', onclick: retry }) : null
    ]);
  }

  function renderBoards() {
    const grid = el('div', { class: 'board-grid' });
    state.boards.forEach((b) => {
      grid.append(el('a', { class: 'board-card', href: '#/board/' + b.id }, [
        el('div', { class: 'bc-top' }, [el('h2', { text: b.name }), el('span', { class: 'pill ' + (b.role === 'owner' ? 'owner' : ''), text: b.role === 'owner' ? 'Owner' : 'Member' })]),
        el('p', { class: 'bc-desc', text: b.description || 'No description' }),
        el('div', { class: 'bc-meta' }, [el('span', {}, [icon('users', 15), ' ' + b.memberCount + (b.memberCount === 1 ? ' member' : ' members')]), el('span', {}, [icon('check', 15), ' ' + b.taskCount + (b.taskCount === 1 ? ' task' : ' tasks')])])
      ]));
    });
    const newBtn = el('button', { type: 'button', class: 'board-card new', onclick: openBoardDialog }, [icon('plus', 22), el('span', { text: 'New board' })]);
    grid.append(newBtn);
    view.replaceChildren(el('div', { class: 'page' }, [
      el('div', { class: 'page-head' }, [el('div', {}, [el('h1', { text: 'Your boards' }), el('p', { class: 'muted', text: 'You only see boards you belong to.' })]),
        el('button', { type: 'button', class: 'btn primary', onclick: openBoardDialog }, [icon('plus', 16), ' New board'])]),
      state.boards.length ? null : el('div', { class: 'empty-note card' }, [el('h2', { text: 'No boards yet' }), el('p', { class: 'muted', text: 'Create your first board to start adding lists and tasks, or ask a teammate to invite you to theirs.' })]),
      grid
    ]));
  }

  let dlgCancel = null; // the Esc handler of the task dialog (removed when another dialog opens)
  function openDialog(content, opts) {
    const dlg = $('dlg');
    if (dlgCancel) { dlg.removeEventListener('cancel', dlgCancel); dlgCancel = null; }
    dlg.className = 'dlg' + (opts && opts.wide ? ' wide' : '');
    dlg.replaceChildren(content);
    if (opts && opts.onClose) dlg.addEventListener('close', opts.onClose, { once: true });
    if (!dlg.open) dlg.showModal();
    return dlg;
  }
  const closeDialog = () => { const d = $('dlg'); if (d.open) d.close(); };
  const dlgHead = (title, onClose) => el('div', { class: 'dlg-head' }, [el('h2', { text: title }), el('button', { type: 'button', class: 'btn icon ghost', 'aria-label': 'Close', onclick: onClose || closeDialog }, icon('x'))]);

  function openBoardDialog(existing) {
    const editing = existing && existing.id;
    const form = el('form', { novalidate: true });
    const name = el('input', { name: 'name', type: 'text', maxlength: 60, value: editing ? existing.name : '' });
    const desc = el('textarea', { name: 'description', rows: 3, maxlength: 200 });
    desc.value = editing ? existing.description || '' : '';
    const submit = el('button', { type: 'submit', class: 'btn primary', text: editing ? 'Save' : 'Create board' });
    form.append(field('Board name', name), field('Description (optional)', desc), el('div', { class: 'dlg-actions' }, [el('button', { type: 'button', class: 'btn', text: 'Cancel', onclick: closeDialog }), submit]));
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const v = V.board({ name: name.value, description: desc.value });
      if (!v.ok) return showFieldErrors(form, v.errors);
      showFieldErrors(form, {});
      setBusy(submit, true);
      try {
        if (editing) {
          const r = await tracked(() => window.Api.patch('/api/boards/' + existing.id, v.value));
          state.board.board.name = r.board.name; state.board.board.description = r.board.description;
          closeDialog(); renderBoardView(); toast('Board updated.', { type: 'success' });
        } else {
          const r = await window.Api.post('/api/boards', v.value);
          closeDialog(); location.hash = '#/board/' + r.board.id;
        }
      } catch (e) { showFieldErrors(form, e.fields, e.fields ? null : msgOf(e)); setBusy(submit, false); }
    });
    openDialog(el('div', {}, [dlgHead(editing ? 'Edit board' : 'New board'), form]));
    name.focus();
  }

  /* =============== board =============== */
  let pollTimer = null;
  function stopPolling() { clearInterval(pollTimer); pollTimer = null; }
  function startPolling(id) {
    stopPolling();
    pollTimer = setInterval(async () => {
      if (!state.board || state.board.board.id !== id || document.hidden || state.pending || state.drag) return;
      const a = document.activeElement;
      if (a && view.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) return; // user is typing on the board
      try {
        const { version } = await window.Api.get('/api/boards/' + id + '/version');
        if (version !== state.knownVersion) await loadBoard(id, true);
      } catch (e) {
        if (e.status === 404) { toast('You no longer have access to that board.', { type: 'error' }); closeDialog(); location.hash = '#/boards'; }
      }
    }, 5000);
  }

  async function loadBoard(id, silent) {
    const data = await window.Api.get('/api/boards/' + id);
    state.board = data;
    state.knownVersion = data.board.version;
    if (silent) {
      renderBoardView();
      if (state.openTaskId) refreshOpenTask();
    }
    return data;
  }

  async function showBoard(id) {
    view.replaceChildren(el('div', { class: 'page wide' }, [
      el('div', { class: 'page-head' }, el('div', { class: 'sk sk-title' })),
      el('div', { class: 'cols' }, [1, 2, 3].map(() => el('div', { class: 'col skeleton' })))
    ]));
    try { await loadBoard(id, false); }
    catch (e) {
      if (e.status === 401) return;
      return view.replaceChildren(errorState(e.status === 404 ? 'Board not found' : 'Could not load this board',
        e.status === 404 ? 'It may have been deleted, or you are not a member of it.' : msgOf(e), e.status === 404 ? null : () => showBoard(id)),
        el('p', { class: 'center' }, el('a', { href: '#/boards', text: 'Back to your boards' })));
    }
    document.title = state.board.board.name + ' · Taskflow';
    renderBoardView();
    startPolling(id);
  }

  function matchesFilter(t) {
    const f = state.filter;
    if (f.mine && t.assigneeId !== state.user.id) return false;
    if (f.q) {
      const q = f.q.toLowerCase();
      const a = memberById(t.assigneeId);
      if (!(t.title.toLowerCase().includes(q) || (t.description || '').toLowerCase().includes(q) || (a && a.name.toLowerCase().includes(q)))) return false;
    }
    return true;
  }

  function renderBoardView() {
    const b = state.board;
    const keepScroll = view.querySelector('.cols') ? view.querySelector('.cols').scrollLeft : 0;
    const head = el('div', { class: 'page-head board-head' }, [
      el('div', { class: 'bh-left' }, [
        el('a', { href: '#/boards', class: 'back' }, [icon('back', 16), ' Boards']),
        el('h1', { text: b.board.name }),
        b.board.description ? el('p', { class: 'muted', text: b.board.description }) : null
      ]),
      el('div', { class: 'bh-right' }, [
        el('button', { type: 'button', class: 'members-btn', 'aria-label': 'Members (' + b.members.length + ')', onclick: openMembersDialog }, [
          el('span', { class: 'stack' }, b.members.slice(0, 4).map((m) => avatar(m, 28))),
          el('span', { class: 'hide-sm', text: b.members.length + (b.members.length === 1 ? ' member' : ' members') })
        ]),
        isOwner() ? el('button', { type: 'button', class: 'btn icon', 'aria-label': 'Edit board', title: 'Edit board', onclick: () => openBoardDialog(b.board) }, icon('edit')) : null,
        isOwner() ? el('button', { type: 'button', class: 'btn icon danger-ghost', 'aria-label': 'Delete board', title: 'Delete board', onclick: deleteBoard }, icon('trash')) : null
      ])
    ]);

    const search = el('input', { type: 'search', class: 'search', placeholder: 'Search tasks…', 'aria-label': 'Search tasks', value: state.filter.q });
    search.addEventListener('input', () => { state.filter.q = search.value.trim(); renderColumns(); });
    const mine = el('button', { type: 'button', class: 'chip', 'aria-pressed': String(state.filter.mine), text: 'My tasks' });
    mine.addEventListener('click', () => { state.filter.mine = !state.filter.mine; mine.setAttribute('aria-pressed', String(state.filter.mine)); renderColumns(); });
    const bar = el('div', { class: 'filter-bar' }, [el('div', { class: 'search-wrap' }, [icon('search', 16), search]), mine, el('p', { class: 'hint hide-sm', text: 'Tip: drag cards between lists. Keyboard: focus a card and press Alt + arrow keys.' })]);

    view.replaceChildren(el('div', { class: 'page wide' }, [head, bar, el('div', { class: 'cols', id: 'cols' })]));
    renderColumns();
    view.querySelector('.cols').scrollLeft = keepScroll;
  }

  async function deleteBoard() {
    const ok = await confirmDialog({ title: 'Delete this board?', message: 'All lists, tasks and comments on "' + state.board.board.name + '" will be deleted for everyone. This cannot be undone.', confirmText: 'Delete board', danger: true });
    if (!ok) return;
    try { await tracked(() => window.Api.del('/api/boards/' + state.board.board.id)); toast('Board deleted.', { type: 'success' }); location.hash = '#/boards'; }
    catch (e) { toast(msgOf(e), { type: 'error' }); }
  }

  /* ---------- columns and cards ---------- */
  function renderColumns() {
    const box = $('cols');
    if (!box) return;
    const keep = box.scrollLeft;
    box.replaceChildren();
    state.board.columns.forEach((c) => box.append(columnEl(c)));
    box.append(addColumnEl());
    box.scrollLeft = keep;
  }

  function columnEl(c) {
    const all = colTasks(c.id);
    const shown = all.filter(matchesFilter);
    const filtering = state.filter.q || state.filter.mine;
    const body = el('div', { class: 'col-body', dataset: { col: c.id } });
    shown.forEach((t) => body.append(cardEl(t)));
    if (!shown.length) body.append(el('p', { class: 'col-empty', text: filtering && all.length ? 'No matching tasks' : 'No tasks yet' }));
    wireDropZone(body, c.id);

    const title = el('button', { type: 'button', class: 'col-title', title: 'Click to rename', onclick: () => renameColumn(c, title) }, [el('span', { text: c.name })]);
    const head = el('div', { class: 'col-head' }, [
      title,
      el('span', { class: 'count', 'aria-label': all.length + ' tasks', text: filtering ? shown.length + '/' + all.length : String(all.length) }),
      el('button', { type: 'button', class: 'btn icon ghost sm', 'aria-label': 'Delete list ' + c.name, title: 'Delete list', onclick: () => deleteColumn(c, all.length) }, icon('trash', 15))
    ]);
    const col = el('section', { class: 'col', 'aria-label': c.name + ', ' + all.length + ' tasks' }, [head, body, composerEl(c)]);
    return col;
  }

  function cardEl(t) {
    const a = memberById(t.assigneeId);
    const overdue = t.due && t.due < todayISO();
    const meta = el('div', { class: 'card-meta' }, [
      el('span', { class: 'prio ' + t.priority, title: PRIORITY_LABEL[t.priority] + ' priority' }, [el('i', { class: 'dot ' + t.priority }), PRIORITY_LABEL[t.priority]]),
      t.due ? el('span', { class: 'chip-sm' + (overdue ? ' overdue' : ''), title: overdue ? 'Overdue' : 'Due date' }, [icon('calendar', 13), ' ' + dueLabel(t.due)]) : null,
      t.commentCount ? el('span', { class: 'chip-sm', title: t.commentCount + ' comments' }, [icon('chat', 13), ' ' + t.commentCount]) : null,
      el('span', { class: 'grow' }),
      a ? avatar(a, 24) : null
    ]);
    const card = el('article', {
      class: 'card-task', draggable: true, tabindex: 0, role: 'button', dataset: { id: t.id },
      'aria-label': t.title + '. ' + PRIORITY_LABEL[t.priority] + ' priority.' + (a ? ' Assigned to ' + a.name + '.' : '') + ' Press Enter to open, Alt plus arrow keys to move.'
    }, [el('p', { class: 'card-title', text: t.title }), meta]);

    card.addEventListener('click', () => openTask(t.id));
    card.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); return openTask(t.id); }
      if (!ev.altKey || !/^Arrow/.test(ev.key)) return;
      ev.preventDefault();
      keyboardMove(t, ev.key);
    });
    card.addEventListener('dragstart', (ev) => {
      state.drag = { id: t.id, target: null };
      ev.dataTransfer.effectAllowed = 'move';
      ev.dataTransfer.setData('text/plain', String(t.id));
      setTimeout(() => card.classList.add('dragging'), 0);
    });
    card.addEventListener('dragend', endDrag);
    return card;
  }

  /* ---------- drag and drop ---------- */
  let dropLine = null;
  function endDrag() {
    state.drag = null;
    if (dropLine) { dropLine.remove(); dropLine = null; }
    document.querySelectorAll('.dragging, .drop-active').forEach((n) => n.classList.remove('dragging', 'drop-active'));
  }

  function wireDropZone(body, colId) {
    body.addEventListener('dragover', (ev) => {
      if (!state.drag) return;
      ev.preventDefault();
      ev.dataTransfer.dropEffect = 'move';
      body.classList.add('drop-active');
      // scroll the board sideways when the pointer is near its edges
      const cols = $('cols');
      const r = cols.getBoundingClientRect();
      if (ev.clientX < r.left + 70) cols.scrollLeft -= 18; else if (ev.clientX > r.right - 70) cols.scrollLeft += 18;

      const cards = Array.from(body.querySelectorAll('.card-task:not(.dragging)'));
      const before = cards.find((c) => ev.clientY < c.getBoundingClientRect().top + c.offsetHeight / 2) || null;
      const full = colTasks(colId).filter((t) => t.id !== state.drag.id);
      const index = before ? Math.max(0, full.findIndex((t) => t.id === Number(before.dataset.id))) : full.length;
      state.drag.target = { colId, index };
      if (!dropLine) dropLine = el('div', { class: 'drop-line' });
      const empty = body.querySelector('.col-empty');
      if (empty) empty.hidden = true;
      if (before) body.insertBefore(dropLine, before); else body.append(dropLine);
    });
    body.addEventListener('dragleave', (ev) => {
      if (!body.contains(ev.relatedTarget)) { body.classList.remove('drop-active'); if (dropLine) dropLine.remove(); const e = body.querySelector('.col-empty'); if (e) e.hidden = false; }
    });
    body.addEventListener('drop', (ev) => {
      ev.preventDefault();
      const d = state.drag;
      const target = d && d.target;
      endDrag();
      if (d && target) moveTask(d.id, target.colId, target.index);
    });
  }

  // Optimistic move: update the screen first, then tell the server. Roll back if it fails.
  function applyMoveLocally(taskId, colId, index) {
    const tasks = state.board.tasks;
    const t = tasks.find((x) => x.id === taskId);
    const from = t.columnId;
    const list = sorted(tasks.filter((x) => x.columnId === colId && x.id !== taskId));
    list.splice(Math.min(index, list.length), 0, t);
    t.columnId = colId;
    list.forEach((x, i) => { x.position = i + 1; });
    if (from !== colId) sorted(tasks.filter((x) => x.columnId === from)).forEach((x, i) => { x.position = i + 1; });
  }

  async function moveTask(taskId, colId, index, focusAfter) {
    const t = taskById(taskId);
    if (!t) return;
    const cur = colTasks(t.columnId);
    if (t.columnId === colId && cur.findIndex((x) => x.id === taskId) === Math.min(index, cur.length - 1)) return; // dropped where it was
    const snapshot = JSON.parse(JSON.stringify(state.board.tasks));
    applyMoveLocally(taskId, colId, index);
    renderColumns();
    if (focusAfter) { const n = view.querySelector('.card-task[data-id="' + taskId + '"]'); if (n) n.focus(); }
    try {
      await tracked(() => window.Api.post('/api/tasks/' + taskId + '/move', { columnId: colId, index }));
    } catch (e) {
      if (state.board) { state.board.tasks = snapshot; renderColumns(); }
      if (e.status === 401) return;
      toast('Could not move "' + t.title + '". It was put back. ' + msgOf(e), { type: 'error', action: e.status === 404 ? null : { label: 'Retry', onClick: () => moveTask(taskId, colId, index) } });
      if (e.status === 404 && state.board) loadBoard(state.board.board.id, true).catch(() => {});
    }
  }

  function keyboardMove(t, key) {
    const cols = state.board.columns;
    const ci = cols.findIndex((c) => c.id === t.columnId);
    const list = colTasks(t.columnId);
    const pos = list.findIndex((x) => x.id === t.id);
    if (key === 'ArrowUp' && pos > 0) moveTask(t.id, t.columnId, pos - 1, true);
    else if (key === 'ArrowDown' && pos < list.length - 1) moveTask(t.id, t.columnId, pos + 1, true);
    else if (key === 'ArrowLeft' && ci > 0) moveTask(t.id, cols[ci - 1].id, Math.min(pos, colTasks(cols[ci - 1].id).length), true);
    else if (key === 'ArrowRight' && ci < cols.length - 1) moveTask(t.id, cols[ci + 1].id, Math.min(pos, colTasks(cols[ci + 1].id).length), true);
  }

  /* ---------- list actions ---------- */
  function composerEl(c) {
    const wrap = el('div', { class: 'composer' });
    const openBtn = el('button', { type: 'button', class: 'add-task', onclick: open }, [icon('plus', 16), ' Add task']);
    wrap.append(openBtn);
    function open() {
      const input = el('textarea', { rows: 2, maxlength: 120, placeholder: 'What needs doing?', 'aria-label': 'New task title' });
      const add = el('button', { type: 'submit', class: 'btn primary sm', text: 'Add task' });
      const err = el('p', { class: 'field-error', hidden: true, role: 'alert' });
      const form = el('form', { class: 'composer-form', novalidate: true }, [input, err, el('div', { class: 'row' }, [add, el('button', { type: 'button', class: 'btn sm', text: 'Cancel', onclick: close })])]);
      function close() { wrap.replaceChildren(openBtn); }
      input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); form.requestSubmit(); } else if (ev.key === 'Escape') close(); });
      form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const v = V.task({ title: input.value }, false);
        if (!v.ok) { err.textContent = v.errors.title; err.hidden = false; input.focus(); return; }
        err.hidden = true; setBusy(add, true, 'Adding…'); input.disabled = true;
        try {
          const r = await tracked(() => window.Api.post('/api/columns/' + c.id + '/tasks', { title: v.value.title }));
          state.board.tasks.push(r.task);
          renderColumns();
          const again = view.querySelector('.col-body[data-col="' + c.id + '"]');
          if (again) again.closest('.col').querySelector('.add-task').click();
        } catch (e) {
          if (e.status === 401) return;
          input.disabled = false; setBusy(add, false);
          err.textContent = (e.fields && e.fields.title) || msgOf(e); err.hidden = false; input.focus();
        }
      });
      wrap.replaceChildren(form);
      input.focus();
    }
    return wrap;
  }

  function renameColumn(c, titleBtn) {
    const input = el('input', { class: 'col-rename', type: 'text', maxlength: 40, value: c.name, 'aria-label': 'List name' });
    let done = false;
    async function commit(save) {
      if (done) return; done = true;
      const name = input.value.trim();
      if (!save || name === c.name) return renderColumns();
      const v = V.column({ name });
      if (!v.ok) { toast(v.errors.name, { type: 'error' }); return renderColumns(); }
      const old = c.name; c.name = v.value.name; renderColumns();   // optimistic
      try { await tracked(() => window.Api.patch('/api/columns/' + c.id, { name: v.value.name })); }
      catch (e) { c.name = old; renderColumns(); if (e.status !== 401) toast('Could not rename the list. ' + msgOf(e), { type: 'error' }); }
    }
    input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') commit(true); else if (ev.key === 'Escape') commit(false); });
    input.addEventListener('blur', () => commit(true));
    titleBtn.replaceWith(input);
    input.focus(); input.select();
  }

  async function deleteColumn(c, n) {
    const ok = await confirmDialog({ title: 'Delete list "' + c.name + '"?', message: n ? n + (n === 1 ? ' task' : ' tasks') + ' in this list will be deleted too. This cannot be undone.' : 'This list is empty.', confirmText: 'Delete list', danger: true });
    if (!ok) return;
    try {
      await tracked(() => window.Api.del('/api/columns/' + c.id));
      state.board.columns = state.board.columns.filter((x) => x.id !== c.id);
      state.board.tasks = state.board.tasks.filter((t) => t.columnId !== c.id);
      renderColumns(); toast('List deleted.', { type: 'success' });
    } catch (e) { if (e.status !== 401) toast('Could not delete the list. ' + msgOf(e), { type: 'error' }); }
  }

  function addColumnEl() {
    const wrap = el('div', { class: 'col add-col' });
    const btn = el('button', { type: 'button', class: 'add-list', onclick: open }, [icon('plus', 16), ' Add another list']);
    wrap.append(btn);
    function open() {
      const input = el('input', { type: 'text', maxlength: 40, placeholder: 'List name', 'aria-label': 'New list name' });
      const add = el('button', { type: 'submit', class: 'btn primary sm', text: 'Add list' });
      const err = el('p', { class: 'field-error', hidden: true, role: 'alert' });
      const form = el('form', { novalidate: true }, [input, err, el('div', { class: 'row' }, [add, el('button', { type: 'button', class: 'btn sm', text: 'Cancel', onclick: () => wrap.replaceChildren(btn) })])]);
      form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const v = V.column({ name: input.value });
        if (!v.ok) { err.textContent = v.errors.name; err.hidden = false; return input.focus(); }
        setBusy(add, true, 'Adding…');
        try {
          const r = await tracked(() => window.Api.post('/api/boards/' + state.board.board.id + '/columns', { name: v.value.name }));
          state.board.columns.push(r.column); renderColumns();
        } catch (e) { if (e.status === 401) return; setBusy(add, false); err.textContent = msgOf(e); err.hidden = false; }
      });
      input.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') wrap.replaceChildren(btn); });
      wrap.replaceChildren(form); input.focus();
    }
    return wrap;
  }

  /* =============== members dialog =============== */
  function openMembersDialog() {
    const b = state.board;
    const list = el('ul', { class: 'member-list' });
    b.members.forEach((m) => {
      const mine = m.id === state.user.id;
      const canRemove = m.role !== 'owner' && (isOwner() || mine);
      list.append(el('li', {}, [
        avatar(m, 34),
        el('div', { class: 'ml-info' }, [el('strong', { text: m.name + (mine ? ' (you)' : '') }), el('span', { class: 'muted', text: m.email })]),
        el('span', { class: 'pill ' + (m.role === 'owner' ? 'owner' : ''), text: m.role === 'owner' ? 'Owner' : 'Member' }),
        canRemove ? el('button', { type: 'button', class: 'btn sm danger-ghost', text: mine ? 'Leave' : 'Remove', 'aria-label': (mine ? 'Leave board' : 'Remove ' + m.name), onclick: () => removeMember(m) }) : null
      ]));
    });
    const parts = [dlgHead('Board members'), list];
    if (isOwner()) {
      const email = el('input', { name: 'email', type: 'email', placeholder: 'teammate@example.com', maxlength: 120 });
      const add = el('button', { type: 'submit', class: 'btn primary', text: 'Invite' });
      const form = el('form', { class: 'invite', novalidate: true }, [field('Invite by email', email, 'They need a Taskflow account first.'), add]);
      form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const v = V.member({ email: email.value });
        if (!v.ok) return showFieldErrors(form, v.errors);
        showFieldErrors(form, {});
        setBusy(add, true, 'Inviting…');
        try {
          const r = await tracked(() => window.Api.post('/api/boards/' + b.board.id + '/members', v.value));
          state.board.members = r.members;
          toast('Invitation done. They can see this board now.', { type: 'success' });
          openMembersDialog(); renderBoardView();
        } catch (e) { setBusy(add, false); if (e.status !== 401) showFieldErrors(form, e.fields, e.fields ? null : msgOf(e)); }
      });
      parts.push(form);
    }
    openDialog(el('div', {}, parts));
  }

  async function removeMember(m) {
    const mine = m.id === state.user.id;
    const ok = await confirmDialog({ title: mine ? 'Leave this board?' : 'Remove ' + m.name + '?', message: mine ? 'You will lose access to this board. Tasks assigned to you become unassigned.' : m.name + ' will lose access, and their tasks become unassigned.', confirmText: mine ? 'Leave board' : 'Remove', danger: true });
    if (!ok) return;
    try {
      await tracked(() => window.Api.del('/api/boards/' + state.board.board.id + '/members/' + m.id));
      if (mine) { closeDialog(); toast('You left the board.', { type: 'success' }); location.hash = '#/boards'; return; }
      state.board.members = state.board.members.filter((x) => x.id !== m.id);
      state.board.tasks.forEach((t) => { if (t.assigneeId === m.id) t.assigneeId = null; });
      renderBoardView(); openMembersDialog(); toast(m.name + ' was removed.', { type: 'success' });
    } catch (e) { if (e.status !== 401) toast(msgOf(e), { type: 'error' }); }
  }

  /* =============== task dialog =============== */
  async function openTask(id) {
    const t = taskById(id);
    if (!t) return;
    state.openTaskId = id;
    const b = state.board;
    const form = el('form', { class: 'task-form', novalidate: true });
    const title = el('input', { name: 'title', type: 'text', maxlength: 120, value: t.title });
    const desc = el('textarea', { name: 'description', rows: 4, maxlength: 2000, placeholder: 'Add more detail…' });
    desc.value = t.description || '';
    const column = el('select', { name: 'columnId' }, b.columns.map((c) => el('option', { value: c.id, text: c.name, selected: c.id === t.columnId })));
    const prio = el('select', { name: 'priority' }, ['low', 'medium', 'high'].map((p) => el('option', { value: p, text: PRIORITY_LABEL[p], selected: p === t.priority })));
    const assignee = el('select', { name: 'assigneeId' }, [el('option', { value: '', text: 'Unassigned' })].concat(b.members.map((m) => el('option', { value: m.id, text: m.name, selected: m.id === t.assigneeId }))));
    const due = el('input', { name: 'due', type: 'date', value: t.due || '' });
    const save = el('button', { type: 'submit', class: 'btn primary', text: 'Save changes' });
    const del = el('button', { type: 'button', class: 'btn danger-ghost', onclick: () => deleteTask(t) }, [icon('trash', 15), ' Delete']);

    form.append(
      field('Title', title), field('Description', desc),
      el('div', { class: 'grid2' }, [field('List', column), field('Priority', prio), field('Assignee', assignee), field('Due date', due)]),
      el('div', { class: 'dlg-actions split' }, [del, el('div', { class: 'row' }, [el('button', { type: 'button', class: 'btn', text: 'Close', onclick: attemptClose }), save])])
    );

    const clist = el('ul', { class: 'comments', 'aria-live': 'polite' });
    const cbox = el('textarea', { name: 'body', rows: 2, maxlength: 1000, placeholder: 'Write a comment…', 'aria-label': 'New comment' });
    const cbtn = el('button', { type: 'submit', class: 'btn primary sm', text: 'Comment' });
    const cform = el('form', { class: 'comment-form', novalidate: true }, [cbox, el('div', { class: 'row end' }, cbtn)]);
    cbox.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); cform.requestSubmit(); } });

    const wrap = el('div', { class: 'task-dlg' }, [
      dlgHead('Task details', attemptClose), form,
      el('section', { class: 'comments-sec', 'aria-labelledby': 'cm-h' }, [el('h3', { id: 'cm-h', text: 'Comments' }), clist, cform])
    ]);
    wrap.taskUI = { clist, cform, cbox };

    let asking = false;
    async function attemptClose() {
      if (current() === original) return closeDialog();
      if (asking) return;
      asking = true;
      const discard = await confirmDialog({ title: 'Discard your changes?', message: 'You edited this task but did not save.', confirmText: 'Discard', danger: true });
      asking = false;
      if (discard) closeDialog();
    }
    const original = JSON.stringify([t.title, t.description || '', t.columnId, t.priority, t.assigneeId || '', t.due || '']);
    const current = () => JSON.stringify([title.value.trim(), desc.value.trim(), Number(column.value), prio.value, assignee.value === '' ? '' : Number(assignee.value), due.value]);

    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const patch = { title: title.value, description: desc.value, priority: prio.value, due: due.value || null, assigneeId: assignee.value === '' ? null : Number(assignee.value) };
      const v = V.task(patch, true);
      if (!v.ok) return showFieldErrors(form, v.errors);
      showFieldErrors(form, {});
      setBusy(save, true);
      try {
        const r = await tracked(() => window.Api.patch('/api/tasks/' + t.id, v.value));
        Object.assign(taskById(t.id), r.task);
        const newCol = Number(column.value);
        if (newCol !== t.columnId) {
          const end = state.board.tasks.filter((x) => x.columnId === newCol && x.id !== t.id).length;
          await tracked(() => window.Api.post('/api/tasks/' + t.id + '/move', { columnId: newCol, index: end }));
          applyMoveLocally(t.id, newCol, end);
        }
        state.openTaskId = null;
        closeDialog(); renderColumns(); toast('Task saved.', { type: 'success' });
      } catch (e) {
        setBusy(save, false);
        if (e.status === 401) return;
        showFieldErrors(form, e.fields, e.fields ? null : msgOf(e) + (e.network ? ' Your changes are still here, so you can try again.' : ''));
        if (e.status === 404) loadBoard(state.board.board.id, true).catch(() => {});
      }
    });

    cform.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const v = V.comment({ body: cbox.value });
      if (!v.ok) return showFieldErrors(cform, v.errors);
      showFieldErrors(cform, {});
      setBusy(cbtn, true, 'Posting…');
      try {
        const r = await tracked(() => window.Api.post('/api/tasks/' + t.id + '/comments', v.value));
        clist.append(commentEl(r.comment, t.id, clist));
        taskById(t.id).commentCount += 1; renderColumns();
        cbox.value = ''; setBusy(cbtn, false); cbox.focus();
      } catch (e) { setBusy(cbtn, false); if (e.status !== 401) showFieldErrors(cform, e.fields, e.fields ? null : msgOf(e)); }
    });

    openDialog(wrap, {
      wide: true,
      onClose: () => { state.openTaskId = null; }
    });
    // Esc / Close / X: ask before throwing away unsaved edits
    const dlg = $('dlg');
    dlgCancel = (ev) => { if (current() !== original) { ev.preventDefault(); attemptClose(); } };
    dlg.addEventListener('cancel', dlgCancel);
    title.focus();

    clist.replaceChildren(el('li', { class: 'muted', text: 'Loading comments…' }));
    try {
      const r = await window.Api.get('/api/tasks/' + t.id);
      fillComments(clist, r.comments, t.id);
    } catch (e) {
      clist.replaceChildren(el('li', { class: 'form-error' }, [msgOf(e) + ' ', el('button', { type: 'button', class: 'link', text: 'Retry', onclick: () => refreshOpenTask() })]));
    }
  }

  function fillComments(clist, comments, taskId) {
    clist.replaceChildren();
    if (!comments.length) clist.append(el('li', { class: 'muted empty-c', text: 'No comments yet. Start the conversation.' }));
    comments.forEach((c) => clist.append(commentEl(c, taskId, clist)));
  }

  function commentEl(c, taskId, clist) {
    const canDelete = c.author.id === state.user.id || isOwner();
    const li = el('li', { class: 'comment', dataset: { id: c.id } }, [
      avatar({ id: c.author.id, name: c.author.name }, 30),
      el('div', { class: 'c-body' }, [
        el('div', { class: 'c-head' }, [el('strong', { text: c.author.name }), el('span', { class: 'muted', text: timeAgo(c.createdAt) }),
          canDelete ? el('button', { type: 'button', class: 'link danger', text: 'Delete', 'aria-label': 'Delete comment by ' + c.author.name, onclick: async () => {
            try {
              await tracked(() => window.Api.del('/api/comments/' + c.id));
              li.remove(); const t = taskById(taskId); if (t) t.commentCount = Math.max(0, t.commentCount - 1); renderColumns();
              if (!clist.querySelector('.comment')) clist.append(el('li', { class: 'muted empty-c', text: 'No comments yet. Start the conversation.' }));
            } catch (e) { if (e.status !== 401) toast('Could not delete the comment. ' + msgOf(e), { type: 'error' }); }
          } }) : null]),
        el('p', { class: 'c-text', text: c.body })
      ])
    ]);
    const empty = clist.querySelector('.empty-c'); if (empty) empty.remove();
    return li;
  }

  async function refreshOpenTask() {
    const id = state.openTaskId;
    const clist = $('dlg').querySelector('.comments');
    if (!id || !clist) return;
    try { fillComments(clist, (await window.Api.get('/api/tasks/' + id)).comments, id); }
    catch (e) { if (e.status === 404) { closeDialog(); toast('That task was deleted by someone else.', { type: 'info' }); } }
  }

  async function deleteTask(t) {
    const ok = await confirmDialog({ title: 'Delete this task?', message: '"' + t.title + '" and its comments will be deleted. This cannot be undone.', confirmText: 'Delete task', danger: true });
    if (!ok) return;
    try {
      await tracked(() => window.Api.del('/api/tasks/' + t.id));
      state.board.tasks = state.board.tasks.filter((x) => x.id !== t.id);
      state.openTaskId = null; closeDialog(); renderColumns(); toast('Task deleted.', { type: 'success' });
    } catch (e) { if (e.status !== 401) toast('Could not delete the task. ' + msgOf(e), { type: 'error' }); }
  }

  /* =============== start =============== */
  window.addEventListener('offline', () => { $('offline').hidden = false; });
  window.addEventListener('online', () => { $('offline').hidden = true; toast('You are back online.', { type: 'success' }); });
  if (!navigator.onLine) $('offline').hidden = false;

  (async function init() {
    try { state.user = (await window.Api.get('/api/auth/me', { noAuthRedirect: true })).user; }
    catch (e) {
      state.user = null;
      if (e.network) { view.replaceChildren(errorState('Cannot reach the server', msgOf(e), () => location.reload())); return; }
    }
    route();
  })();
})();

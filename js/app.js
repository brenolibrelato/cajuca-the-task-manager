import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_KEY, REFRESH_MINUTES } from './config.js';
import {
  DEFAULT_FILTERS, todayISO, buildForest, descendants, ancestors, rootsFor,
  isFilterActive, isRowFilterActive, computeVisible, flatten, toggleNode,
  NO_PROJECT, filterRootsByProject, groupByProject,
} from './tree.js';
import { t, getLang, setLang, LANGS, fmtDate, applyStatic, translateError } from './i18n.js';

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);
const $ = sel => document.querySelector(sel);
const dlg = $('#modal');

// ---------- estado ----------
const state = {
  view: 'main',
  filters: { main: { ...DEFAULT_FILTERS }, history: { ...DEFAULT_FILTERS } },
  forest: { byId: new Map(), roots: [] },
  projects: [],
  members: [],          // compartilhamentos visíveis (project_members)
  users: [],            // usuários cadastrados (id, email)
  userId: null,
  collapsedProjects: new Set(),
  collapsed: new Set(),
  expanded: new Set(),
  leaving: new Set(),   // raízes recém-concluídas, ainda visíveis na tela principal
  busy: false,
};

const PERIODS = {
  main: [['all', 'period.all'], ['7', 'period.next7'], ['15', 'period.next15'], ['30', 'period.next30'], ['none', 'period.none']],
  history: [['all', 'period.all'], ['7', 'period.last7'], ['15', 'period.last15'], ['30', 'period.last30']],
};

// ---------- utilidades ----------
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let toastTimer;
function toast(msg, isError = false, action = null) {
  if (isError && dlg.open) {
    const box = dlg.querySelector('.m-error');
    if (box) { box.textContent = msg; box.hidden = false; return; }
  }
  const el = $('#toast');
  el.textContent = msg;
  if (action) {
    const b = document.createElement('button');
    b.className = 'toast-btn';
    b.textContent = action.label;
    b.addEventListener('click', () => { el.hidden = true; action.onClick(); });
    el.append(b);
  }
  el.className = 'toast' + (isError ? ' err' : '');
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, action ? 8000 : 5000);
}

function switchView(view) {
  state.view = view;
  document.querySelectorAll('.tab').forEach(tab => tab.classList.toggle('active', tab.dataset.view === view));
  render();
}

// Árvore que acabou de ser concluída: continua na tela por alguns segundos
// (em verde, sumindo aos poucos) antes de ir para o histórico.
const LEAVE_MS = 2500;
function announceFinished(roots) {
  roots.forEach(r => state.leaving.add(r.id));
  const msg = roots.length === 1
    ? t('done.movedOne', { title: roots[0].title })
    : t('done.movedMany', { n: roots.length });
  toast(msg, false, { label: t('done.viewHistory'), onClick: () => switchView('history') });
  setTimeout(() => {
    roots.forEach(r => state.leaving.delete(r.id));
    render();
  }, LEAVE_MS);
}

// Erros do banco chegam como texto da exceção (ex.: regra 8)
function fail(error) {
  toast(translateError(error?.message), true);
  return false;
}

function openDialog(title, bodyHtml, { mandatory = false } = {}) {
  dlg.innerHTML = `
    <div class="m-head">
      <h2>${esc(title)}</h2>
      ${mandatory ? '' : `<button type="button" class="icon" data-close aria-label="${t('action.close')}">✕</button>`}
    </div>
    <div class="m-body">${bodyHtml}<p class="error m-error" hidden></p></div>`;
  dlg.oncancel = e => { if (mandatory) e.preventDefault(); };   // ESC não fecha pop-up obrigatório
  dlg.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => dlg.close()));
  dlg.showModal();
  return new Promise(resolve => dlg.addEventListener('close', resolve, { once: true }));
}

function pathHtml(node) {
  const anc = ancestors(node);
  return anc.length ? `<p class="path">${anc.map(a => esc(a.title)).join(' › ')}</p>` : '';
}

function statusText(s) { return t('status.' + s); }

const ICON = {
  play: '<svg viewBox="0 0 24 24"><path d="M7 4l13 8-13 8z"/></svg>',
  pause: '<svg viewBox="0 0 24 24"><path d="M9 5v14M15 5v14"/></svg>',
  plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  edit: '<svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>',
  share: '<svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6M16 11a3 3 0 1 0 0-6M18 20c0-2.4-1-4.4-2.6-5.3"/></svg>',
};

// ---------- permissões (o banco garante; aqui só decide o que mostrar) ----------
const isOwner = p => !!p && p.owner_id === state.userId;
const myRole = p => state.members.find(m => m.project_id === p?.id && m.user_id === state.userId)?.role;
const canEditProject = p => isOwner(p) || myRole(p) === 'editor';
const userEmail = id => state.users.find(u => u.id === id)?.email ?? '?';

function rootOf(node) { let r = node; while (r.parent) r = r.parent; return r; }
function canEditNode(node) {
  const root = rootOf(node);
  if (!root.project_id) return true;   // sem projeto: só o dono enxerga
  return canEditProject(state.projects.find(p => p.id === root.project_id));
}

// ---------- dados ----------
async function loadTasks() {
  const [{ data, error }, proj, mem] = await Promise.all([
    sb.from('tasks').select('*'),
    sb.from('projects').select('*'),
    sb.from('project_members').select('*'),
  ]);
  if (error || proj.error || mem.error) return fail(error || proj.error || mem.error);
  state.projects = proj.data;
  state.members = mem.data;
  const wasOpen = new Set(state.forest.roots.filter(r => r.status !== 'done').map(r => r.id));
  state.forest = buildForest(data);
  const finished = state.forest.roots.filter(r => r.status === 'done' && wasOpen.has(r.id));
  if (finished.length) announceFinished(finished);
  render();
  return true;
}

// Aplica regras de tempo no banco e mostra os pop-ups pendentes (regras 9, 10, 12)
async function runAutomations() {
  if (state.busy || dlg.open) return;
  state.busy = true;
  try {
    const { data, error } = await sb.rpc('refresh_automations');
    if (error) return fail(error);
    await loadTasks();
    for (const p of data.overdue) await overduePopup(p);
    for (const p of data.inactivity) await inactivityPopup(p.task_id);
    for (const p of data.reminders) await reminderPopup(p);
  } finally {
    state.busy = false;
  }
}

// Depois de qualquer alteração: recarrega e verifica se algo entrou em atraso
async function afterChange() {
  if (state.busy) return loadTasks();
  return runAutomations();
}

// ---------- renderização ----------
function renderFilters() {
  const f = state.filters[state.view];
  $('#f-priority').innerHTML = [['all', 'filter.all'], ['yes', 'filter.yes'], ['no', 'filter.no']]
    .map(([v, k]) => `<option value="${v}">${t(k)}</option>`).join('');
  $('#f-priority').value = f.priority;

  $('#f-period-label').textContent = t(state.view === 'history' ? 'filter.completed' : 'filter.due');
  $('#f-period').innerHTML = PERIODS[state.view]
    .map(([v, k]) => `<option value="${v}">${t(k)}</option>`).join('');
  $('#f-period').value = f.period;

  const emails = [...new Set([...state.forest.byId.values()].map(t => t.assignee_email).filter(Boolean))].sort();
  $('#f-assignee').innerHTML = `<option value="">${t('filter.everyone')}</option><option value="__none__">${t('filter.noAssignee')}</option>`
    + emails.map(e => `<option value="${esc(e)}">${esc(e)}</option>`).join('');
  $('#f-assignee').value = f.assignee;
  $('#assignees').innerHTML = emails.map(e => `<option value="${esc(e)}">`).join('');

  renderProjectFilter(f);
  $('#f-clear').hidden = !isFilterActive(f);
  $('#new-task').hidden = state.view !== 'main';
  $('#new-project').hidden = state.view !== 'main';
}

const projectName = key => key === NO_PROJECT
  ? t('proj.none')
  : state.projects.find(p => p.id === key)?.name ?? t('proj.none');

// Filtro de projeto: lista de checkboxes (dá para marcar mais de um)
function renderProjectFilter(f) {
  const box = $('#f-projects');
  const sorted = [...state.projects].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  const opts = [...sorted.map(p => [p.id, p.name, isOwner(p) ? '' : userEmail(p.owner_id)]), [NO_PROJECT, t('proj.none'), '']];
  box.querySelector('.multi-panel').innerHTML = opts.map(([id, name, owner]) => `
    <label class="chk"><input type="checkbox" value="${esc(id)}" ${f.projects.includes(id) ? 'checked' : ''}> ${esc(name)}${owner ? ` <span class="muted small">· ${esc(owner)}</span>` : ''}</label>`).join('')
    + (f.projects.length ? `<button type="button" class="ghost" data-clear-projects>${t('filter.allProjects')}</button>` : '');
  box.querySelector('summary').textContent = !f.projects.length ? t('filter.allProjects')
    : f.projects.length === 1 ? projectName(f.projects[0])
    : t('filter.nSelected', { n: f.projects.length });
}

function statusCell(n, readOnly = false) {
  if (readOnly) return `<span class="status-text">${statusText(n.status)}</span>`;
  const opts = ['not_started', 'in_progress', 'done']
    .map(s => `<option value="${s}" ${n.status === s ? 'selected' : ''}>${statusText(s)}</option>`);
  if (n.status === 'overdue') opts.unshift(`<option value="overdue" selected disabled>${statusText('overdue')}</option>`);
  return `<select class="status" data-action="status" aria-label="${t('col.status')}">${opts.join('')}</select>`;
}

function rowHtml({ node: n, showingAll }, leaving = false, readOnly = false) {
  const hasKids = n.children.length > 0;
  const toggle = hasKids
    ? `<button class="toggle" data-action="toggle" data-all="${showingAll}" aria-label="${t('action.toggle')}">${showingAll ? '▾' : '▸'}</button>`
    : '<span class="toggle-spacer"></span>';

  const sit = n.blocking_status && n.blocking_status !== 'in_progress'
    ? `<span class="badge ${n.blocking_status === 'stopped' ? 'stopped' : ''}" title="${esc(n.blocking_reason || '')}">${t('situation.' + n.blocking_status)}</span>`
    : '';

  const isStopped = n.blocking_status === 'stopped';
  const actions = readOnly ? '' : `
    ${isStopped ? `<button class="icon resume" data-action="resume" title="${t('action.resume')}">${ICON.play}${t('action.resume')}</button>` : ''}
    ${!n.paused && n.status !== 'done' ? `<button class="icon" data-action="pause" title="${t('action.pause')}" aria-label="${t('action.pause')}">${ICON.pause}</button>` : ''}
    <button class="icon" data-action="add" title="${t('action.addSub')}" aria-label="${t('action.addSub')}">${ICON.plus}</button>
    <button class="icon" data-action="edit" title="${t('action.edit')}" aria-label="${t('action.edit')}">${ICON.edit}</button>
    <button class="icon danger" data-action="delete" title="${t('action.delete')}" aria-label="${t('action.delete')}">${ICON.trash}</button>`;

  return `
    <tr class="st-${n.status} ${n.paused ? 'paused' : ''} ${leaving ? 'leaving' : ''}" data-id="${n.id}">
      <td>
        <div class="title-wrap" style="padding-left:${n.depth * 22}px">
          ${toggle}
          <span class="title-text"><strong>${esc(n.title)}</strong>${sit}</span>
        </div>
      </td>
      <td class="notes" title="${esc(n.notes)}">${esc(n.notes)}</td>
      <td>${n.priority ? `<span class="prio-yes">${t('yes')}</span>` : `<span class="muted">${t('no')}</span>`}</td>
      <td>${n.due_date ? fmtDate(n.due_date) : '<span class="muted">—</span>'}</td>
      <td>${n.reminder_days != null ? t('days.short', { n: n.reminder_days }) : '<span class="muted">—</span>'}</td>
      <td title="${esc(n.assignee_email)}">${esc(n.assignee_email) || '<span class="muted">—</span>'}</td>
      <td>${statusCell(n, readOnly)}</td>
      <td class="actions">${actions}</td>
    </tr>`;
}

function render() {
  renderFilters();
  const f = state.filters[state.view];
  const today = todayISO();
  let roots = rootsFor(state.view, state.forest);
  if (state.view === 'main' && state.leaving.size) {
    roots = state.forest.roots.filter(r => r.status !== 'done' || state.leaving.has(r.id));
  }
  roots = filterRootsByProject(roots, f.projects);
  const filterActive = isFilterActive(f);
  const rowFilterActive = isRowFilterActive(f);
  const visible = computeVisible(roots, f, state.view, today);
  const shownRoots = rowFilterActive ? roots.filter(r => visible.has(r.id)) : roots;
  // sem filtro de linha, a tela principal mostra todos os projetos cadastrados (mesmo vazios)
  const groups = groupByProject(shownRoots, state.projects, {
    selected: f.projects,
    includeEmpty: state.view === 'main' && !rowFilterActive,
  });

  const leavingIds = new Set();
  if (state.view === 'main') {
    state.leaving.forEach(id => {
      const r = state.forest.byId.get(id);
      if (r) [r, ...descendants(r)].forEach(n => leavingIds.add(n.id));
    });
  }
  let html = '';
  for (const g of groups) {
    const open = !state.collapsedProjects.has(g.key);
    html += projectRowHtml(g, open);
    if (!open) continue;
    const rows = flatten(g.roots, { filterActive: rowFilterActive, visible, collapsed: state.collapsed, expanded: state.expanded });
    html += rows.length
      ? rows.map(r => rowHtml(r, leavingIds.has(r.node.id), g.project ? !canEditProject(g.project) : false)).join('')
      : `<tr class="proj-empty"><td colspan="8">${t('proj.empty')}</td></tr>`;
  }
  $('#rows').innerHTML = html;
  const empty = $('#empty');
  empty.hidden = groups.length > 0;
  empty.textContent = t(filterActive ? 'empty.filtered' : state.view === 'history' ? 'empty.history' : 'empty.main');
}

function projectRowHtml(g, open) {
  const p = g.project;
  const name = p ? p.name : t('proj.none');
  const canAdd = state.view === 'main' && (!p || canEditProject(p));
  const owner = isOwner(p);
  const actions = `
    ${canAdd ? `<button class="icon" data-action="proj-add" title="${t('proj.addTask')}" aria-label="${t('proj.addTask')}">${ICON.plus}</button>` : ''}
    ${owner ? `<button class="icon" data-action="proj-edit" title="${t('proj.edit')}" aria-label="${t('proj.edit')}">${ICON.share}</button>
    <button class="icon danger" data-action="proj-delete" title="${t('proj.delete')}" aria-label="${t('proj.delete')}">${ICON.trash}</button>` : ''}`;
  const shared = p ? state.members.filter(m => m.project_id === p.id) : [];
  const badge = !p ? ''
    : owner ? (shared.length ? `<span class="badge share" title="${esc(shared.map(m => userEmail(m.user_id)).join(', '))}">${t('share.sharedWith', { n: shared.length })}</span>` : '')
    : `<span class="badge share">${esc(t('share.from', { email: userEmail(p.owner_id) }))} · ${t(myRole(p) === 'editor' ? 'share.roleEditor' : 'share.roleViewer')}</span>`;
  return `
    <tr class="proj-row" data-project="${esc(g.key)}">
      <td colspan="8">
        <div class="proj-head">
          <button class="toggle" data-action="proj-toggle" aria-expanded="${open}" aria-label="${t('action.toggle')}">${open ? '▾' : '▸'}</button>
          <span class="proj-name">${esc(name)}</span>
          <span class="proj-count">${g.roots.length}</span>
          ${badge}
          <span class="spacer"></span>
          <span class="actions">${actions}</span>
        </div>
      </td>
    </tr>`;
}

// ---------- projetos ----------
async function projectForm(project = null) {
  await loadUsers();   // pega usuários criados depois do login
  const others = state.users.filter(u => u.id !== state.userId);
  const current = id => state.members.find(m => m.project_id === project?.id && m.user_id === id)?.role ?? '';
  const roleSelect = u => `
    <select name="role" data-user="${esc(u.id)}" aria-label="${esc(u.email)}">
      <option value="">${t('share.none')}</option>
      <option value="viewer" ${current(u.id) === 'viewer' ? 'selected' : ''}>${t('share.roleViewer')}</option>
      <option value="editor" ${current(u.id) === 'editor' ? 'selected' : ''}>${t('share.roleEditor')}</option>
    </select>`;
  const shareHtml = others.length ? `
      <table class="mini share-table">
        <thead><tr><th>${t('share.user')}</th><th style="width:210px">${t('share.access')}</th></tr></thead>
        <tbody>${others.map(u => `<tr><td>${esc(u.email)}</td><td>${roleSelect(u)}</td></tr>`).join('')}</tbody>
      </table>` : `<p class="muted">${t('share.noUsers')}</p>`;

  const done = openDialog(t(project ? 'proj.editTitle' : 'proj.newTitle'), `
    <form id="proj-form" style="display:grid;gap:14px">
      <label>${t('proj.name')}<input name="name" required maxlength="120" value="${esc(project?.name)}"></label>
      <fieldset>
        <legend>${t('share.title')}</legend>
        <p class="muted small">${t('share.hint')}</p>
        ${shareHtml}
      </fieldset>
      <div class="m-actions">
        <button type="button" data-close>${t('btn.cancel')}</button>
        <button class="primary">${t('btn.save')}</button>
      </div>
    </form>`);
  const form = dlg.querySelector('#proj-form');
  form.name.focus();
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const name = form.name.value.trim();
    let projectId = project?.id;
    if (project) {
      const { error } = await sb.from('projects').update({ name }).eq('id', projectId);
      if (error) return fail(error);
    } else {
      const { data, error } = await sb.from('projects').insert({ name }).select('id').single();
      if (error) return fail(error);
      projectId = data.id;
      project = { id: projectId, name };   // se o compartilhamento falhar, tentar de novo não duplica
    }

    // compartilhamento: grava o que foi escolhido e remove o que foi desmarcado
    const wanted = [...form.querySelectorAll('select[name=role]')]
      .map(sel => ({ user_id: sel.dataset.user, role: sel.value }));
    const keep = wanted.filter(w => w.role).map(w => ({ project_id: projectId, ...w }));
    const drop = wanted.filter(w => !w.role).map(w => w.user_id);
    if (keep.length) {
      const { error } = await sb.from('project_members').upsert(keep);
      if (error) return fail(error);
    }
    if (drop.length) {
      const { error } = await sb.from('project_members').delete().eq('project_id', projectId).in('user_id', drop);
      if (error) return fail(error);
    }
    dlg.close();
  });
  await done;
  await loadTasks();
}

async function deleteProject(project) {
  const n = state.forest.roots.filter(r => r.project_id === project.id).length;
  const msg = n ? t('proj.confirmDelete', { name: project.name, n }) : t('proj.confirmDeleteEmpty', { name: project.name });
  if (!confirm(msg)) return;
  const { error } = await sb.rpc('delete_project', { p_id: project.id });
  if (error) return fail(error);
  const f = state.filters;
  f.main.projects = f.main.projects.filter(id => id !== project.id);
  f.history.projects = f.history.projects.filter(id => id !== project.id);
  await loadTasks();
}

// projeto sugerido para uma tarefa nova: o do filtro, se só um estiver marcado
function defaultProjectId() {
  const sel = state.filters.main.projects;
  const p = sel.length === 1 && state.projects.find(x => x.id === sel[0]);
  return p && canEditProject(p) ? p.id : null;
}

async function loadUsers() {
  const { data, error } = await sb.rpc('list_users');
  if (error) return fail(error);
  state.users = data;
}

// ---------- formulário de tarefa ----------
async function taskForm({ task = null, parentId = null, projectId = null }) {
  const parent = parentId && state.forest.byId.get(parentId);
  const title = t(task ? 'form.editTitle' : parent ? 'form.newSubTitle' : 'form.newTitle');
  const v = task || {};   // valores atuais (vazio = nova tarefa)
  const isRoot = task ? !task.parent_id : !parent;   // só a raiz escolhe projeto
  const currentProject = task ? task.project_id : projectId;
  const projectField = isRoot ? `
      <label>${t('form.project')}
        <select name="project_id">
          <option value="">${t('proj.none')}</option>
          ${state.projects.filter(canEditProject).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
            .map(p => `<option value="${esc(p.id)}" ${p.id === currentProject ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
        </select>
      </label>` : '';

  const done = openDialog(title, `
    ${parent ? `<p class="path">${esc(t('form.inside', { path: [...ancestors(parent), parent].map(a => a.title).join(' › ') }))}</p>` : ''}
    <form id="task-form" class="grid-form" style="display:grid;gap:12px">
      <label>${t('form.task')}<input name="title" required maxlength="300" value="${esc(v.title)}"></label>
      ${projectField}
      <label>${t('form.notes')}<textarea name="notes">${esc(v.notes)}</textarea></label>
      <div class="grid2">
        <label>${t('form.due')}<input type="date" name="due_date" value="${esc(v.due_date)}"></label>
        <label>${t('form.reminder')}<input type="number" name="reminder_days" min="0" value="${esc(v.reminder_days)}"></label>
        <label>${t('form.assignee')}<input type="email" name="assignee_email" list="assignees" value="${esc(v.assignee_email)}"></label>
        <label class="chk"><input type="checkbox" name="priority" ${v.priority ? 'checked' : ''}> ${t('form.priority')}</label>
      </div>
      <div class="m-actions">
        <button type="button" data-close>${t('btn.cancel')}</button>
        <button class="primary">${t('btn.save')}</button>
      </div>
    </form>`);

  dlg.querySelector('#task-form').addEventListener('submit', async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const payload = {
      title: fd.get('title').trim(),
      notes: fd.get('notes').trim() || null,
      due_date: fd.get('due_date') || null,
      reminder_days: fd.get('reminder_days') === '' ? null : Number(fd.get('reminder_days')),
      assignee_email: fd.get('assignee_email').trim() || null,
      priority: fd.get('priority') === 'on',
    };
    if (isRoot) payload.project_id = fd.get('project_id') || null;
    const { error } = task
      ? await sb.from('tasks').update(payload).eq('id', task.id)
      : await sb.from('tasks').insert({ ...payload, parent_id: parentId });
    if (error) return fail(error);
    if (parentId) { state.collapsed.delete(parentId); state.expanded.add(parentId); }
    dlg.close();
  });

  await done;
}

// ---------- ações da linha ----------
async function changeStatus(node, status) {
  const { error } = await sb.from('tasks').update({ status }).eq('id', node.id);
  if (error) { fail(error); render(); return; }   // render desfaz o select
  await afterChange();
}

async function deleteTask(node) {
  const n = descendants(node).length;
  const msg = n
    ? t('delete.withChildren', { title: node.title, n })
    : t('delete.single', { title: node.title });
  if (!confirm(msg)) return;
  const { error } = await sb.from('tasks').delete().eq('id', node.id);
  if (error) return fail(error);
  await afterChange();
}

async function pauseTask(node) {
  const done = openDialog(t('pause.title'), `
    <p>${t('pause.text', { title: esc(node.title) })}</p>
    <form id="pause-form" style="display:grid;gap:12px">
      <label>${t('pause.reason')}<textarea name="reason"></textarea></label>
      <div class="m-actions"><button type="button" data-close>${t('btn.cancel')}</button><button class="primary">${t('pause.submit')}</button></div>
    </form>`);
  dlg.querySelector('#pause-form').addEventListener('submit', async e => {
    e.preventDefault();
    const reason = new FormData(e.target).get('reason');
    const { error } = await sb.rpc('set_situation', { p_task: node.id, p_situation: 'stopped', p_reason: reason });
    if (error) return fail(error);
    dlg.close();
  });
  await done;
  await afterChange();
}

// ---------- regra 11: retomada ----------
async function resumeTask(node) {
  const today = todayISO();
  const list = [node, ...descendants(node)];
  const statusOpts = s => ['not_started', 'in_progress', 'done']
    .map(v => `<option value="${v}" ${s === v ? 'selected' : ''}>${statusText(v)}</option>`).join('')
    + (s === 'overdue' ? `<option value="overdue" selected disabled>${statusText('overdue')}</option>` : '');

  const rows = list.map(x => {
    const expired = x.due_date && x.due_date < today && x.status !== 'done';
    return `
      <tr data-id="${x.id}">
        <td style="padding-left:${(x.depth - node.depth) * 16 + 6}px">
          ${esc(x.title)}
          ${expired ? `<span class="flag">${t('resume.expired')}</span>` : ''}
          ${x.status === 'in_progress' ? `<span class="flag info">${t('resume.wasInProgress')}</span>` : ''}
        </td>
        <td><input type="date" name="due" value="${esc(x.due_date)}" data-orig="${esc(x.due_date)}"></td>
        <td><select name="status" data-orig="${x.status}">${statusOpts(x.status)}</select></td>
      </tr>`;
  }).join('');

  const done = openDialog(t('resume.title'), `
    <p><strong>${esc(node.title)}</strong></p>
    <p class="muted">${t('resume.current', { due: node.due_date ? fmtDate(node.due_date) : t('noDue'), status: statusText(node.status) })}${node.blocking_reason ? esc(t('resume.reason', { reason: node.blocking_reason })) : ''}</p>
    <p class="muted">${t('resume.hint')}</p>
    <form id="resume-form" style="display:grid;gap:12px">
      <table class="mini">
        <thead><tr><th>${t('col.task')}</th><th style="width:150px">${t('col.due')}</th><th style="width:150px">${t('col.status')}</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="m-actions"><button type="button" data-close>${t('btn.cancel')}</button><button class="primary">${t('resume.submit')}</button></div>
    </form>`);

  dlg.querySelector('#resume-form').addEventListener('submit', async e => {
    e.preventDefault();
    const changes = [];
    dlg.querySelectorAll('#resume-form tbody tr').forEach(tr => {
      const item = { id: tr.dataset.id };
      const due = tr.querySelector('[name=due]');
      const st = tr.querySelector('[name=status]');
      if (due.value !== due.dataset.orig) item.due_date = due.value || null;
      if (st.value !== st.dataset.orig) item.status = st.value;
      if (Object.keys(item).length > 1) {
        item._depth = state.forest.byId.get(item.id).depth;
        changes.push(item);
      }
    });
    // mais profundas primeiro (a mãe só conclui depois das filhas)
    changes.sort((a, b) => b._depth - a._depth).forEach(c => delete c._depth);

    const { error } = await sb.rpc('resume_task', { p_task: node.id, p_changes: changes });
    if (error) return fail(error);
    dlg.close();
  });
  await done;
  await afterChange();
}

// ---------- regra 9: pop-up de atraso ----------
async function overduePopup(p) {
  const node = state.forest.byId.get(p.task_id);
  if (!node) return;
  const today = todayISO();

  const done = openDialog(t('overdue.title'), `
    ${pathHtml(node)}
    <p>${t('overdue.text', { title: esc(node.title), date: fmtDate(p.expired_due_date) })}</p>
    <p class="muted">${t('overdue.choose')}</p>
    <div class="choice">
      <button type="button" data-mode="extend">${t('overdue.extend')}</button>
      <button type="button" data-mode="plan">${t('overdue.plan')}</button>
    </div>
    <form class="pane" data-pane="extend" hidden>
      <label>${t('overdue.newDue')}<input type="date" name="due" required min="${today}"></label>
      <div class="m-actions"><button class="primary">${t('overdue.extendSubmit')}</button></div>
    </form>
    <form class="pane" data-pane="plan" hidden>
      <label>${t('overdue.planTask')}<input name="plan_title" required maxlength="300"></label>
      <div class="grid2">
        <label>${t('form.due')}<input type="date" name="due" required min="${today}"></label>
        <label>${t('form.assignee')}<input type="email" name="assignee" list="assignees" value="${esc(node.assignee_email)}"></label>
        <label>${t('form.reminder')}<input type="number" name="reminder_days" min="0"></label>
      </div>
      <p class="muted">${t('overdue.planHint')}</p>
      <div class="m-actions"><button class="primary">${t('overdue.planSubmit')}</button></div>
    </form>`, { mandatory: true });

  dlg.querySelectorAll('[data-mode]').forEach(btn => btn.addEventListener('click', () => {
    dlg.querySelectorAll('[data-mode]').forEach(b => b.classList.toggle('selected', b === btn));
    dlg.querySelectorAll('[data-pane]').forEach(p => { p.hidden = p.dataset.pane !== btn.dataset.mode; });
  }));

  dlg.querySelector('[data-pane=extend]').addEventListener('submit', async e => {
    e.preventDefault();
    const { error } = await sb.rpc('extend_due_date', { p_task: node.id, p_new_due: e.target.due.value });
    if (error) return fail(error);
    dlg.close();
  });

  dlg.querySelector('[data-pane=plan]').addEventListener('submit', async e => {
    e.preventDefault();
    const f = e.target;
    const { data: planId, error } = await sb.rpc('create_action_plan', {
      p_parent: node.id, p_title: f.plan_title.value.trim(), p_due: f.due.value,
      p_assignee: f.assignee.value.trim() || null,
    });
    if (error) return fail(error);
    if (f.reminder_days.value !== '') {
      const { error: e2 } = await sb.from('tasks')
        .update({ reminder_days: Number(f.reminder_days.value) }).eq('id', planId);
      if (e2) return fail(e2);
    }
    state.collapsed.delete(node.id);
    dlg.close();
  });

  await done;
  await loadTasks();
}

// ---------- regra 10: pop-up de inatividade ----------
async function inactivityPopup(taskId) {
  const node = state.forest.byId.get(taskId);
  if (!node) return;
  const today = todayISO();
  const desc = descendants(node);

  const descHtml = desc.length ? `
    <table class="mini">
      <thead><tr><th>${t('inact.subtask')}</th><th>${t('col.due')}</th><th>${t('col.status')}</th></tr></thead>
      <tbody>${desc.map(d => `
        <tr><td style="padding-left:${(d.depth - node.depth - 1) * 16 + 6}px">${esc(d.title)}</td>
            <td>${d.due_date ? fmtDate(d.due_date) : '—'}</td><td>${statusText(d.status)}</td></tr>`).join('')}
      </tbody>
    </table>` : `<p class="muted">${t('inact.noSubtasks')}</p>`;

  const radio = v => `<label class="radio"><input type="radio" name="sit" value="${v}" required> ${t('situation.' + v)}</label>`;

  const done = openDialog(t('inact.title'), `
    ${pathHtml(node)}
    <p>${t('inact.header', { title: esc(node.title), due: node.due_date ? fmtDate(node.due_date) : t('noDue') })}</p>
    ${descHtml}
    <form id="inact-form" style="display:grid;gap:12px">
      <fieldset>
        <legend>${t('inact.question')}</legend>
        ${radio('in_progress')}
        ${radio('waiting_others')}
        ${radio('stopped')}
        ${radio('other')}
        <label id="reason-label">${t('inact.reason')}<textarea name="reason"></textarea></label>
      </fieldset>
      <fieldset>
        <legend>${t('inact.optional')}</legend>
        <label>${t('inact.changeDue')}<input type="date" name="due" value="${esc(node.due_date)}"></label>
        <label>${t('inact.createPlan')}<input name="plan_title" maxlength="300" placeholder="${t('inact.planPlaceholder')}"></label>
        <label>${t('inact.planDue')}<input type="date" name="plan_due" min="${today}"></label>
      </fieldset>
      <div class="m-actions"><button class="primary">${t('btn.confirm')}</button></div>
    </form>`, { mandatory: true });

  const form = dlg.querySelector('#inact-form');
  form.addEventListener('change', () => {
    const sit = form.sit.value;
    form.reason.required = sit === 'other';
    dlg.querySelector('#reason-label').firstChild.textContent =
      t(sit === 'other' ? 'inact.reasonOther' : sit === 'waiting_others' ? 'inact.reasonWaiting' : 'inact.reason');
    form.plan_due.required = form.plan_title.value.trim() !== '';
  });
  form.plan_title.addEventListener('input', () => { form.plan_due.required = form.plan_title.value.trim() !== ''; });

  form.addEventListener('submit', async e => {
    e.preventDefault();
    if (form.due.value !== (node.due_date || '')) {
      const { error } = await sb.from('tasks').update({ due_date: form.due.value || null }).eq('id', node.id);
      if (error) return fail(error);
      node.due_date = form.due.value || null;   // evita repetir se outra etapa falhar
    }
    if (form.plan_title.value.trim()) {
      const { error } = await sb.rpc('create_action_plan', {
        p_parent: node.id, p_title: form.plan_title.value.trim(), p_due: form.plan_due.value,
      });
      if (error) return fail(error);
      form.plan_title.value = '';
    }
    const { error } = await sb.rpc('set_situation', {
      p_task: node.id, p_situation: form.sit.value, p_reason: form.reason.value, p_from_prompt: true,
    });
    if (error) return fail(error);
    dlg.close();
  });

  await done;
  await loadTasks();
}

// ---------- regra 12: lembrete ----------
async function reminderPopup(p) {
  const node = state.forest.byId.get(p.task_id);
  if (!node) return;
  const when = p.days_left === 0 ? t('rem.today')
    : p.days_left === 1 ? t('rem.tomorrow')
    : t('rem.inDays', { n: p.days_left });

  const done = openDialog(t('rem.title'), `
    ${pathHtml(node)}
    <p><strong>${esc(node.title)}</strong> ${when} (${fmtDate(p.due_date)}).</p>
    ${node.assignee_email ? `<p class="muted">${esc(t('rem.assignee', { email: node.assignee_email }))}</p>` : ''}
    <div class="m-actions"><button class="primary" data-close>${t('btn.ok')}</button></div>`);
  await done;   // fechar de qualquer jeito conta como "exibido"
  const { error } = await sb.rpc('ack_reminder', { p_task: node.id });
  if (error) fail(error);
}

// ---------- eventos ----------
function bindUi() {
  document.querySelectorAll('.tab').forEach(tab => tab.addEventListener('click', () => switchView(tab.dataset.view)));

  const setFilter = (key, value) => { state.filters[state.view][key] = value; state.expanded.clear(); render(); };
  $('#f-priority').addEventListener('change', e => setFilter('priority', e.target.value));
  $('#f-period').addEventListener('change', e => setFilter('period', e.target.value));
  $('#f-assignee').addEventListener('change', e => setFilter('assignee', e.target.value));
  $('#f-clear').addEventListener('click', () => {
    state.filters[state.view] = { ...DEFAULT_FILTERS };
    state.expanded.clear();
    render();
  });

  $('#new-task').addEventListener('click', async () => { await taskForm({ projectId: defaultProjectId() }); await afterChange(); });
  $('#new-project').addEventListener('click', () => projectForm());

  const projBox = $('#f-projects');
  projBox.addEventListener('change', e => {
    if (e.target.type !== 'checkbox') return;
    const checked = [...projBox.querySelectorAll('input:checked')].map(i => i.value);
    setFilter('projects', checked);
  });
  projBox.addEventListener('click', e => {
    if (e.target.closest('[data-clear-projects]')) setFilter('projects', []);
  });
  document.addEventListener('click', e => { if (!projBox.contains(e.target)) projBox.open = false; });

  $('#rows').addEventListener('click', async e => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const projRow = btn.closest('tr.proj-row');
    if (projRow) {
      const key = projRow.dataset.project;
      const project = state.projects.find(p => p.id === key);
      switch (btn.dataset.action) {
        case 'proj-toggle':
          if (state.collapsedProjects.has(key)) state.collapsedProjects.delete(key);
          else state.collapsedProjects.add(key);
          render();
          break;
        case 'proj-add': await taskForm({ projectId: project?.id ?? null }); await afterChange(); break;
        case 'proj-edit': if (project) await projectForm(project); break;
        case 'proj-delete': if (project) await deleteProject(project); break;
      }
      return;
    }
    const node = state.forest.byId.get(btn.closest('tr').dataset.id);
    switch (btn.dataset.action) {
      case 'toggle':
        toggleNode(node.id, btn.dataset.all === 'true', state.collapsed, state.expanded);
        render();
        break;
      case 'add': await taskForm({ parentId: node.id }); await afterChange(); break;
      case 'edit': await taskForm({ task: node }); await afterChange(); break;
      case 'delete': await deleteTask(node); break;
      case 'pause': await pauseTask(node); break;
      case 'resume': await resumeTask(node); break;
    }
  });

  $('#rows').addEventListener('change', e => {
    if (e.target.dataset.action !== 'status') return;
    const node = state.forest.byId.get(e.target.closest('tr').dataset.id);
    changeStatus(node, e.target.value);
  });

  $('#login-form').addEventListener('submit', async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const { error } = await sb.auth.signInWithPassword({ email: fd.get('email'), password: fd.get('password') });
    const err = $('#login-error');
    err.hidden = !error;
    if (error) err.textContent = t('login.error');
  });

  document.querySelectorAll('.lang-select').forEach(sel => sel.addEventListener('change', e => {
    setLang(e.target.value);
    applyLanguage();
  }));

  $('#logout').addEventListener('click', () => sb.auth.signOut());
}

// ---------- idioma ----------
function applyLanguage() {
  applyStatic();
  document.querySelectorAll('.lang-select').forEach(sel => {
    sel.innerHTML = Object.entries(LANGS).map(([code, name]) => `<option value="${code}">${name}</option>`).join('');
    sel.value = getLang();
  });
  const err = $('#login-error');
  if (!err.hidden) err.textContent = t('login.error');
  render();
}

// ---------- sessão ----------
let refreshTimer;
async function onSession(session) {
  $('#login').hidden = !!session;
  $('#app').hidden = !session;
  clearInterval(refreshTimer);
  // outro usuário: começa do zero (não mistura dados nem avisos)
  state.forest = { byId: new Map(), roots: [] };
  state.projects = []; state.members = []; state.users = [];
  state.filters = { main: { ...DEFAULT_FILTERS }, history: { ...DEFAULT_FILTERS } };
  state.userId = session?.user?.id ?? null;
  if (!session) return;
  $('#user-email').textContent = session.user.email;
  await loadUsers();
  await runAutomations();
  refreshTimer = setInterval(runAutomations, REFRESH_MINUTES * 60 * 1000);
}

bindUi();
applyLanguage();
let lastUserId = '(início)';
sb.auth.onAuthStateChange((_event, session) => {
  const id = session?.user?.id ?? null;
  if (id === lastUserId) return;      // ignora renovação de token
  lastUserId = id;
  setTimeout(() => onSession(session), 0);   // fora do callback, como recomenda o supabase-js
});

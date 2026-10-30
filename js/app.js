// Versão fixa (não use "@2"): uma versão nova ou comprometida do CDN rodaria direto no app.
// Para atualizar, troque o número aqui e teste.
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.2/+esm';
import { SUPABASE_URL, SUPABASE_KEY, REFRESH_MINUTES } from './config.js';
import {
  todayISO, buildForest, descendants, ancestors, rootOf, rootsFor,
  isFilterActive, isRowFilterActive, computeVisible, flatten, toggleNode,
  NO_PROJECT, filterRootsByProject, groupByProject, orderedKeys,
  QUICK, freshFilters, dayDiff, summaryCounts, sortComparator, nextSort, sanitizeFilters, sanitizeSort,
  moveError, movePatch, hasOpenChildren,
} from './tree.js';
import { toCSV } from './csv.js';
import { t, getLang, setLang, LANGS, fmtDate, fmtRelative, applyStatic, translateError } from './i18n.js';

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);
const $ = sel => document.querySelector(sel);
const dlg = $('#modal');
const drawer = $('#drawer');

// ---------- estado ----------
const emptyPending = () => ({ overdue: [], inactivity: [], reminders: [] });
const state = {
  view: 'main',
  filters: { main: freshFilters(), history: freshFilters() },
  sort: { main: null, history: null },   // ordenação escolhida no cabeçalho (null = padrão)
  forest: { byId: new Map(), roots: [] },
  projects: [],
  projectOrder: [],     // ids na ordem escolhida pelo usuário (arrastar e soltar)
  members: [],          // compartilhamentos visíveis (project_members)
  users: [],            // usuários cadastrados (id, email)
  userId: null,
  me: '',               // e-mail do usuário logado (atalho "Minhas tarefas")
  collapsedProjects: new Set(),
  collapsed: new Set(),
  expanded: new Set(),
  leaving: new Set(),   // raízes recém-concluídas, ainda visíveis na tela principal
  openRoots: new Set(), // raízes abertas na última carga do banco (para anunciar as que concluíram)
  pending: emptyPending(),   // pendências devolvidas por refresh_automations
  notified: new Set(),  // pendências já avisadas no toast
  busy: false,          // verificação de automações em andamento
  editing: false,       // edição direta ou arraste em andamento: pausa a atualização automática
  dirty: false,         // chegou dado novo durante a edição: redesenha quando ela terminar
  loading: false,       // primeira carga da sessão ainda não chegou
  loadError: false,
  printing: false,      // impressão: mostra tudo expandido
  loadedAt: 0,          // quando a lista foi carregada pela última vez (ms)
  usersAt: 0,           // idem para a lista de usuários
};

const PERIODS = {
  main: [['all', 'period.all'], ['7', 'period.next7'], ['15', 'period.next15'], ['30', 'period.next30'], ['none', 'period.none']],
  history: [['all', 'period.all'], ['7', 'period.last7'], ['15', 'period.last15'], ['30', 'period.last30']],
};

// ---------- utilidades ----------
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// O aviso é um popover (camada superior): aparece também por cima de pop-ups abertos.
function hideToast() {
  const el = $('#toast');
  try { el.hidePopover(); } catch { /* já estava fechado ou navegador sem popover */ }
  el.hidden = true;
}

let toastTimer;
function toast(msg, isError = false, action = null) {
  if (isError && dlg.open) {
    const box = dlg.querySelector('.m-error');
    if (box) {
      box.textContent = msg;
      box.hidden = false;
      return;
    }
  }
  const el = $('#toast');
  el.textContent = msg;
  if (action) {
    const b = document.createElement('button');
    b.className = 'toast-btn';
    b.textContent = action.label;
    b.addEventListener('click', () => { hideToast(); action.onClick(); });
    el.append(b);
  }
  el.className = 'toast' + (isError ? ' err' : '');
  el.setAttribute('role', isError ? 'alert' : 'status');
  el.hidden = false;
  try { el.hidePopover(); el.showPopover(); } catch { /* sem popover: fica na camada normal */ }
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, action ? 8000 : 5000);
}

// Evita envio duplicado: desabilita os botões de envio enquanto a chamada ao banco não termina.
function guard(handler) {
  return async e => {
    e.preventDefault();
    const form = e.currentTarget;
    const buttons = [...form.querySelectorAll('button:not([type=button])')];
    if (buttons.some(b => b.disabled)) return;
    buttons.forEach(b => { b.disabled = true; });
    try { await handler(e); }
    finally { buttons.forEach(b => { b.disabled = false; }); }
  };
}

function switchView(view) {
  closeMenu(false);
  state.view = view;
  document.querySelectorAll('.tab').forEach(tab => {
    tab.classList.toggle('active', tab.dataset.view === view);
    tab.setAttribute('aria-pressed', String(tab.dataset.view === view));
  });
  render();
}

// ---------- foco ----------
// O render troca o HTML da tabela; para não jogar o foco do teclado no <body>, guarda
// "qual controle" estava focado (linha + ação/campo) e devolve o foco ao equivalente novo.
function focusKey(el) {
  if (!el || el === document.body || !$('#app').contains(el)) return null;
  if (el.id) return '#' + CSS.escape(el.id);
  const attr = ['action', 'field', 'sort', 'chip', 'quick'].find(a => el.dataset?.[a] != null);
  if (!attr) return null;
  const sel = `[data-${attr}="${CSS.escape(el.dataset[attr])}"]`;
  const tr = el.closest('tr[data-id], tr[data-project]');
  if (!tr) return el.closest('#head') ? `#head ${sel}` : sel;
  return tr.dataset.id
    ? `tr[data-id="${CSS.escape(tr.dataset.id)}"] ${sel}`
    : `tr[data-project="${CSS.escape(tr.dataset.project)}"] ${sel}`;
}

function refocus(key) {
  if (!key || dlg.open || drawer.open) return;
  const a = document.activeElement;
  if (a && a !== document.body && a.isConnected) return;   // o usuário já está em outro lugar
  document.querySelector(key)?.focus({ preventScroll: true });
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
    renderSoon();
  }, LEAVE_MS);
}

// Erros do banco chegam como texto da exceção (ex.: regra 8)
function fail(error) {
  toast(translateError(error?.message), true);
  return false;
}

// Foco inicial do pop-up: o primeiro campo do formulário; sem campo, o botão principal.
// (O ✕ do topo é o primeiro focável do HTML: sem isto, Enter fecharia a janela.)
function focusFirstField(root) {
  const usable = el => !el.disabled && !el.closest('[hidden]');
  const pick = sel => [...root.querySelectorAll(sel)].find(usable);
  const el = pick('input:not([type=hidden]), select, textarea') || pick('button.primary') || pick('.m-body button');
  el?.focus();
}

function openDialog(title, bodyHtml) {
  const back = focusKey(document.activeElement);   // ao fechar, volta para quem abriu
  dlg.innerHTML = `
    <div class="m-head">
      <h2 id="modal-title">${esc(title)}</h2>
      <button type="button" class="icon" data-close aria-label="${t('action.close')}">✕</button>
    </div>
    <div class="m-body">${bodyHtml}<p class="error m-error" role="alert" hidden></p></div>`;
  dlg.setAttribute('aria-labelledby', 'modal-title');
  dlg.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => dlg.close()));
  dlg.showModal();
  focusFirstField(dlg.querySelector('.m-body'));
  return new Promise(resolve => dlg.addEventListener('close', () => {
    resolve();
    setTimeout(() => refocus(back), 0);
  }, { once: true }));
}

// Confirmação no lugar do confirm() nativo. message é texto puro (escapado aqui).
// Em ações destrutivas o foco começa em "Cancelar": Enter por engano não apaga nada.
function confirmDialog({ title, message, confirmLabel = t('btn.confirm'), danger = false }) {
  let ok = false;
  const done = openDialog(title, `
    <p class="pre">${esc(message)}</p>
    <div class="m-actions">
      <button type="button" data-close>${t('btn.cancel')}</button>
      <button type="button" class="${danger ? 'danger-btn' : 'primary'}" data-ok>${esc(confirmLabel)}</button>
    </div>`);
  dlg.querySelector('[data-ok]').addEventListener('click', () => { ok = true; dlg.close(); });
  (danger ? dlg.querySelector('.m-actions [data-close]') : dlg.querySelector('[data-ok]')).focus();
  return done.then(() => ok);
}

function pathHtml(node) {
  const anc = ancestors(node);
  return anc.length ? `<p class="path">${anc.map(a => esc(a.title)).join(' › ')}</p>` : '';
}

function statusText(s) { return t('status.' + s); }

const ICON = {
  play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4l13 8-13 8z"/></svg>',
  stop: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="1.5"/></svg>',
  plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
  edit: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg>',
  trash: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>',
  share: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="8" r="3"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6M16 11a3 3 0 1 0 0-6M18 20c0-2.4-1-4.4-2.6-5.3"/></svg>',
  more: '<svg viewBox="0 0 24 24" aria-hidden="true" class="dots"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg>',
  move: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v18M3 12h18M9 6l3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3M18 9l3 3-3 3"/></svg>',
};

// ---------- permissões (o banco garante; aqui só decide o que mostrar) ----------
const isOwner = p => !!p && p.owner_id === state.userId;
const myRole = p => state.members.find(m => m.project_id === p?.id && m.user_id === state.userId)?.role;
const canEditProject = p => isOwner(p) || myRole(p) === 'editor';
const userEmail = id => state.users.find(u => u.id === id)?.email ?? '?';
const projectById = key => state.projects.find(p => p.id === key);

function canEditNode(node) {
  const root = rootOf(node);
  if (!root.project_id) return true;   // sem projeto: só o dono enxerga
  return canEditProject(projectById(root.project_id));
}

// Regras de "mover" na linguagem de tree.js (moveError)
const moveCtx = () => ({
  canEditNode,
  canEditProject: key => key === NO_PROJECT || canEditProject(projectById(key)),
  ownsProject: key => key === NO_PROJECT || isOwner(projectById(key)),
});

// ---------- dados ----------
let loadSeq = 0;
async function loadTasks() {
  const seq = ++loadSeq;
  const uid = state.userId;
  const [{ data, error }, proj, mem, ord] = await Promise.all([
    sb.from('tasks').select('*'),
    sb.from('projects').select('*'),
    sb.from('project_members').select('*'),
    sb.from('project_order').select('project_id, position').order('position'),
  ]);
  if (seq !== loadSeq || uid !== state.userId) return true;   // resposta velha (ou de outra sessão): descarta
  const err = error || proj.error || mem.error || ord.error;
  if (err) {
    if (state.loading) { state.loading = false; state.loadError = true; render(); }
    return fail(err);
  }
  state.loading = false;
  state.loadError = false;
  state.loadedAt = Date.now();
  state.projects = proj.data;
  state.projectOrder = ord.data.map(o => o.project_id ?? NO_PROJECT);   // nulo = "Sem projeto"
  state.members = mem.data;
  prunePrefs();
  // compara com a última carga do banco (não com a tela, que pode ter mudanças otimistas)
  const wasOpen = state.openRoots;
  state.forest = buildForest(data);
  state.openRoots = new Set(state.forest.roots.filter(r => r.status !== 'done').map(r => r.id));
  const finished = state.forest.roots.filter(r => r.status === 'done' && wasOpen.has(r.id));
  if (finished.length) announceFinished(finished);
  renderSoon();
  if (drawer.open) renderDrawer();
  return true;
}

// Mudança otimista: aplica na tela já, antes da resposta do banco. Devolve os valores
// antigos (para desfazer se o banco recusar). Remonta a árvore para manter a ordem.
function patchTask(id, patch) {
  const node = state.forest.byId.get(id);
  if (!node) return null;
  const prev = Object.fromEntries(Object.keys(patch).map(k => [k, node[k]]));
  const raw = [...state.forest.byId.values()]
    .map(({ children, parent, depth, paused, ...rest }) => rest.id === id ? { ...rest, ...patch } : rest);
  state.forest = buildForest(raw);
  return prev;
}

// Aplica regras de tempo no banco e atualiza as pendências (regras 9, 10, 12).
// Não abre mais pop-ups em sequência: só atualiza o sino e, se houver novidade, avisa uma vez.
async function runAutomations({ notify = true } = {}) {
  if (state.busy || dlg.open || state.editing) return;   // não atrapalha quem está digitando
  state.busy = true;
  const uid = state.userId;
  try {
    const { data, error } = await sb.rpc('refresh_automations');
    if (uid !== state.userId) return;
    if (error) { fail(error); await loadTasks(); return; }   // sem automações, a lista ainda aparece
    await loadTasks();
    if (uid !== state.userId) return;
    setPending(data);
    if (notify) notifyPending();
  } finally {
    state.busy = false;
  }
}

// Depois de qualquer alteração: só recarrega a lista. As pendências ficam para
// a verificação periódica (REFRESH_MINUTES), para não interromper quem está trabalhando.
async function afterChange() {
  return loadTasks();
}

// Quem divide projetos só vê a mudança do outro ao recarregar. Ao voltar para a aba,
// atualiza a lista (sem pop-ups) se já faz mais de um minuto.
const STALE_MS = 60 * 1000;
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !state.userId) return;
  if (state.busy || state.editing || dlg.open || Date.now() - state.loadedAt < STALE_MS) return;
  loadTasks();
});

// "Lembrar amanhã" no pop-up de atraso. Fica salvo só neste navegador, por usuário:
// { [event_id]: 'AAAA-MM-DD' } = não avisar esse atraso de novo nesse dia.
const snoozeKey = () => `cajuca.snooze.${state.userId}`;

function snoozedToday() {
  if (!state.userId) return new Set();
  const today = todayISO();
  try {
    const all = JSON.parse(localStorage.getItem(snoozeKey()) || '{}');
    const kept = Object.fromEntries(Object.entries(all).filter(([, day]) => day === today));
    if (Object.keys(kept).length !== Object.keys(all).length) {
      localStorage.setItem(snoozeKey(), JSON.stringify(kept));   // descarta adiamentos de dias anteriores
    }
    return new Set(Object.keys(kept));
  } catch { return new Set(); }
}

function snoozeOverdue(eventId) {
  try {
    const all = JSON.parse(localStorage.getItem(snoozeKey()) || '{}');
    all[eventId] = todayISO();
    localStorage.setItem(snoozeKey(), JSON.stringify(all));
  } catch { /* navegador sem armazenamento: o aviso volta na próxima verificação */ }
}

// ---------- preferências por usuário (neste navegador) ----------
// Filtros de cada visão, ordenação e projetos recolhidos. Tudo é validado na leitura.
const prefsKey = () => `cajuca.prefs.${state.userId}`;

function loadPrefs() {
  let raw = null;
  try { raw = JSON.parse(localStorage.getItem(prefsKey()) || 'null'); } catch { raw = null; }
  state.filters = { main: sanitizeFilters(raw?.filters?.main, 'main'), history: sanitizeFilters(raw?.filters?.history, 'history') };
  state.sort = { main: sanitizeSort(raw?.sort?.main), history: sanitizeSort(raw?.sort?.history) };
  const cp = Array.isArray(raw?.collapsedProjects) ? raw.collapsedProjects : [];
  state.collapsedProjects = new Set(cp.filter(k => typeof k === 'string' && k.length <= 100).slice(0, 500));
}

function savePrefs() {
  if (!state.userId) return;
  try {
    localStorage.setItem(prefsKey(), JSON.stringify({
      filters: state.filters, sort: state.sort, collapsedProjects: [...state.collapsedProjects],
    }));
  } catch { /* sem armazenamento: vale só nesta visita */ }
}

// Depois de carregar: solta projetos que não existem mais (excluídos ou descompartilhados)
function prunePrefs() {
  const valid = new Set([...state.projects.map(p => p.id), NO_PROJECT]);
  let changed = false;
  for (const f of Object.values(state.filters)) {
    const kept = f.projects.filter(k => valid.has(k));
    if (kept.length !== f.projects.length) { f.projects = kept; changed = true; }
  }
  for (const k of [...state.collapsedProjects]) {
    if (!valid.has(k)) { state.collapsedProjects.delete(k); changed = true; }
  }
  if (changed) savePrefs();
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

  // sem repetir "Ana" e "ana" (o banco as trata como a mesma pessoa)
  const emails = [...new Map([...state.forest.byId.values()].flatMap(t => t.assignees || []).map(e => [e.toLowerCase(), e])).values()]
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  // responsável que não existe mais em nenhuma tarefa: solta o filtro (senão a lista fica vazia sem explicação).
  // Durante a carga a lista ainda está vazia: não mexe no filtro salvo.
  if (!state.loading && f.assignee && f.assignee !== '__none__' && !emails.some(e => e.toLowerCase() === f.assignee.toLowerCase())) f.assignee = '';
  $('#f-assignee').innerHTML = `<option value="">${t('filter.everyone')}</option><option value="__none__">${t('filter.noAssignee')}</option>`
    + emails.map(e => `<option value="${esc(e)}">${esc(e)}</option>`).join('');
  $('#f-assignee').value = [...$('#f-assignee').options].find(o => o.value.toLowerCase() === f.assignee.toLowerCase())?.value ?? '';

  // busca: não reescreve enquanto a pessoa digita
  const q = $('#f-q');
  if (document.activeElement !== q && q.value !== f.q) q.value = f.q;

  renderProjectFilter(f);
  renderChips(f);
  const active = isFilterActive(f);
  $('#f-clear').hidden = !active;
  $('#f-toggle .dot').hidden = !active;
  $('#new-task').hidden = state.view !== 'main';
  $('#new-project').hidden = state.view !== 'main';
}

const projectName = key => key === NO_PROJECT
  ? t('proj.none')
  : projectById(key)?.name ?? t('proj.none');

// Filtro de projeto: lista de checkboxes (dá para marcar mais de um)
function renderProjectFilter(f) {
  const box = $('#f-projects');
  const byId = new Map(state.projects.map(p => [p.id, p]));
  const opts = orderedKeys(state.projects, state.projectOrder).map(k => k === NO_PROJECT
    ? [NO_PROJECT, t('proj.none'), '']
    : [k, byId.get(k).name, isOwner(byId.get(k)) ? '' : userEmail(byId.get(k).owner_id)]);
  box.querySelector('.multi-panel').innerHTML = opts.map(([id, name, owner]) => `
    <label class="chk"><input type="checkbox" value="${esc(id)}" ${f.projects.includes(id) ? 'checked' : ''}> ${esc(name)}${owner ? ` <span class="muted small">· ${esc(owner)}</span>` : ''}</label>`).join('')
    + (f.projects.length ? `<button type="button" class="ghost" data-clear-projects>${t('filter.allProjects')}</button>` : '');
  box.querySelector('summary').textContent = !f.projects.length ? t('filter.allProjects')
    : f.projects.length === 1 ? projectName(f.projects[0])
    : t('filter.nSelected', { n: f.projects.length });
}

// Chips e cartões do resumo são montados uma vez por idioma (buildShortcuts) e só
// atualizados aqui: o foco do teclado não se perde ao clicar.
function buildShortcuts() {
  $('#chips').innerHTML = [['mine', 'chip.mine'], ...QUICK.map(k => [k, 'quick.' + k])]
    .map(([k, key]) => `<button type="button" class="chip" data-chip="${k}" aria-pressed="false">${t(key)}</button>`).join('');
  $('#summary').innerHTML = QUICK.map(k => `
    <button type="button" class="sum-card sum-${k}" data-quick="${k}" aria-pressed="false" title="${t('sum.hint')}">
      <span class="sum-n">0</span><span class="sum-l">${t('sum.' + k)}</span>
    </button>`).join('');
}

function renderChips(f) {
  $('#chips').querySelectorAll('[data-chip]').forEach(b => {
    const k = b.dataset.chip;
    b.hidden = k !== 'mine' && state.view !== 'main';   // atalhos de prazo não fazem sentido no histórico
    b.setAttribute('aria-pressed', String(k === 'mine' ? !!f.mine : f.quick === k));
  });
}

// Resumo: conta as tarefas abertas da tela principal, respeitando só o filtro de projeto
function renderSummary(today) {
  const box = $('#summary');
  box.hidden = state.view !== 'main' || state.loading;
  if (box.hidden) return;
  const f = state.filters.main;
  const counts = summaryCounts(filterRootsByProject(rootsFor('main', state.forest), f.projects), today);
  box.querySelectorAll('[data-quick]').forEach(b => {
    b.querySelector('.sum-n').textContent = counts[b.dataset.quick];
    b.setAttribute('aria-pressed', String(f.quick === b.dataset.quick));
  });
}

// Cabeçalho: colunas ordenáveis viram botões (aria-sort na coluna ordenada)
const COLS = [
  ['title', 'col.task', true], ['notes', 'col.notes'], ['priority', 'col.priority', true],
  ['due_date', 'col.due', true], ['reminder_days', 'col.reminder'], ['assignees', 'col.assignee'],
  ['status', 'col.status', true], ['actions', 'col.actions'],
];
function renderHead() {
  const s = state.sort[state.view];
  $('#head').innerHTML = `<tr>${COLS.map(([k, label, sortable]) => {
    if (k === 'actions') return `<th class="c-actions"><span class="sr-only">${t(label)}</span></th>`;
    if (!sortable) return `<th class="c-${k}">${t(label)}</th>`;
    const dir = s?.key === k ? s.dir : null;
    return `<th class="c-${k}"${dir ? ` aria-sort="${dir === 'asc' ? 'ascending' : 'descending'}"` : ''}>
      <button type="button" class="sort" data-sort="${k}" title="${t('sort.hint')}">${t(label)}<span class="sort-ind" aria-hidden="true">${dir === 'asc' ? '▲' : dir === 'desc' ? '▼' : '↕'}</span></button></th>`;
  }).join('')}</tr>`;
}

function statusCell(n, readOnly = false) {
  const print = `<span class="print-only">${statusText(n.status)}</span>`;
  if (readOnly) return `<span class="status-text">${statusText(n.status)}</span>`;
  // regra 8: com subtarefas abertas, "Concluído" fica indisponível (o banco confere de novo)
  const blocked = n.status !== 'done' && hasOpenChildren(n);
  const hint = blocked ? ` title="${t('status.doneBlocked')}"` : '';
  const opts = ['not_started', 'in_progress', 'done'].map(s => `<option value="${s}" ${n.status === s ? 'selected' : ''}${s === 'done' && blocked ? ` disabled${hint}` : ''}>${statusText(s)}</option>`);
  if (n.status === 'overdue') opts.unshift(`<option value="overdue" selected disabled>${statusText('overdue')}</option>`);
  return `<select class="status" data-action="status" aria-label="${t('col.status')}"${hint}>${opts.join('')}</select>${print}`;
}

function situationBadge(n) {
  if (!n.blocking_status || n.blocking_status === 'in_progress') return '';
  const stopped = n.blocking_status === 'stopped';
  return `<span class="badge ${stopped ? 'stopped' : ''}" title="${esc(n.blocking_reason || '')}">${stopped ? ICON.stop : ''}${t('situation.' + n.blocking_status)}</span>`;
}

const DASH = '<span class="muted">—</span>';

// Conteúdo de cada célula editável (usado pela linha e pela edição direta)
function cellDisplay(n, field, today = todayISO()) {
  switch (field) {
    case 'title': return `<strong>${esc(n.title)}</strong>${situationBadge(n)}`;
    case 'notes': return esc(n.notes);
    case 'priority': return n.priority ? `<span class="prio-yes">${t('yes')}</span>` : `<span class="muted">${t('no')}</span>`;
    case 'due_date': {
      if (!n.due_date) return DASH;
      const rel = n.status !== 'done' ? `<span class="rel">${esc(fmtRelative(dayDiff(today, n.due_date)))}</span>` : '';
      return `<span class="date">${fmtDate(n.due_date)}</span>${rel}`;
    }
    case 'reminder_days': return n.reminder_days != null ? t('days.short', { n: n.reminder_days }) : DASH;
    case 'assignees': return esc(fmtAssignees(n.assignees)) || DASH;
    default: return '';
  }
}

function rowHtml({ node: n, showingAll }, { leaving = false, readOnly = false, today }) {
  const hasKids = n.children.length > 0;
  const toggle = hasKids
    ? `<button type="button" class="toggle" data-action="toggle" data-all="${showingAll}" aria-expanded="${showingAll}" aria-label="${t('action.toggle')}">${showingAll ? '▾' : '▸'}</button>`
    : '<span class="toggle-spacer"></span>';
  // alça de arraste: só na tela principal e para quem pode editar (teclado: "Mover para…" no menu)
  const handle = !readOnly && state.view === 'main'
    ? `<span class="task-handle" data-drag-task title="${t('move.drag')}" aria-hidden="true">⋮⋮</span>` : '';

  const isStopped = n.blocking_status === 'stopped';
  const actions = readOnly ? '' : `
    ${isStopped ? `<button type="button" class="icon resume" data-action="resume" title="${t('action.resume')}">${ICON.play}<span>${t('action.resume')}</span></button>` : ''}
    <button type="button" class="icon" data-action="add" title="${t('action.addSub')}" aria-label="${t('action.addSub')}">${ICON.plus}</button>
    <button type="button" class="icon" data-action="menu" aria-haspopup="menu" aria-expanded="false" title="${t('col.actions')}" aria-label="${esc(t('menu.task', { title: n.title }))}">${ICON.more}</button>`;

  // edição direta: clicar na célula abre o campo (só para quem pode editar)
  const ed = field => readOnly ? '' : ` data-field="${field}" tabindex="0"`;   // tabindex: dá para editar pelo teclado (Enter)
  const cell = f => cellDisplay(n, f, today);
  return `
    <tr class="task-row st-${n.status} ${n.paused ? 'paused' : ''} ${leaving ? 'leaving' : ''} ${readOnly ? 'ro' : ''}" data-id="${esc(n.id)}">
      <td class="c-title">
        <div class="title-wrap" style="--depth:${n.depth}">
          ${handle}${toggle}
          <span class="title-text"${ed('title')}>${cell('title')}</span>
        </div>
      </td>
      <td class="c-notes notes" title="${esc(n.notes)}"${ed('notes')}>${cell('notes')}</td>
      <td class="c-priority" data-label="${t('col.priority')}"${ed('priority')}>${cell('priority')}</td>
      <td class="c-due_date" data-label="${t('col.due')}"${ed('due_date')}>${cell('due_date')}</td>
      <td class="c-reminder_days"${ed('reminder_days')}>${cell('reminder_days')}</td>
      <td class="c-assignees" data-label="${t('col.assignee')}" title="${esc(fmtAssignees(n.assignees))}"${ed('assignees')}>${cell('assignees')}</td>
      <td class="c-status" data-label="${t('col.status')}">${statusCell(n, readOnly)}</td>
      <td class="c-actions actions">${actions}</td>
    </tr>`;
}

// O que a visão atual mostra (usado pela tela, pela impressão e pelo CSV)
function viewModel() {
  const f = state.filters[state.view];
  const today = todayISO();
  let roots = rootsFor(state.view, state.forest);
  if (state.view === 'main' && state.leaving.size) {
    roots = state.forest.roots.filter(r => r.status !== 'done' || state.leaving.has(r.id));
  }
  roots = filterRootsByProject(roots, f.projects);
  const rowFilterActive = isRowFilterActive(f);
  const visible = computeVisible(roots, f, state.view, today, { me: state.me });
  const shownRoots = rowFilterActive ? roots.filter(r => visible.has(r.id)) : roots;
  // sem filtro de linha, a tela principal mostra todos os projetos cadastrados (mesmo vazios)
  const groups = groupByProject(shownRoots, state.projects, {
    selected: f.projects,
    includeEmpty: state.view === 'main' && !rowFilterActive,
    order: state.projectOrder,
  });
  return { f, today, groups, visible, rowFilterActive, filterActive: isFilterActive(f), compare: sortComparator(state.sort[state.view]) };
}

// Redesenha já, a não ser que o usuário esteja editando/arrastando ou com o menu aberto:
// aí só marca e o redesenho acontece quando ele terminar (não some com o que ele faz).
function renderSoon() {
  if (state.editing || !$('#menu').hidden) { state.dirty = true; return; }
  render();
}

function render() {
  state.dirty = false;
  const fk = focusKey(document.activeElement);
  closeMenu(false);
  renderFilters();
  renderHead();
  renderPendingButton();
  const vm = viewModel();
  renderSummary(vm.today);

  const empty = $('#empty');
  $('#loading').hidden = !state.loading;
  if (state.loading) {
    $('#rows').innerHTML = '';
    empty.hidden = true;
    return;
  }

  const leavingIds = new Set();
  if (state.view === 'main') {
    state.leaving.forEach(id => {
      const r = state.forest.byId.get(id);
      if (r) [r, ...descendants(r)].forEach(n => leavingIds.add(n.id));
    });
  }
  const collapsed = state.printing ? new Set() : state.collapsed;
  let html = '';
  for (const g of vm.groups) {
    const open = state.printing || !state.collapsedProjects.has(g.key);
    html += projectRowHtml(g, open);
    if (!open) continue;
    const rows = flatten(g.roots, { filterActive: vm.rowFilterActive, visible: vm.visible, collapsed, expanded: state.expanded, compare: vm.compare });
    const readOnly = g.project ? !canEditProject(g.project) : false;
    html += rows.length
      ? rows.map(r => rowHtml(r, { leaving: leavingIds.has(r.node.id), readOnly, today: vm.today })).join('')
      : `<tr class="proj-empty" data-project-empty="${esc(g.key)}"><td colspan="8">${t('proj.empty')}</td></tr>`;
  }
  $('#rows').innerHTML = html;
  empty.hidden = vm.groups.length > 0;
  empty.textContent = t(state.loadError ? 'empty.loadError'
    : vm.filterActive ? 'empty.filtered' : state.view === 'history' ? 'empty.history' : 'empty.main');

  const a = document.activeElement;
  if (fk && (!a || a === document.body || !a.isConnected)) document.querySelector(fk)?.focus({ preventScroll: true });
}

function projectRowHtml(g, open) {
  const p = g.project;
  const name = p ? p.name : t('proj.none');
  const main = state.view === 'main';
  const canAdd = main && (!p || canEditProject(p));
  const owner = isOwner(p);
  const actions = `
    ${main ? `<span class="proj-move">
      <button type="button" class="icon" data-action="proj-up" title="${t('proj.up')}" aria-label="${t('proj.up')}">▴</button>
      <button type="button" class="icon" data-action="proj-down" title="${t('proj.down')}" aria-label="${t('proj.down')}">▾</button>
    </span>` : ''}
    ${canAdd ? `<button type="button" class="icon" data-action="proj-add" title="${t('proj.addTask')}" aria-label="${t('proj.addTask')}">${ICON.plus}</button>` : ''}
    ${owner ? `<button type="button" class="icon" data-action="proj-menu" aria-haspopup="menu" aria-expanded="false" title="${t('col.actions')}" aria-label="${esc(t('menu.project', { name }))}">${ICON.more}</button>` : ''}`;
  const shared = p ? state.members.filter(m => m.project_id === p.id) : [];
  const badge = !p ? ''
    : owner ? (shared.length ? `<span class="badge share" title="${esc(shared.map(m => userEmail(m.user_id)).join(', '))}">${t('share.sharedWith', { n: shared.length })}</span>` : '')
    : `<span class="badge share">${esc(t('share.from', { email: userEmail(p.owner_id) }))} · ${t(myRole(p) === 'editor' ? 'share.roleEditor' : 'share.roleViewer')}</span>`;
  return `
    <tr class="proj-row" data-project="${esc(g.key)}">
      <td colspan="8">
        <div class="proj-head">
          ${main ? `<span class="drag-handle" title="${t('proj.drag')}" aria-hidden="true">⋮⋮</span>` : ''}
          <button type="button" class="toggle" data-action="proj-toggle" aria-expanded="${open}" aria-label="${esc(`${t('action.toggle')}: ${name}`)}">${open ? '▾' : '▸'}</button>
          <span class="proj-name">${esc(name)}</span>
          <span class="proj-count">${g.roots.length}</span>
          ${badge}
          <span class="spacer"></span>
          <span class="actions">${actions}</span>
        </div>
      </td>
    </tr>`;
}

// ---------- menu "⋯" ----------
// Um único menu flutuante, preenchido a cada abertura. Teclado: setas, Home/End, Enter, Esc.
let menuCtx = null;   // { btn, items, onPick }

function openMenu(btn, items, onPick) {
  if (menuCtx?.btn === btn) { closeMenu(true); return; }   // segundo clique no mesmo botão fecha
  closeMenu(false);
  const el = $('#menu');
  el.innerHTML = items.map(it => `
    <button type="button" role="menuitem" tabindex="-1" data-item="${esc(it.id)}"${it.danger ? ' class="danger"' : ''}>${ICON[it.icon] || ''}<span>${esc(it.label)}</span></button>`).join('');
  el.setAttribute('aria-label', btn.getAttribute('aria-label') || '');
  el.hidden = false;
  // abre abaixo do botão, alinhado à direita; sem espaço, abre acima
  const r = btn.getBoundingClientRect(), m = el.getBoundingClientRect();
  let top = r.bottom + 4;
  if (top + m.height > window.innerHeight - 8) top = Math.max(8, r.top - m.height - 4);
  const left = Math.max(8, Math.min(r.right - m.width, window.innerWidth - m.width - 8));
  el.style.top = `${top}px`;
  el.style.left = `${left}px`;
  btn.setAttribute('aria-expanded', 'true');
  menuCtx = { btn, items, onPick };
  el.querySelector('[role=menuitem]')?.focus();
}

function closeMenu(returnFocus = true) {
  const el = $('#menu');
  if (el.hidden) return;
  el.hidden = true;
  el.innerHTML = '';
  const ctx = menuCtx;
  menuCtx = null;
  if (ctx?.btn.isConnected) {
    ctx.btn.setAttribute('aria-expanded', 'false');
    if (returnFocus) ctx.btn.focus();
  }
  if (state.dirty) setTimeout(renderSoon, 0);   // chegou dado novo com o menu aberto
}

function bindMenu() {
  const el = $('#menu');
  el.addEventListener('keydown', e => {
    const items = [...el.querySelectorAll('[role=menuitem]')];
    const i = items.indexOf(document.activeElement);
    let next = null;
    switch (e.key) {
      case 'ArrowDown': next = items[(i + 1) % items.length]; break;
      case 'ArrowUp': next = items[(i - 1 + items.length) % items.length]; break;
      case 'Home': next = items[0]; break;
      case 'End': next = items[items.length - 1]; break;
      case 'Escape': case 'Tab': e.preventDefault(); closeMenu(true); return;
      default: return;
    }
    e.preventDefault();
    next?.focus();
  });
  el.addEventListener('click', e => {
    const b = e.target.closest('[data-item]');
    if (!b || !menuCtx) return;
    const { onPick } = menuCtx;
    closeMenu(true);   // devolve o foco ao botão antes da ação (o pop-up volta para ele ao fechar)
    onPick(b.dataset.item);
  });
  document.addEventListener('pointerdown', e => {
    if (el.hidden || el.contains(e.target) || menuCtx?.btn.contains(e.target)) return;
    closeMenu(false);
  });
  window.addEventListener('resize', () => closeMenu(false));
  document.addEventListener('scroll', e => { if (!el.contains(e.target)) closeMenu(false); }, true);
}

function taskMenuItems(node) {
  const items = [{ id: 'edit', icon: 'edit', label: t('action.edit') }];
  if (!node.paused && node.status !== 'done') items.push({ id: 'pause', icon: 'stop', label: t('action.pause') });
  if (state.view === 'main') items.push({ id: 'move', icon: 'move', label: t('action.move') });
  items.push({ id: 'delete', icon: 'trash', label: t('action.delete'), danger: true });
  return items;
}

const projectMenuItems = () => [
  { id: 'proj-edit', icon: 'share', label: t('proj.edit') },
  { id: 'proj-delete', icon: 'trash', label: t('proj.delete'), danger: true },
];

// ---------- arrastar projetos ----------
// Pointer events (mouse, caneta e toque) em vez do arrastar nativo do HTML, que
// falha com linhas de tabela em alguns navegadores. Durante o arraste só as
// linhas de projeto ficam visíveis e a linha arrastada muda de lugar ao vivo.
const calm = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// rola a página quando o ponteiro chega perto das bordas (arrastes)
function edgeScroll(y) {
  if (y < 60) window.scrollBy(0, -12);
  else if (y > window.innerHeight - 60) window.scrollBy(0, 12);
}

function bindProjectDrag() {
  const rowsEl = $('#rows');
  let drag = null;   // { row, startY, active, ready, shift }

  const projRows = () => [...rowsEl.querySelectorAll('tr.proj-row')];
  const EASE = 'cubic-bezier(.2, .8, .2, 1)';
  const inView = el => { const b = el.getBoundingClientRect(); return b.bottom > 0 && b.top < window.innerHeight; };

  // posição atual (visual) de cada linha de projeto
  const tops = () => new Map(projRows().map(r => [r.dataset.project, r.getBoundingClientRect().top]));

  // FLIP: desliza cada linha de projeto da posição antiga até a nova
  function slide(first, duration = 660, skip = null) {
    if (calm()) return;
    projRows().forEach(r => {
      if (r === skip) return;
      const f = first.get(r.dataset.project);
      if (f == null) return;
      r.getAnimations().forEach(a => a.cancel());
      const dy = f - r.getBoundingClientRect().top;
      if (Math.abs(dy) > 1) r.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration, easing: EASE });
    });
  }

  // meio da linha pela posição de layout (ignora animações em andamento, evita tremer)
  const midY = r => rowsEl.getBoundingClientRect().top + (r.offsetTop - rowsEl.offsetTop) + r.offsetHeight / 2;

  rowsEl.addEventListener('pointerdown', e => {
    if (e.button !== 0 || state.editing || drag || state.view !== 'main') return;
    const row = e.target.closest('tr.proj-row');
    if (!row || e.target.closest('button, input, select, a')) return;
    // no toque, só pela alça: tocar no resto da faixa e deslizar é rolar a página
    if (e.pointerType === 'touch' && !e.target.closest('.drag-handle')) return;
    drag = { row, startY: e.clientY, active: false, ready: false, shift: 0 };
    if (e.target.closest('.drag-handle')) {
      e.preventDefault();   // não seleciona texto nem rola (toque)
      start();              // pela alça, recolhe já no clique (pelo resto da linha, só ao mover)
    }
  });

  // 1) as tarefas visíveis recolhem para dentro do projeto; 2) os projetos deslizam juntos
  async function start() {
    const d = drag;
    d.active = true;
    state.editing = true;   // pausa a atualização automática enquanto arrasta
    document.body.classList.add('is-dragging');
    d.row.classList.add('dragging');
    const first = tops();
    const before = d.row.getBoundingClientRect().top;

    const tasks = [...rowsEl.querySelectorAll('tr:not(.proj-row)')].filter(inView);
    let fades = [];
    if (!calm() && tasks.length) {
      fades = tasks.map(tr => tr.animate(
        [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(-10px) scaleY(.85)' }],
        { duration: 450, easing: 'ease-in', fill: 'forwards' }));
      await Promise.all(fades.map(a => a.finished.catch(() => {})));
    }
    if (drag !== d) { fades.forEach(a => a.cancel()); return; }   // soltou antes de terminar

    rowsEl.classList.add('dragging-projects');
    fades.forEach(a => a.cancel());
    // a linha subiu: rola para ela continuar sob o ponteiro; o que não der vira deslocamento
    window.scrollBy(0, d.row.getBoundingClientRect().top - before);
    d.shift = d.row.getBoundingClientRect().top - before;
    slide(first);
    d.ready = true;
  }

  // ao soltar: projetos deslizam para o lugar e as tarefas reaparecem
  function finish(save) {
    const d = drag;
    drag = null;
    if (!d?.active) return;
    const first = tops();
    document.body.classList.remove('is-dragging');
    rowsEl.classList.remove('dragging-projects');
    state.editing = false;
    if (save && d.ready) saveProjectOrder(projRows().map(r => r.dataset.project));   // já renderiza
    else render();
    if (calm()) return;
    slide(first, 780);
    [...rowsEl.querySelectorAll('tr:not(.proj-row)')].filter(inView).forEach(tr => tr.animate(
      [{ opacity: 0, transform: 'translateY(-10px) scaleY(.85)' }, { opacity: 1, transform: 'none' }],
      { duration: 660, delay: 360, easing: 'ease-out', fill: 'backwards' }));
  }

  window.addEventListener('pointermove', e => {
    if (!drag) return;
    if (!drag.active) {
      if (Math.abs(e.clientY - drag.startY) < 5) return;   // ainda é um clique
      start();
      return;
    }
    e.preventDefault();
    if (!drag.ready) return;   // esperando as tarefas recolherem

    // posição desejada = quantos projetos têm o meio acima do ponteiro
    const y = e.clientY + drag.shift;
    const rows = projRows();
    const others = rows.filter(r => r !== drag.row);
    const idx = others.filter(r => midY(r) < y).length;
    if (idx !== rows.indexOf(drag.row)) {
      const first = tops();
      if (idx < others.length) rowsEl.insertBefore(drag.row, others[idx]);
      else others[others.length - 1].after(drag.row);
      slide(first, 480, drag.row);   // os vizinhos abrem espaço deslizando
    }
    edgeScroll(e.clientY);
  }, { passive: false });

  window.addEventListener('pointerup', () => finish(true));
  window.addEventListener('pointercancel', () => finish(false));
  window.addEventListener('keydown', e => { if (e.key === 'Escape' && drag?.active) finish(false); });
}

// Alternativa ao arraste (teclado e leitores de tela): troca o projeto de lugar com o vizinho visível.
function moveProject(key, dir) {
  const keys = [...$('#rows').querySelectorAll('tr.proj-row')].map(r => r.dataset.project);
  const i = keys.indexOf(key), j = i + dir;
  if (i < 0 || j < 0 || j >= keys.length) return;
  [keys[i], keys[j]] = [keys[j], keys[i]];
  saveProjectOrder(keys);
  $('#rows').querySelector(`tr.proj-row[data-project="${CSS.escape(key)}"] [data-action="${dir < 0 ? 'proj-up' : 'proj-down'}"]`)?.focus();
}

// Salva a ordem da tela. Projetos escondidos pelo filtro mantêm o lugar deles.
async function saveProjectOrder(visibleKeys) {
  const shown = new Set(visibleKeys);
  let i = 0;
  const ids = orderedKeys(state.projects, state.projectOrder).map(k => shown.has(k) ? visibleKeys[i++] : k);
  const changed = ids.join() !== orderedKeys(state.projects, state.projectOrder).join();
  state.projectOrder = ids;
  render();
  if (!changed) return;
  const { error } = await sb.rpc('save_project_order', { p_ids: ids.map(id => id === NO_PROJECT ? null : id) });
  if (error) { fail(error); await loadTasks(); }
}

// ---------- arrastar tarefas (mudar de projeto ou de tarefa mãe) ----------
// Pela alça ⋮⋮ da linha. Soltar numa faixa de projeto = vira tarefa principal dele;
// soltar sobre outra tarefa = vira subtarefa dela. Destinos inválidos ficam em vermelho.
// Alternativa por teclado: "Mover para…" no menu ⋯.
function bindTaskDrag() {
  const rowsEl = $('#rows');
  let drag = null;   // { node, row, startX, startY, active, ghost, hoverEl, target, err }

  rowsEl.addEventListener('pointerdown', e => {
    const handle = e.target.closest('[data-drag-task]');
    if (!handle || e.button !== 0 || state.editing || drag) return;
    const row = handle.closest('tr[data-id]');
    const node = row && state.forest.byId.get(row.dataset.id);
    if (!node) return;
    e.preventDefault();   // não seleciona texto nem rola a página (toque)
    drag = { node, row, startX: e.clientX, startY: e.clientY, active: false, ghost: null, hoverEl: null, target: null, err: null };
  });

  function start() {
    drag.active = true;
    state.editing = true;   // pausa a atualização automática enquanto arrasta
    closeMenu(false);
    document.body.classList.add('is-dragging-task');
    drag.row.classList.add('drag-source');
    const g = document.createElement('div');
    g.className = 'drag-ghost';
    g.setAttribute('aria-hidden', 'true');
    g.textContent = drag.node.title;   // textContent: título do usuário não vira HTML
    document.body.append(g);
    drag.ghost = g;
  }

  // o que está sob o ponteiro: faixa de projeto, aviso "projeto vazio" ou linha de tarefa
  function hit(x, y) {
    const tr = document.elementFromPoint(x, y)?.closest('#rows tr');
    if (!tr) return null;
    if (tr.dataset.project) return { el: tr, target: { project: tr.dataset.project } };
    if (tr.dataset.projectEmpty) return { el: tr, target: { project: tr.dataset.projectEmpty } };
    const p = tr.dataset.id && state.forest.byId.get(tr.dataset.id);
    return p ? { el: tr, target: { parent: p } } : null;
  }

  function mark(h) {
    drag.hoverEl?.classList.remove('drop-ok', 'drop-bad');
    drag.hoverEl = h?.el ?? null;
    drag.err = h ? moveError(drag.node, h.target, moveCtx()) : null;
    drag.target = h && !drag.err ? h.target : null;
    drag.hoverEl?.classList.add(drag.err ? 'drop-bad' : 'drop-ok');
  }

  function finish(save) {
    const d = drag;
    drag = null;
    if (!d?.active) return;
    d.hoverEl?.classList.remove('drop-ok', 'drop-bad');
    d.row.classList.remove('drag-source');
    d.ghost?.remove();
    document.body.classList.remove('is-dragging-task');
    state.editing = false;
    if (save && d.target) { performMove(d.node, d.target); return; }
    // soltou num destino proibido (sem ser a própria linha): explica o motivo
    if (save && d.err && d.hoverEl !== d.row && d.err !== 'move.errSame') toast(t(d.err), true);
    if (state.dirty) render();
  }

  window.addEventListener('pointermove', e => {
    if (!drag) return;
    if (!drag.active) {
      if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < 5) return;   // ainda é um clique
      start();
    }
    e.preventDefault();
    drag.ghost.style.transform = `translate(${e.clientX + 14}px, ${e.clientY + 10}px)`;
    mark(hit(e.clientX, e.clientY));
    edgeScroll(e.clientY);
  }, { passive: false });

  window.addEventListener('pointerup', () => finish(true));
  window.addEventListener('pointercancel', () => finish(false));
  window.addEventListener('keydown', e => { if (e.key === 'Escape' && drag?.active) finish(false); });
}

// Grava a mudança de lugar. O banco confere permissões e ciclos de novo (trigger
// prevent_task_cycle; migrações 005/007 para tirar a árvore de um projeto).
async function performMove(node, target) {
  const err = moveError(node, target, moveCtx());
  if (err) { toast(t(err), true); return false; }
  const { error } = await sb.from('tasks').update(movePatch(target)).eq('id', node.id);
  if (error) { fail(error); return false; }
  if (target.parent) { state.collapsed.delete(target.parent.id); state.expanded.add(target.parent.id); }
  else if (state.collapsedProjects.delete(target.project)) savePrefs();
  toast(t('move.done', { title: node.title }));
  await afterChange();
  return true;
}

// "Mover para…": escolhe o destino numa lista (alternativa ao arraste)
async function moveDialog(node) {
  const ctx = moveCtx();
  const projKeys = orderedKeys(state.projects, state.projectOrder).filter(k => !moveError(node, { project: k }, ctx));
  const groups = groupByProject(rootsFor('main', state.forest), state.projects, { order: state.projectOrder })
    .map(g => ({ key: g.key, items: g.roots.flatMap(r => [r, ...descendants(r)]).filter(x => !moveError(node, { parent: x }, ctx)) }))
    .filter(g => g.items.length);
  const label = x => [...ancestors(x), x].map(a => a.title).join(' › ');

  const form = projKeys.length || groups.length ? `
    <form id="move-form" style="display:grid;gap:12px">
      <label>${t('move.target')}
        <select name="dest" required>
          <option value="">${t('move.choose')}</option>
          ${projKeys.length ? `<optgroup label="${esc(t('move.asMain'))}">${projKeys.map(k => `<option value="p:${esc(k)}">${esc(projectName(k))}</option>`).join('')}</optgroup>` : ''}
          ${groups.map(g => `<optgroup label="${esc(t('move.inside', { project: projectName(g.key) }))}">${g.items.map(x => `<option value="t:${esc(x.id)}">${esc(label(x))}</option>`).join('')}</optgroup>`).join('')}
        </select>
      </label>
      <div class="m-actions">
        <button type="button" data-close>${t('btn.cancel')}</button>
        <button class="primary">${t('move.submit')}</button>
      </div>
    </form>` : `
    <p class="muted">${t('move.none')}</p>
    <div class="m-actions"><button type="button" class="primary" data-close>${t('btn.ok')}</button></div>`;

  const done = openDialog(t('move.title'), `${pathHtml(node)}<p><strong>${esc(node.title)}</strong></p>${form}`);
  dlg.querySelector('#move-form')?.addEventListener('submit', guard(async e => {
    const v = e.target.elements.dest.value;
    const target = v.startsWith('p:') ? { project: v.slice(2) } : { parent: state.forest.byId.get(v.slice(2)) };
    if (!target.project && !target.parent) return;
    if (await performMove(state.forest.byId.get(node.id) ?? node, target)) dlg.close();
  }));
  await done;
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
  form.addEventListener('submit', guard(async () => {
    const name = form.elements.name.value.trim();
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
  }));
  await done;
  await loadTasks();
}

async function deleteProject(project) {
  const n = state.forest.roots.filter(r => r.project_id === project.id).length;
  const msg = n ? t('proj.confirmDelete', { name: project.name, n }) : t('proj.confirmDeleteEmpty', { name: project.name });
  if (!await confirmDialog({ title: t('proj.delete'), message: msg, confirmLabel: t('action.delete'), danger: true })) return;
  const { error } = await sb.rpc('delete_project', { p_id: project.id });
  if (error) return fail(error);
  const f = state.filters;
  f.main.projects = f.main.projects.filter(id => id !== project.id);
  f.history.projects = f.history.projects.filter(id => id !== project.id);
  state.collapsedProjects.delete(project.id);
  savePrefs();
  await loadTasks();
}

// projeto sugerido para uma tarefa nova: o do filtro, se só um estiver marcado
function defaultProjectId() {
  const sel = state.filters.main.projects;
  const p = sel.length === 1 && projectById(sel[0]);
  return p && canEditProject(p) ? p.id : null;
}

// Cache de 1 minuto: evita uma ida ao banco a cada formulário aberto
async function loadUsers({ force = false } = {}) {
  if (!force && state.users.length && Date.now() - state.usersAt < 60 * 1000) return;
  const { data, error } = await sb.rpc('list_users');
  if (error) return fail(error);
  state.users = data;
  state.usersAt = Date.now();
}

// ---------- edição direta na tabela ----------
// Otimista: a célula mostra o valor novo na hora; se o banco recusar, volta ao antigo.
function startInlineEdit(cell, node, field) {
  if (field === 'assignees') { editAssignees(node); return; }   // abre janela com a lista
  const v = node[field];
  let html;
  switch (field) {
    case 'title':
      html = `<input class="cell-edit" maxlength="300" value="${esc(v)}" aria-label="${t('col.task')}">`; break;
    case 'notes':
      html = `<textarea class="cell-edit" rows="2" placeholder="${t('inline.notesHint')}" aria-label="${t('col.notes')}">${esc(v)}</textarea>`; break;
    case 'priority':
      html = `<select class="cell-edit" aria-label="${t('col.priority')}"><option value="no">${t('no')}</option><option value="yes" ${v ? 'selected' : ''}>${t('yes')}</option></select>`; break;
    case 'due_date':
      html = `<input class="cell-edit" type="date" value="${esc(v)}" aria-label="${t('col.due')}">`; break;
    case 'reminder_days':
      html = `<input class="cell-edit" type="number" min="0" value="${esc(v)}" aria-label="${t('form.reminder')}">`; break;
    default: return;
  }
  closeMenu(false);
  state.editing = true;
  cell.classList.add('editing');
  cell.innerHTML = html;
  const input = cell.querySelector('.cell-edit');
  input.focus();
  if (input.select && field !== 'due_date' && field !== 'reminder_days') input.select();
  if (field === 'priority' && input.showPicker) { try { input.showPicker(); } catch { /* ignora */ } }

  // devolve a célula ao modo de leitura sem redesenhar a tabela
  // (assim o clique em outra célula, que causou o blur, continua valendo)
  const show = n => { cell.classList.remove('editing'); cell.innerHTML = cellDisplay(n, field); };
  let finished = false, byKey = false;
  const finish = async save => {
    if (finished) return;
    finished = true;
    const cur = state.forest.byId.get(node.id) ?? node;
    const value = readInlineValue(field, input.value);
    state.editing = false;   // libera já: o próximo clique em outra célula não é ignorado enquanto salva
    if (!save || value === undefined || value === (cur[field] ?? null)) {
      show(cur);
      if (byKey) cell.focus();
      if (state.dirty) renderSoon();
      return;
    }
    const prev = patchTask(node.id, { [field]: value });
    show(state.forest.byId.get(node.id) ?? cur);
    if (byKey) cell.focus();
    const { error } = await sb.from('tasks').update({ [field]: value }).eq('id', node.id);
    if (error) { patchTask(node.id, prev); fail(error); renderSoon(); return; }
    if (field === 'due_date' && value && value < todayISO() && cur.status !== 'done') toast(t('form.pastDueSaved'));
    await afterChange();   // reconcilia com o banco (status da mãe, atraso etc.)
  };

  input.addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.preventDefault(); byKey = true; finish(false); }
    else if (e.key === 'Enter' && !(field === 'notes' && e.shiftKey)) { e.preventDefault(); byKey = true; finish(true); }
  });
  input.addEventListener('blur', () => finish(true));
  if (field === 'priority') input.addEventListener('change', () => finish(true));
}

// valor digitado -> valor do banco (undefined = inválido, não salva)
function readInlineValue(field, raw) {
  const s = raw.trim();
  switch (field) {
    case 'title': return s || undefined;               // título não pode ficar vazio
    case 'notes': return s || null;
    case 'priority': return raw === 'yes';
    case 'due_date': return s || null;
    case 'reminder_days': {
      if (s === '') return null;
      const n = Math.floor(Number(s));
      return Number.isFinite(n) && n >= 0 ? n : undefined;
    }
  }
}

// ---------- responsáveis ----------
// "Ana, joao@x.com; Ana" -> ['Ana', 'joao@x.com'] (sem vazios nem repetidos)
function parseAssignees(raw) {
  const seen = new Set();
  return String(raw ?? '').split(/[,;\n]/).map(s => s.trim()).filter(s => {
    const k = s.toLowerCase();
    if (!s || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
const fmtAssignees = list => (list || []).join(', ');

// Campo de texto livre + aba com checkboxes dos usuários cadastrados.
// O texto é a fonte da verdade; marcar/desmarcar só acrescenta ou tira o e-mail dele.
function assigneeField(name, list = []) {
  const emails = state.users.map(u => u.email);
  const sel = new Set((list || []).map(s => s.toLowerCase()));
  return `
    <div class="assignee-field" data-assignees>
      <label for="as-${name}">${t('form.assignee')}</label>
      <input id="as-${name}" name="${name}" autocomplete="off" maxlength="2000" value="${esc(fmtAssignees(list))}" placeholder="${t('form.assigneeHint')}">
      <details class="multi">
        <summary></summary>
        <div class="multi-panel">
          ${emails.length
            ? emails.map(e => `<label class="chk"><input type="checkbox" value="${esc(e)}" ${sel.has(e.toLowerCase()) ? 'checked' : ''}> ${esc(e)}</label>`).join('')
            : `<p class="muted">${t('share.noUsers')}</p>`}
        </div>
      </details>
    </div>`;
}

function bindAssigneeField(root) {
  root.querySelectorAll('[data-assignees]').forEach(box => {
    const input = box.querySelector('input[name]');
    const checks = [...box.querySelectorAll('input[type=checkbox]')];
    const summary = box.querySelector('summary');
    const sync = () => {
      const sel = new Set(parseAssignees(input.value).map(s => s.toLowerCase()));
      checks.forEach(c => { c.checked = sel.has(c.value.toLowerCase()); });
      const n = checks.filter(c => c.checked).length;
      summary.textContent = n ? t('form.pickUsersN', { n }) : t('form.pickUsers');
    };
    checks.forEach(c => c.addEventListener('change', () => {
      const list = parseAssignees(input.value).filter(s => s.toLowerCase() !== c.value.toLowerCase());
      input.value = fmtAssignees(c.checked ? [...list, c.value] : list);
      sync();
    }));
    input.addEventListener('input', sync);
    sync();
  });
}

// Clique na célula "Responsável": janela só com o campo de responsáveis
async function editAssignees(node) {
  await loadUsers();
  let changed = false;
  const done = openDialog(t('form.assigneesTitle'), `
    ${pathHtml(node)}
    <p><strong>${esc(node.title)}</strong></p>
    <form id="who-form" style="display:grid;gap:12px">
      ${assigneeField('assignees', node.assignees)}
      <div class="m-actions">
        <button type="button" data-close>${t('btn.cancel')}</button>
        <button class="primary">${t('btn.save')}</button>
      </div>
    </form>`);
  bindAssigneeField(dlg);
  dlg.querySelector('#who-form').addEventListener('submit', guard(async e => {
    const { error } = await sb.from('tasks')
      .update({ assignees: parseAssignees(e.target.elements.assignees.value) }).eq('id', node.id);
    if (error) return fail(error);
    changed = true;
    dlg.close();
  }));
  await done;
  if (changed) await afterChange();
}

// ---------- formulário de tarefa ----------
async function taskForm({ task = null, parentId = null, projectId = null }) {
  await loadUsers();   // inclui usuários criados depois do login (e quem está criando vem como responsável)
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
        <label>${t('form.due')}<input type="date" name="due_date" value="${esc(v.due_date)}" aria-describedby="due-warn"></label>
        <label>${t('form.reminder')}<input type="number" name="reminder_days" min="0" value="${esc(v.reminder_days)}"></label>
        <p class="warn" id="due-warn" aria-live="polite"></p>
        <label class="chk"><input type="checkbox" name="priority" ${v.priority ? 'checked' : ''}> ${t('form.priority')}</label>
        ${assigneeField('assignees', task ? v.assignees : state.users.filter(u => u.id === state.userId).map(u => u.email))}
      </div>
      <div class="m-actions">
        <button type="button" data-close>${t('btn.cancel')}</button>
        <button class="primary">${t('btn.save')}</button>
      </div>
    </form>`);
  bindAssigneeField(dlg);
  const form = dlg.querySelector('#task-form');

  // prazo no passado: avisa (sem impedir) que a tarefa já vai nascer "Atrasado"
  const warn = form.querySelector('#due-warn');
  const checkDue = () => {
    const d = form.elements.due_date.value;
    warn.textContent = d && d < todayISO() && d !== (v.due_date || '') && v.status !== 'done' ? t('form.pastDue') : '';
  };
  form.elements.due_date.addEventListener('input', checkDue);
  form.elements.due_date.addEventListener('change', checkDue);

  form.addEventListener('submit', guard(async e => {
    const fd = new FormData(e.target);
    const payload = {
      title: fd.get('title').trim(),
      notes: fd.get('notes').trim() || null,
      due_date: fd.get('due_date') || null,
      reminder_days: fd.get('reminder_days') === '' ? null : Number(fd.get('reminder_days')),
      assignees: parseAssignees(fd.get('assignees')),
      priority: fd.get('priority') === 'on',
    };
    if (isRoot) payload.project_id = fd.get('project_id') || null;
    const { error } = task
      ? await sb.from('tasks').update(payload).eq('id', task.id)
      : await sb.from('tasks').insert({ ...payload, parent_id: parentId });
    if (error) return fail(error);
    if (parentId) { state.collapsed.delete(parentId); state.expanded.add(parentId); }
    dlg.close();
  }));

  await done;
}

// ---------- ações da linha ----------
// Otimista: o select muda na hora; se o banco recusar, volta e mostra o erro.
// Depois do sucesso recarrega para pegar o que o banco recalculou (mãe, atraso, conclusão).
async function changeStatus(node, status) {
  const id = node.id;
  const prev = patchTask(id, { status });
  if (!prev) return;
  // raiz concluída: continua visível (sumindo) até o anúncio de "foi para o Histórico"
  const finishingRoot = !node.parent && status === 'done' && state.view === 'main';
  if (finishingRoot) {
    state.leaving.add(id);
    setTimeout(() => { state.leaving.delete(id); renderSoon(); }, LEAVE_MS + 1000);
  }
  render();
  const { error } = await sb.from('tasks').update({ status }).eq('id', id);
  if (error) {
    if (finishingRoot) state.leaving.delete(id);
    patchTask(id, prev);
    fail(error);
    renderSoon();
    return;
  }
  await afterChange();
}

async function deleteTask(node) {
  const n = descendants(node).length;
  const msg = n
    ? t('delete.withChildren', { title: node.title, n })
    : t('delete.single', { title: node.title });
  if (!await confirmDialog({ title: t('delete.title'), message: msg, confirmLabel: t('action.delete'), danger: true })) return;
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
  dlg.querySelector('#pause-form').addEventListener('submit', guard(async e => {
    const reason = new FormData(e.target).get('reason');
    const { error } = await sb.rpc('set_situation', { p_task: node.id, p_situation: 'stopped', p_reason: reason });
    if (error) return fail(error);
    dlg.close();
  }));
  await done;
  await afterChange();
}

async function rowAction(action, id) {
  const node = state.forest.byId.get(id);
  if (!node) return;
  switch (action) {
    case 'add': await taskForm({ parentId: node.id }); await afterChange(); break;
    case 'edit': await taskForm({ task: node }); await afterChange(); break;
    case 'delete': await deleteTask(node); break;
    case 'pause': await pauseTask(node); break;
    case 'resume': await resumeTask(node); break;
    case 'move': await moveDialog(node); break;
  }
}

async function projectAction(action, key) {
  const project = projectById(key);
  if (!project) return;
  if (action === 'proj-edit') await projectForm(project);
  else if (action === 'proj-delete') await deleteProject(project);
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
      <tr data-id="${esc(x.id)}">
        <td style="padding-left:${(x.depth - node.depth) * 16 + 6}px">
          ${esc(x.title)}
          ${expired ? `<span class="flag">${t('resume.expired')}</span>` : ''}
          ${x.status === 'in_progress' ? `<span class="flag info">${t('resume.wasInProgress')}</span>` : ''}
        </td>
        <td><input type="date" name="due" value="${esc(x.due_date)}" data-orig="${esc(x.due_date)}" aria-label="${esc(`${t('col.due')}: ${x.title}`)}"></td>
        <td><select name="status" data-orig="${esc(x.status)}" aria-label="${esc(`${t('col.status')}: ${x.title}`)}">${statusOpts(x.status)}</select></td>
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

  dlg.querySelector('#resume-form').addEventListener('submit', guard(async () => {
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
  }));
  await done;
  await afterChange();
}

// ---------- pendências (atraso, inatividade, lembrete) ----------
// refresh_automations devolve só o que o usuário pode editar. Em vez de abrir os pop-ups
// em fila, ficam num painel (sino no topo); cada um é aberto quando a pessoa escolher.
function setPending(data) {
  const list = k => Array.isArray(data?.[k]) ? data[k] : [];
  state.pending = { overdue: list('overdue'), inactivity: list('inactivity'), reminders: list('reminders') };
  renderPendingButton();
  if (drawer.open) renderDrawer();
}

// Pendências ainda válidas pela lista local (some na hora o que foi resolvido por outro caminho,
// por exemplo um prazo prorrogado direto na tabela). A verificação periódica reconcilia o resto.
function pendingItems() {
  const snoozed = snoozedToday();
  const get = id => state.forest.byId.get(id);
  const out = [];
  for (const p of state.pending.overdue) {
    const node = get(p.task_id);
    if (!node || node.paused || node.status !== 'overdue' || node.due_date !== p.expired_due_date) continue;
    out.push({ key: `o:${p.event_id}`, kind: 'overdue', node, p, snoozed: snoozed.has(p.event_id) });
  }
  for (const p of state.pending.inactivity) {
    const node = get(p.task_id);
    if (!node || node.paused || node.status !== 'in_progress') continue;
    out.push({ key: `i:${p.task_id}`, kind: 'inactivity', node, p, snoozed: false });
  }
  for (const p of state.pending.reminders) {
    const node = get(p.task_id);
    if (!node || node.paused || node.status === 'done' || node.due_date !== p.due_date) continue;
    out.push({ key: `r:${p.task_id}:${p.due_date}`, kind: 'reminder', node, p, snoozed: false });
  }
  return out.sort((a, b) => a.snoozed - b.snoozed);   // adiados ("Lembrar amanhã") por último
}

function renderPendingButton() {
  const n = pendingItems().filter(i => !i.snoozed).length;
  const b = $('#pending-btn');
  const label = t('pending.label', { n });
  b.setAttribute('aria-label', label);
  b.title = label;
  b.classList.toggle('has-pending', n > 0);
  const c = b.querySelector('.bell-count');
  c.textContent = n > 99 ? '99+' : String(n);
  c.hidden = n === 0;
}

// Um toast só, e só quando aparece pendência que ainda não foi avisada
function notifyPending() {
  const items = pendingItems().filter(i => !i.snoozed);
  const fresh = items.some(i => !state.notified.has(i.key));
  state.notified = new Set(items.map(i => i.key));
  if (!items.length || !fresh) return;
  toast(items.length === 1 ? t('pending.toastOne') : t('pending.toastMany', { n: items.length }), false,
    { label: t('pending.view'), onClick: openPending });
}

function pendingItemHtml(i) {
  const { node, p } = i;
  const text = i.kind === 'overdue' ? t('pending.overdueText', { date: fmtDate(p.expired_due_date) })
    : i.kind === 'inactivity' ? t('pending.inactText')
    : t('pending.remText', { when: fmtRelative(Number(p.days_left)), date: fmtDate(p.due_date) });
  const label = t(i.kind === 'reminder' ? 'pending.view' : 'pending.resolve');
  return `
    <li class="pending-item kind-${i.kind}${i.snoozed ? ' snoozed' : ''}">
      <div class="pi-text">
        <span class="pi-kind">${t('pending.kind.' + i.kind)}</span>
        ${pathHtml(node)}
        <strong>${esc(node.title)}</strong>
        <span class="muted small">${esc(text)}${i.snoozed ? ` · ${t('pending.snoozed')}` : ''}</span>
      </div>
      <button type="button" data-resolve="${esc(i.key)}" aria-label="${esc(`${label}: ${node.title}`)}">${label}</button>
    </li>`;
}

function renderDrawer() {
  const focused = document.activeElement?.closest?.('#drawer [data-resolve]')?.dataset.resolve;
  const items = pendingItems();
  drawer.innerHTML = `
    <div class="m-head">
      <h2 id="drawer-title">${t('pending.title')}</h2>
      <button type="button" class="icon" data-close aria-label="${t('action.close')}">✕</button>
    </div>
    <div class="drawer-body">
      ${items.length
        ? `<p class="muted small">${t('pending.hint')}</p><ul class="pending-list">${items.map(pendingItemHtml).join('')}</ul>`
        : `<p class="muted">${t('pending.empty')}</p>`}
    </div>`;
  if (focused) drawer.querySelector(`[data-resolve="${CSS.escape(focused)}"]`)?.focus();
}

function openPending() {
  closeMenu(false);
  if (dlg.open || resolving) return;   // um pop-up por vez
  renderDrawer();
  if (!drawer.open) drawer.showModal();
  (drawer.querySelector('[data-resolve]') || drawer.querySelector('[data-close]'))?.focus();
}

// Abre o pop-up da pendência escolhida; ao fechar, volta para a lista (se ainda houver itens)
let resolving = false;
async function resolvePending(key) {
  if (resolving) return;
  const item = pendingItems().find(i => i.key === key);
  if (!item) return;
  resolving = true;
  drawer.close();
  let result = false;
  try {
    if (item.kind === 'overdue') result = await overduePopup(item.p);
    else if (item.kind === 'inactivity') result = await inactivityPopup(item.p.task_id);
    else result = await reminderPopup(item.p);
  } finally {
    resolving = false;
  }
  if (result === 'done') dropPending(item);
  renderPendingButton();
  if (pendingItems().length && state.userId) openPending();
}

function dropPending(item) {
  const P = state.pending;
  if (item.kind === 'overdue') P.overdue = P.overdue.filter(p => p.event_id !== item.p.event_id);
  else if (item.kind === 'inactivity') P.inactivity = P.inactivity.filter(p => p.task_id !== item.p.task_id);
  else P.reminders = P.reminders.filter(p => p !== item.p);
}

// ---------- regra 9: pop-up de atraso ----------
// Devolve 'done' (resolvido), 'snoozed' (lembrar amanhã) ou false (fechado sem resolver).
async function overduePopup(p) {
  const node = state.forest.byId.get(p.task_id);
  if (!node) return false;
  const today = todayISO();
  let result = false;

  const done = openDialog(t('overdue.title'), `
    ${pathHtml(node)}
    <p>${t('overdue.text', { title: esc(node.title), date: fmtDate(p.expired_due_date) })}</p>
    <p class="muted">${t('overdue.choose')}</p>
    <div class="choice">
      <button type="button" data-mode="extend" aria-pressed="false">${t('overdue.extend')}</button>
      <button type="button" data-mode="plan" aria-pressed="false">${t('overdue.plan')}</button>
    </div>
    <form class="pane" data-pane="extend" hidden>
      <label>${t('overdue.newDue')}<input type="date" name="due" required min="${today}"></label>
      <div class="m-actions"><button class="primary">${t('overdue.extendSubmit')}</button></div>
    </form>
    <form class="pane" data-pane="plan" hidden>
      <label>${t('overdue.planTask')}<input name="plan_title" required maxlength="300"></label>
      <div class="grid2">
        <label>${t('form.due')}<input type="date" name="due" required min="${today}"></label>
        <label>${t('form.reminder')}<input type="number" name="reminder_days" min="0"></label>
        ${assigneeField('assignee', node.assignees)}
      </div>
      <p class="muted">${t('overdue.planHint')}</p>
      <div class="m-actions"><button class="primary">${t('overdue.planSubmit')}</button></div>
    </form>
    <div class="m-actions"><button type="button" data-snooze>${t('overdue.snooze')}</button></div>`);
  bindAssigneeField(dlg);

  dlg.querySelector('[data-snooze]').addEventListener('click', () => {
    snoozeOverdue(p.event_id);
    result = 'snoozed';
    dlg.close();
  });

  dlg.querySelectorAll('[data-mode]').forEach(btn => btn.addEventListener('click', () => {
    dlg.querySelectorAll('[data-mode]').forEach(b => {
      b.classList.toggle('selected', b === btn);
      b.setAttribute('aria-pressed', String(b === btn));
    });
    dlg.querySelectorAll('[data-pane]').forEach(p => { p.hidden = p.dataset.pane !== btn.dataset.mode; });
    focusFirstField(dlg.querySelector(`[data-pane="${btn.dataset.mode}"]`));
  }));

  dlg.querySelector('[data-pane=extend]').addEventListener('submit', guard(async e => {
    const { error } = await sb.rpc('extend_due_date', { p_task: node.id, p_new_due: e.target.elements.due.value });
    if (error) return fail(error);
    result = 'done';
    dlg.close();
  }));

  dlg.querySelector('[data-pane=plan]').addEventListener('submit', guard(async e => {
    const f = e.target.elements;
    const { data: planId, error } = await sb.rpc('create_action_plan', {
      p_parent: node.id, p_title: f.plan_title.value.trim(), p_due: f.due.value,
      p_assignees: parseAssignees(f.assignee.value),
    });
    if (error) return fail(error);
    result = 'done';   // o plano já existe: mesmo que o lembrete falhe, o atraso está resolvido
    if (f.reminder_days.value !== '') {
      const { error: e2 } = await sb.from('tasks')
        .update({ reminder_days: Number(f.reminder_days.value) }).eq('id', planId);
      if (e2) return fail(e2);
    }
    state.collapsed.delete(node.id);
    dlg.close();
  }));

  await done;
  await loadTasks();
  return result;
}

// ---------- regra 10: pop-up de inatividade ----------
async function inactivityPopup(taskId) {
  const node = state.forest.byId.get(taskId);
  if (!node) return false;
  const today = todayISO();
  const desc = descendants(node);
  let result = false;

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
        <label id="reason-label"><span>${t('inact.reason')}</span><textarea name="reason"></textarea></label>
      </fieldset>
      <fieldset>
        <legend>${t('inact.optional')}</legend>
        <label>${t('inact.changeDue')}<input type="date" name="due" value="${esc(node.due_date)}"></label>
        <label>${t('inact.createPlan')}<input name="plan_title" maxlength="300" placeholder="${t('inact.planPlaceholder')}"></label>
        <label>${t('inact.planDue')}<input type="date" name="plan_due" min="${today}"></label>
      </fieldset>
      <div class="m-actions"><button class="primary">${t('btn.confirm')}</button></div>
    </form>`);

  const form = dlg.querySelector('#inact-form');
  const el = form.elements;
  form.addEventListener('change', () => {
    const sit = el.sit.value;
    el.reason.required = sit === 'other';
    dlg.querySelector('#reason-label > span').textContent =
      t(sit === 'other' ? 'inact.reasonOther' : sit === 'waiting_others' ? 'inact.reasonWaiting' : 'inact.reason');
    el.plan_due.required = el.plan_title.value.trim() !== '';
  });
  el.plan_title.addEventListener('input', () => { el.plan_due.required = el.plan_title.value.trim() !== ''; });

  form.addEventListener('submit', guard(async () => {
    if (el.due.value !== (node.due_date || '')) {
      const { error } = await sb.from('tasks').update({ due_date: el.due.value || null }).eq('id', node.id);
      if (error) return fail(error);
      node.due_date = el.due.value || null;   // evita repetir se outra etapa falhar
    }
    if (el.plan_title.value.trim()) {
      const { error } = await sb.rpc('create_action_plan', {
        p_parent: node.id, p_title: el.plan_title.value.trim(), p_due: el.plan_due.value,
      });
      if (error) return fail(error);
      el.plan_title.value = '';
    }
    const { error } = await sb.rpc('set_situation', {
      p_task: node.id, p_situation: el.sit.value, p_reason: el.reason.value, p_from_prompt: true,
    });
    if (error) return fail(error);
    result = 'done';
    dlg.close();
  }));

  await done;
  await loadTasks();
  return result;
}

// ---------- regra 12: lembrete ----------
async function reminderPopup(p) {
  const node = state.forest.byId.get(p.task_id);
  if (!node) return false;
  const when = p.days_left === 0 ? t('rem.today')
    : p.days_left === 1 ? t('rem.tomorrow')
    : t('rem.inDays', { n: p.days_left });

  const done = openDialog(t('rem.title'), `
    ${pathHtml(node)}
    <p><strong>${esc(node.title)}</strong> ${when} (${fmtDate(p.due_date)}).</p>
    ${node.assignees?.length ? `<p class="muted">${esc(t('rem.assignee', { email: fmtAssignees(node.assignees) }))}</p>` : ''}
    <div class="m-actions"><button class="primary" data-close>${t('btn.ok')}</button></div>`);
  await done;   // fechar de qualquer jeito conta como "exibido"
  const { error } = await sb.rpc('ack_reminder', { p_task: node.id });
  if (error) { fail(error); return false; }
  return 'done';
}

// ---------- exportar e imprimir ----------
// CSV da visão atual: mesmos filtros e mesma ordem da tela, com tudo expandido.
function exportCsv() {
  const vm = viewModel();
  const lines = [[
    t('csv.project'), t('csv.path'), t('col.task'), t('col.notes'), t('col.priority'), t('col.due'),
    t('col.reminder'), t('col.assignee'), t('col.status'), t('csv.situation'),
  ]];
  for (const g of vm.groups) {
    const rows = flatten(g.roots, { filterActive: vm.rowFilterActive, visible: vm.visible, collapsed: new Set(), expanded: state.expanded, compare: vm.compare });
    for (const { node: n } of rows) {
      lines.push([
        projectName(g.key), ancestors(n).map(a => a.title).join(' › '), n.title, n.notes ?? '',
        t(n.priority ? 'yes' : 'no'), n.due_date ? fmtDate(n.due_date) : '', n.reminder_days ?? '',
        fmtAssignees(n.assignees), statusText(n.status), n.blocking_status ? t('situation.' + n.blocking_status) : '',
      ]);
    }
  }
  // Blob local + <a download>: nada sai do navegador
  const url = URL.createObjectURL(new Blob([toCSV(lines)], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `cajuca-${state.view === 'history' ? 'historico' : 'tarefas'}-${todayISO()}.csv`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------- login ----------
function showLoginError(key) {
  const err = $('#login-error');
  err.dataset.key = key ?? '';
  err.hidden = !key;
  if (key) err.textContent = t(key);
}

function setPasswordVisible(show) {
  $('#pw-toggle').setAttribute('aria-pressed', String(show));
  $('#login-pw').type = show ? 'text' : 'password';
}

// Aberta pelo link do e-mail "esqueci minha senha" (evento PASSWORD_RECOVERY)
async function passwordDialog() {
  const done = openDialog(t('pw.title'), `
    <form id="pw-form" style="display:grid;gap:12px">
      <label>${t('pw.new')}<input type="password" name="pw" required minlength="8" autocomplete="new-password"></label>
      <div class="m-actions">
        <button type="button" data-close>${t('btn.cancel')}</button>
        <button class="primary">${t('pw.save')}</button>
      </div>
    </form>`);
  dlg.querySelector('#pw-form').addEventListener('submit', guard(async e => {
    const { error } = await sb.auth.updateUser({ password: e.target.elements.pw.value });
    if (error) return fail(error);
    dlg.close();
    toast(t('pw.done'));
  }));
  await done;
}

// ---------- eventos ----------
function bindUi() {
  document.querySelectorAll('.tab').forEach(tab => tab.addEventListener('click', () => switchView(tab.dataset.view)));

  const setFilter = (key, value) => {
    state.filters[state.view][key] = value;
    state.expanded.clear();
    savePrefs();
    render();
  };
  $('#f-priority').addEventListener('change', e => setFilter('priority', e.target.value));
  $('#f-period').addEventListener('change', e => setFilter('period', e.target.value));
  $('#f-assignee').addEventListener('change', e => setFilter('assignee', e.target.value));

  // busca: espera a pessoa parar de digitar; Esc limpa
  let qTimer;
  $('#f-q').addEventListener('input', e => {
    clearTimeout(qTimer);
    qTimer = setTimeout(() => setFilter('q', e.target.value.slice(0, 200)), 250);
  });
  $('#f-q').addEventListener('keydown', e => {
    if (e.key !== 'Escape' || !e.target.value) return;
    e.preventDefault();
    e.target.value = '';
    clearTimeout(qTimer);
    setFilter('q', '');
  });

  $('#f-clear').addEventListener('click', () => {
    clearTimeout(qTimer);
    state.filters[state.view] = freshFilters();
    $('#f-q').value = '';
    state.expanded.clear();
    savePrefs();
    render();
    if (!window.matchMedia('(pointer: coarse)').matches) $('#f-q').focus();   // o botão sumiu: o foco vai para a busca
  });

  // atalhos: "Minhas tarefas" liga/desliga; os de prazo/status são exclusivos entre si
  const toggleQuick = k => setFilter('quick', state.filters[state.view].quick === k ? '' : k);
  $('#chips').addEventListener('click', e => {
    const b = e.target.closest('[data-chip]');
    if (!b) return;
    if (b.dataset.chip === 'mine') setFilter('mine', !state.filters[state.view].mine);
    else toggleQuick(b.dataset.chip);
  });
  $('#summary').addEventListener('click', e => {
    const b = e.target.closest('[data-quick]');
    if (b) toggleQuick(b.dataset.quick);
  });

  // celular: a barra de filtros abre e fecha
  $('#f-toggle').addEventListener('click', () => {
    const open = !$('#toolbar').classList.contains('open');
    $('#toolbar').classList.toggle('open', open);
    $('#f-toggle').setAttribute('aria-expanded', String(open));
  });

  $('#head').addEventListener('click', e => {
    const b = e.target.closest('[data-sort]');
    if (!b) return;
    state.sort[state.view] = nextSort(state.sort[state.view], b.dataset.sort);
    savePrefs();
    render();
  });

  $('#new-task').addEventListener('click', async () => { await taskForm({ projectId: defaultProjectId() }); await afterChange(); });
  $('#new-project').addEventListener('click', () => projectForm());
  $('#export-csv').addEventListener('click', exportCsv);
  $('#print').addEventListener('click', () => window.print());
  // impressão: tudo expandido (projetos e tarefas), respeitando os filtros
  window.addEventListener('beforeprint', () => { state.printing = true; render(); });
  window.addEventListener('afterprint', () => { state.printing = false; render(); });

  $('#pending-btn').addEventListener('click', openPending);
  drawer.addEventListener('click', e => {
    if (e.target === drawer || e.target.closest('[data-close]')) { drawer.close(); return; }   // fundo ou ✕
    const b = e.target.closest('[data-resolve]');
    if (b) resolvePending(b.dataset.resolve);
  });

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

  bindMenu();
  bindProjectDrag();
  bindTaskDrag();

  $('#rows').addEventListener('click', async e => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) {
      const cell = e.target.closest('[data-field]');
      if (cell && !state.editing) {
        const node = state.forest.byId.get(cell.closest('tr').dataset.id);
        if (node) startInlineEdit(cell, node, cell.dataset.field);
      }
      return;
    }
    const projRow = btn.closest('tr.proj-row');
    if (projRow) {
      const key = projRow.dataset.project;
      switch (btn.dataset.action) {
        case 'proj-toggle':
          if (state.collapsedProjects.has(key)) state.collapsedProjects.delete(key);
          else state.collapsedProjects.add(key);
          savePrefs();
          render();
          break;
        case 'proj-up': case 'proj-down': moveProject(key, btn.dataset.action === 'proj-up' ? -1 : 1); break;
        case 'proj-add': await taskForm({ projectId: projectById(key)?.id ?? null }); await afterChange(); break;
        case 'proj-menu': openMenu(btn, projectMenuItems(), a => projectAction(a, key)); break;
      }
      return;
    }
    const id = btn.closest('tr')?.dataset.id;
    const node = id && state.forest.byId.get(id);
    if (!node) return;
    switch (btn.dataset.action) {
      case 'toggle':
        toggleNode(node.id, btn.dataset.all === 'true', state.collapsed, state.expanded);
        render();
        break;
      case 'menu': openMenu(btn, taskMenuItems(node), a => rowAction(a, id)); break;
      default: await rowAction(btn.dataset.action, id);
    }
  });

  // edição direta pelo teclado: Tab até a célula e Enter (ou F2)
  $('#rows').addEventListener('keydown', e => {
    if ((e.key !== 'Enter' && e.key !== 'F2') || !e.target.matches('[data-field]') || state.editing) return;
    e.preventDefault();
    const node = state.forest.byId.get(e.target.closest('tr').dataset.id);
    if (node) startInlineEdit(e.target, node, e.target.dataset.field);
  });

  $('#rows').addEventListener('change', e => {
    if (e.target.dataset.action !== 'status') return;
    const node = state.forest.byId.get(e.target.closest('tr').dataset.id);
    if (node) changeStatus(node, e.target.value);
  });

  $('#pw-toggle').addEventListener('click', () => {
    setPasswordVisible($('#pw-toggle').getAttribute('aria-pressed') !== 'true');
    $('#login-pw').focus();
  });

  $('#login-form').addEventListener('submit', guard(async e => {
    const form = e.target;
    const fd = new FormData(form);
    $('#login-info').hidden = true;
    setPasswordVisible(false);   // não deixa a senha à mostra (nem para o gerenciador de senhas)
    const { error } = await sb.auth.signInWithPassword({ email: fd.get('email'), password: fd.get('password') });
    showLoginError(error ? 'login.error' : null);
    if (!error) form.elements.password.value = '';   // não deixa a senha no campo escondido
  }));

  // Sempre a mesma resposta, exista o e-mail ou não (não revela quem tem conta)
  $('#forgot').addEventListener('click', async () => {
    const email = $('#login-form').elements.email.value.trim();
    $('#login-info').hidden = true;
    if (!email) { showLoginError('login.needEmail'); return; }
    showLoginError(null);
    // volta para esta mesma página; o endereço precisa estar em "Redirect URLs" do Supabase Auth
    await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
    $('#login-info').textContent = t('login.resetSent');
    $('#login-info').hidden = false;
  });

  document.querySelectorAll('.theme-select').forEach(sel => sel.addEventListener('change', e => {
    setTheme(e.target.value);
    document.querySelectorAll('.theme-select').forEach(s => { s.value = e.target.value; });
  }));

  document.querySelectorAll('.lang-select').forEach(sel => sel.addEventListener('change', e => {
    setLang(e.target.value);
    applyLanguage();
  }));

  $('#logout').addEventListener('click', () => sb.auth.signOut());
}

// ---------- tema ----------
const THEME_KEY = 'cajuca.theme';
function getTheme() {
  try { return localStorage.getItem(THEME_KEY) || 'auto'; } catch { return 'auto'; }
}
function setTheme(theme) {
  try {
    if (theme === 'auto') localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, theme);
  } catch { /* navegador sem armazenamento: vale só nesta visita */ }
  if (theme === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
}

// ---------- idioma ----------
function applyLanguage() {
  document.querySelectorAll('.theme-select').forEach(sel => {
    sel.innerHTML = ['auto', 'light', 'dark'].map(v => `<option value="${v}">${t('theme.' + v)}</option>`).join('');
    sel.value = getTheme();
  });
  applyStatic();
  document.querySelectorAll('.lang-select').forEach(sel => {
    sel.innerHTML = Object.entries(LANGS).map(([code, name]) => `<option value="${code}">${name}</option>`).join('');
    sel.value = getLang();
  });
  const err = $('#login-error');
  if (!err.hidden) err.textContent = t(err.dataset.key || 'login.error');
  buildShortcuts();
  render();
  if (drawer.open) renderDrawer();
}

// ---------- sessão ----------
let refreshTimer;
async function onSession(session) {
  // sessão caiu com um pop-up aberto: não deixa dados à vista sobre a tela de login
  if (dlg.open) dlg.close();
  if (drawer.open) drawer.close();
  closeMenu(false);
  $('#login').hidden = !!session;
  $('#app').hidden = !session;
  clearInterval(refreshTimer);
  // outro usuário: começa do zero (não mistura dados nem avisos)
  state.forest = { byId: new Map(), roots: [] };
  state.projects = []; state.projectOrder = []; state.members = []; state.users = [];
  state.pending = emptyPending();
  state.notified = new Set();
  state.openRoots = new Set();
  state.leaving.clear(); state.collapsed.clear(); state.expanded.clear();
  state.editing = false; state.dirty = false; state.loadError = false;
  state.userId = session?.user?.id ?? null;
  state.me = session?.user?.email ?? '';
  if (session) loadPrefs();
  else {
    state.filters = { main: freshFilters(), history: freshFilters() };
    state.sort = { main: null, history: null };
    state.collapsedProjects = new Set();
  }
  state.loading = !!session;
  render();
  if (!session) {
    setPasswordVisible(false);
    $('#login-form').elements.email.focus();
    return;
  }
  $('#user-email').textContent = session.user.email;
  await loadUsers({ force: true });
  await runAutomations();
  if (state.loading && state.userId === session.user.id) await loadTasks();   // a verificação não chegou a carregar
  refreshTimer = setInterval(runAutomations, REFRESH_MINUTES * 60 * 1000);
}

bindUi();
applyLanguage();
let lastUserId = '(início)';
sb.auth.onAuthStateChange((event, session) => {
  const id = session?.user?.id ?? null;
  const recovering = event === 'PASSWORD_RECOVERY';
  if (id === lastUserId && !recovering) return;      // ignora renovação de token
  const changed = id !== lastUserId;
  lastUserId = id;
  setTimeout(async () => {   // fora do callback, como recomenda o supabase-js
    if (recovering) await passwordDialog();   // antes da verificação de pendências, que espera o pop-up fechar
    if (changed) await onSession(session);
  }, 0);
});
window.__cajucaReady = true;   // js/boot.js: o app carregou, não mostra o aviso de falha

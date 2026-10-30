// Lógica pura (sem DOM): hierarquia, filtros e o que fica visível.
// Mantida separada da interface para poder ser testada isoladamente.

// ---------- datas (sempre no fuso de São Paulo, como no banco) ----------
export function todayISO() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
}

export function toLocalISO(timestamp) {
  return new Date(timestamp).toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
}

export function addDays(iso, n) {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Diferença em dias de calendário entre duas datas 'AAAA-MM-DD' (to - from).
// Conta pela data, não pelos milissegundos: não sofre com horário de verão nem com a hora do dia.
export function dayDiff(fromISO, toISO) {
  const utc = iso => { const [y, m, d] = iso.slice(0, 10).split('-').map(Number); return Date.UTC(y, m - 1, d); };
  return Math.round((utc(toISO) - utc(fromISO)) / 864e5);
}

// Último dia da semana de 'iso' (semana de segunda a domingo, como no Brasil)
export function endOfWeek(iso) {
  const day = new Date(iso + 'T12:00:00Z').getUTCDay();   // 0 = domingo
  return addDays(iso, (7 - day) % 7);
}

// ---------- hierarquia ----------
export function compareTasks(a, b) {
  if (a.priority !== b.priority) return a.priority ? -1 : 1;
  if (a.due_date !== b.due_date) {
    if (!a.due_date) return 1;
    if (!b.due_date) return -1;
    return a.due_date < b.due_date ? -1 : 1;
  }
  const ca = a.created_at || '', cb = b.created_at || '';
  return ca < cb ? -1 : ca > cb ? 1 : 0;
}

export function buildForest(tasks) {
  const byId = new Map(tasks.map(t => [t.id, { ...t, children: [] }]));
  const roots = [];

  for (const node of byId.values()) {
    const parent = node.parent_id && byId.get(node.parent_id);
    if (parent) parent.children.push(node);
    else roots.push(node);
  }

  const mark = (node, depth, parent) => {
    node.depth = depth;
    node.parent = parent;
    // pausa herdada: "Parado" nela ou em qualquer ancestral
    node.paused = node.blocking_status === 'stopped' || !!(parent && parent.paused);
    node.children.sort(compareTasks);
    node.children.forEach(c => mark(c, depth + 1, node));
  };
  roots.sort(compareTasks);
  roots.forEach(r => mark(r, 0, null));

  return { byId, roots };
}

export function descendants(node) {
  const out = [];
  const walk = n => n.children.forEach(c => { out.push(c); walk(c); });
  walk(node);
  return out;
}

export function ancestors(node) {
  const out = [];
  for (let p = node.parent; p; p = p.parent) out.unshift(p);
  return out;
}

export function rootOf(node) { let r = node; while (r.parent) r = r.parent; return r; }

// "Concluído" só vale sem filhas abertas (regra 8; o banco confere de novo)
export const hasOpenChildren = node => node.children.some(c => c.status !== 'done');

// Tela principal = árvores cuja raiz não está concluída.
// Histórico     = árvores inteiramente concluídas (raiz concluída implica
//                 todas as filhas concluídas, garantido pelo banco).
export function rootsFor(view, forest) {
  return forest.roots.filter(r => (view === 'history') === (r.status === 'done'));
}

// ---------- filtros ----------
// projects: ids marcados no filtro ('__none__' = sem projeto); vazio = todos
// mine: só as do usuário logado (ctx.me). quick: atalho de prazo/status (QUICK). q: busca por texto.
export const DEFAULT_FILTERS = Object.freeze({ priority: 'all', period: 'all', assignee: '', projects: [], mine: false, quick: '', q: '' });
export const NO_PROJECT = '__none__';
export const QUICK = ['overdue', 'today', 'week', 'in_progress'];
export const PERIOD_VALUES = { main: ['all', '7', '15', '30', 'none'], history: ['all', '7', '15', '30'] };

// cópia nova (o array de projetos não é compartilhado entre visões)
export const freshFilters = () => ({ ...DEFAULT_FILTERS, projects: [] });

// Filtros que valem tarefa a tarefa (o de projeto vale para a árvore inteira)
export function isRowFilterActive(f) {
  return f.priority !== 'all' || f.period !== 'all' || f.assignee !== ''
    || !!f.mine || !!f.quick || !!(f.q && f.q.trim());
}

export function isFilterActive(f) {
  return isRowFilterActive(f) || f.projects.length > 0;
}

// ---------- projetos ----------
// Só a raiz guarda o projeto; a árvore inteira pertence a ele.
export const projectKey = root => root.project_id || NO_PROJECT;

export function filterRootsByProject(roots, selected) {
  if (!selected.length) return roots;
  return roots.filter(r => selected.includes(projectKey(r)));
}

// Ordem dos projetos: a salva pelo usuário (order = ids) e, depois, os demais por nome.
export function sortProjects(projects, order = []) {
  const pos = new Map(order.map((id, i) => [id, i]));
  const at = p => pos.has(p.id) ? pos.get(p.id) : Infinity;
  return [...projects].sort((a, b) => (at(a) - at(b)) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

// Ordem completa dos grupos, incluindo "Sem projeto" (que vai por último se não tiver posição)
export function orderedKeys(projects, order = []) {
  const keys = sortProjects(projects, order).map(p => p.id);
  const i = order.indexOf(NO_PROJECT);
  if (i < 0) return [...keys, NO_PROJECT];
  const pos = new Map(order.map((id, j) => [id, j]));
  const at = keys.findIndex(k => (pos.has(k) ? pos.get(k) : Infinity) > i);
  keys.splice(at < 0 ? keys.length : at, 0, NO_PROJECT);
  return keys;
}

// Grupos na ordem de orderedKeys.
// includeEmpty: mostra também projetos cadastrados sem nenhuma árvore.
export function groupByProject(roots, projects, { selected = [], includeEmpty = false, order = [] } = {}) {
  const byKey = new Map();
  roots.forEach(r => {
    const k = projectKey(r);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(r);
  });

  const wanted = k => !selected.length || selected.includes(k);
  const byId = new Map(projects.map(p => [p.id, p]));

  // tarefas sem projeto (ou de um projeto que não existe mais)
  const orphans = [...byKey.entries()]
    .filter(([k]) => k === NO_PROJECT || !byId.has(k))
    .flatMap(([, rs]) => rs);

  const groups = [];
  for (const k of orderedKeys(projects, order)) {
    if (!wanted(k)) continue;
    if (k === NO_PROJECT) {
      if (orphans.length) groups.push({ key: NO_PROJECT, project: null, roots: orphans });
    } else if (includeEmpty || byKey.has(k)) {
      groups.push({ key: k, project: byId.get(k), roots: byKey.get(k) || [] });
    }
  }

  return groups;
}

// ---------- busca por texto ----------
// Sem acento e sem diferenciar maiúsculas: "Reunião" acha "reuniao" e vice-versa.
export function normalizeText(s) {
  return String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

// Cada palavra digitada precisa aparecer no título ou na observação (em qualquer ordem)
export function matchesText(node, q) {
  const words = normalizeText(q).split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = normalizeText(`${node.title ?? ''}\n${node.notes ?? ''}`);
  return words.every(w => hay.includes(w));
}

// ---------- atalhos (chips e painel de resumo) ----------
// "Hoje" e "Esta semana" contam só o que ainda vence (atrasadas têm atalho próprio).
export function matchesQuick(node, quick, today) {
  const open = node.status !== 'done';
  switch (quick) {
    case 'overdue': return node.status === 'overdue';
    case 'today': return open && node.due_date === today;
    case 'week': return open && !!node.due_date && node.due_date >= today && node.due_date <= endOfWeek(today);
    case 'in_progress': return node.status === 'in_progress';
    default: return true;
  }
}

// Contadores do painel de resumo: todas as tarefas (de qualquer nível) das árvores recebidas
export function summaryCounts(roots, today) {
  const c = Object.fromEntries(QUICK.map(k => [k, 0]));
  const walk = n => {
    for (const k of QUICK) if (matchesQuick(n, k, today)) c[k]++;
    n.children.forEach(walk);
  };
  roots.forEach(walk);
  return c;
}

// ctx.me: e-mail do usuário logado (filtro "Minhas tarefas")
export function matches(node, f, view, today, ctx = {}) {
  if (f.priority === 'yes' && !node.priority) return false;
  if (f.priority === 'no' && node.priority) return false;

  const who = node.assignees || [];
  if (f.assignee === '__none__') {
    if (who.length) return false;
  } else if (f.assignee && !who.some(w => w.toLowerCase() === f.assignee.toLowerCase())) {
    return false;   // o banco trata "Ana" e "ana" como a mesma pessoa
  }
  if (f.mine) {
    const me = String(ctx.me || '').toLowerCase();
    if (!me || !who.some(w => w.toLowerCase() === me)) return false;
  }
  if (f.quick && !matchesQuick(node, f.quick, today)) return false;
  if (f.q && !matchesText(node, f.q)) return false;

  if (f.period !== 'all') {
    if (view === 'history') {
      // histórico: conta a data de conclusão, para trás a partir de hoje
      const done = node.completed_at && toLocalISO(node.completed_at);
      if (!done || done < addDays(today, -Number(f.period))) return false;
    } else {
      // atrasadas continuam visíveis com qualquer filtro de prazo
      const overdue = node.status === 'overdue';
      if (f.period === 'none') {
        if (node.due_date && !overdue) return false;
      } else {
        const inRange = node.due_date
          && node.due_date >= today
          && node.due_date <= addDays(today, Number(f.period));
        if (!inRange && !overdue) return false;
      }
    }
  }
  return true;
}

// Conjunto visível = tarefas que batem com o filtro + todos os ancestrais.
export function computeVisible(roots, f, view, today, ctx = {}) {
  const visible = new Set();
  const walk = n => {
    if (matches(n, f, view, today, ctx)) {
      for (let x = n; x && !visible.has(x.id); x = x.parent) visible.add(x.id);
    }
    n.children.forEach(walk);
  };
  roots.forEach(walk);
  return visible;
}

// Linhas na ordem de exibição, já com profundidade preservada.
// collapsed: recolhidas pelo usuário. expanded: expandidas explicitamente
// (mostram todas as filhas mesmo que não batam com o filtro).
// compare: ordenação escolhida no cabeçalho (sortComparator); vale entre irmãs, a hierarquia fica.
export function flatten(roots, { filterActive, visible, collapsed, expanded, compare = null }) {
  const rows = [];
  const order = list => compare ? [...list].sort(compare) : list;
  const visit = node => {
    let shown;
    if (collapsed.has(node.id)) shown = [];
    else if (!filterActive || expanded.has(node.id)) shown = node.children;
    else shown = node.children.filter(c => visible.has(c.id));

    rows.push({ node, showingAll: shown.length === node.children.length });
    order(shown).forEach(visit);
  };
  order(roots.filter(r => !filterActive || visible.has(r.id))).forEach(visit);
  return rows;
}

// ---------- ordenação por coluna ----------
// sort = { key, dir } ou null (= ordem padrão: prioridade, depois prazo)
export const SORT_KEYS = ['title', 'priority', 'due_date', 'status'];
const STATUS_RANK = { overdue: 0, in_progress: 1, not_started: 2, done: 3 };

export function sortComparator(sort) {
  if (!sort || !SORT_KEYS.includes(sort.key)) return null;
  const sign = sort.dir === 'desc' ? -1 : 1;
  return (a, b) => {
    let r = 0;
    switch (sort.key) {
      case 'title':
        r = String(a.title ?? '').localeCompare(String(b.title ?? ''), undefined, { sensitivity: 'base', numeric: true });
        break;
      case 'priority': r = (b.priority ? 1 : 0) - (a.priority ? 1 : 0); break;   // crescente: prioritárias primeiro
      case 'status': r = (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9); break;
      case 'due_date':
        if (a.due_date !== b.due_date) {
          if (!a.due_date) return 1;    // sem prazo fica no fim nos dois sentidos
          if (!b.due_date) return -1;
          r = a.due_date < b.due_date ? -1 : 1;
        }
        break;
    }
    return r * sign || compareTasks(a, b);   // empate: ordem padrão
  };
}

// Clique no cabeçalho: sem ordenação -> crescente -> decrescente -> sem ordenação
export function nextSort(current, key) {
  if (!current || current.key !== key) return { key, dir: 'asc' };
  return current.dir === 'asc' ? { key, dir: 'desc' } : null;
}

// ---------- preferências salvas no navegador ----------
// O que vem do localStorage pode estar velho ou adulterado: só aceita valores conhecidos.
export function sanitizeFilters(raw, view) {
  const f = freshFilters();
  if (!raw || typeof raw !== 'object') return f;
  if (['all', 'yes', 'no'].includes(raw.priority)) f.priority = raw.priority;
  if ((PERIOD_VALUES[view] || []).includes(raw.period)) f.period = raw.period;
  if (typeof raw.assignee === 'string') f.assignee = raw.assignee.slice(0, 2000);
  if (Array.isArray(raw.projects)) f.projects = [...new Set(raw.projects.filter(p => typeof p === 'string' && p.length <= 100))].slice(0, 500);
  f.mine = raw.mine === true;
  if (view === 'main' && QUICK.includes(raw.quick)) f.quick = raw.quick;   // atalhos de prazo só na tela principal
  if (typeof raw.q === 'string') f.q = raw.q.slice(0, 200);
  return f;
}

export function sanitizeSort(raw) {
  return raw && SORT_KEYS.includes(raw.key) && (raw.dir === 'asc' || raw.dir === 'desc')
    ? { key: raw.key, dir: raw.dir } : null;
}

// ---------- mover tarefas (arrastar ou "Mover para…") ----------
// target: { project: chave } = vira tarefa principal desse projeto; { parent: nó } = vira subtarefa dele.
// ctx: canEditNode(nó), canEditProject(chave), ownsProject(chave) — o banco confere tudo de novo.
// Devolve null (pode mover) ou a chave i18n do motivo.
export function moveError(node, target, ctx) {
  if (!ctx.canEditNode(node)) return 'err.noPermission';
  const fromKey = projectKey(rootOf(node));
  let toKey;
  if (target.parent) {
    const p = target.parent;
    if (p.id === node.id || descendants(node).some(d => d.id === p.id)) return 'move.errCycle';
    if (node.parent && node.parent.id === p.id) return 'move.errSame';
    if (!ctx.canEditNode(p)) return 'err.noPermission';
    toKey = projectKey(rootOf(p));
  } else {
    toKey = target.project;
    if (!node.parent && fromKey === toKey) return 'move.errSame';
    if (!ctx.canEditProject(toKey)) return 'err.noPermission';
  }
  // migração 005/007: só o dono do projeto de origem tira a árvore dele
  if (fromKey !== toKey && fromKey !== NO_PROJECT && !ctx.ownsProject(fromKey)) return 'err.projectMove';
  return null;
}

// Colunas alteradas no banco. Ao virar subtarefa, o trigger copia projeto e dono da mãe.
export function movePatch(target) {
  return target.parent
    ? { parent_id: target.parent.id }
    : { parent_id: null, project_id: target.project === NO_PROJECT ? null : target.project };
}

// Clique na setinha: se mostra tudo, recolhe; senão, expande tudo.
export function toggleNode(id, showingAll, collapsed, expanded) {
  if (showingAll && !collapsed.has(id)) {
    collapsed.add(id);
    expanded.delete(id);
  } else {
    collapsed.delete(id);
    expanded.add(id);
  }
}

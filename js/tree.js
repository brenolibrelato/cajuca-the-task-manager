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

// ---------- hierarquia ----------
function compareTasks(a, b) {
  if (a.priority !== b.priority) return a.priority ? -1 : 1;
  if (a.due_date !== b.due_date) {
    if (!a.due_date) return 1;
    if (!b.due_date) return -1;
    return a.due_date < b.due_date ? -1 : 1;
  }
  return (a.created_at || '') < (b.created_at || '') ? -1 : 1;
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

// Tela principal = árvores cuja raiz não está concluída.
// Histórico     = árvores inteiramente concluídas (raiz concluída implica
//                 todas as filhas concluídas, garantido pelo banco).
export function rootsFor(view, forest) {
  return forest.roots.filter(r => (view === 'history') === (r.status === 'done'));
}

// ---------- filtros ----------
export const DEFAULT_FILTERS = { priority: 'all', period: 'all', assignee: '' };

export function isFilterActive(f) {
  return f.priority !== 'all' || f.period !== 'all' || f.assignee !== '';
}

export function matches(node, f, view, today) {
  if (f.priority === 'yes' && !node.priority) return false;
  if (f.priority === 'no' && node.priority) return false;

  if (f.assignee === '__none__') {
    if (node.assignee_email) return false;
  } else if (f.assignee && node.assignee_email !== f.assignee) {
    return false;
  }

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
export function computeVisible(roots, f, view, today) {
  const visible = new Set();
  const walk = n => {
    if (matches(n, f, view, today)) {
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
export function flatten(roots, { filterActive, visible, collapsed, expanded }) {
  const rows = [];
  const visit = node => {
    let shown;
    if (collapsed.has(node.id)) shown = [];
    else if (!filterActive || expanded.has(node.id)) shown = node.children;
    else shown = node.children.filter(c => visible.has(c.id));

    rows.push({ node, showingAll: shown.length === node.children.length });
    shown.forEach(visit);
  };
  roots.filter(r => !filterActive || visible.has(r.id)).forEach(visit);
  return rows;
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

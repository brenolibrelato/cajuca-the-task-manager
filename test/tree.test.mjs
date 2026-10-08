import assert from 'node:assert/strict';
import {
  buildForest, rootsFor, computeVisible, flatten, toggleNode, todayISO, addDays,
  DEFAULT_FILTERS, isFilterActive,
} from '../js/tree.js';

const today = todayISO();
const t = (id, parent_id, extra = {}) => ({
  id, parent_id, title: id, priority: false, due_date: null, status: 'not_started',
  assignee_email: null, completed_at: null, blocking_status: null, created_at: id, ...extra,
});

const tasks = [
  t('P', null),                                                   // projeto
  t('P.1', 'P', { due_date: addDays(today, 3), assignee_email: 'ana@x.com' }),
  t('P.1.a', 'P.1', { due_date: addDays(today, 40) }),
  t('P.2', 'P', { due_date: addDays(today, 20), priority: true }),
  t('P.2.a', 'P.2', { due_date: addDays(today, -2), status: 'overdue' }),
  t('P.3', 'P', { status: 'done', completed_at: new Date().toISOString() }),
  t('S', null, { blocking_status: 'stopped' }),
  t('S.1', 'S'),
  t('S.1.a', 'S.1'),
  t('H', null, { status: 'done', completed_at: new Date(Date.now() - 10 * 864e5).toISOString() }),
  t('H.1', 'H', { status: 'done', completed_at: new Date(Date.now() - 12 * 864e5).toISOString() }),
];

const forest = buildForest(tasks);
const ids = rows => rows.map(r => r.node.id);
const view = (v, f, collapsed = new Set(), expanded = new Set()) => {
  const roots = rootsFor(v, forest);
  const fa = isFilterActive(f);
  const visible = computeVisible(roots, f, v, today);
  return flatten(roots, { filterActive: fa, visible, collapsed, expanded });
};

// hierarquia e profundidade
assert.equal(forest.byId.get('P.1.a').depth, 2);
// pausa herdada
assert.equal(forest.byId.get('S.1.a').paused, true);
assert.equal(forest.byId.get('P.1').paused, false);

// sem filtro: tudo da tela principal, histórico separado, concluída parcial fica (regra 6)
assert.deepEqual(ids(view('main', DEFAULT_FILTERS)),
  ['P', 'P.2', 'P.2.a', 'P.1', 'P.1.a', 'P.3', 'S', 'S.1', 'S.1.a']);
assert.deepEqual(ids(view('history', DEFAULT_FILTERS)), ['H', 'H.1']);

// prazo 7 dias: P.1 bate, atrasada P.2.a permanece, ancestrais aparecem, P.1.a (40d) some
const f7 = { ...DEFAULT_FILTERS, period: '7' };
assert.deepEqual(ids(view('main', f7)), ['P', 'P.2', 'P.2.a', 'P.1']);

// expandir P.1 explicitamente mostra a descendente que não bate
assert.deepEqual(ids(view('main', f7, new Set(), new Set(['P.1']))), ['P', 'P.2', 'P.2.a', 'P.1', 'P.1.a']);

// AND: prazo 7 + responsável ana -> só P.1 (e ancestral); atrasada sem ana não aparece
const fAnd = { ...DEFAULT_FILTERS, period: '7', assignee: 'ana@x.com' };
assert.deepEqual(ids(view('main', fAnd)), ['P', 'P.1']);

// prioridade
assert.deepEqual(ids(view('main', { ...DEFAULT_FILTERS, priority: 'yes' })), ['P', 'P.2']);

// sem prazo: tarefas sem data + atrasadas
assert.deepEqual(ids(view('main', { ...DEFAULT_FILTERS, period: 'none' })),
  ['P', 'P.2', 'P.2.a', 'P.3', 'S', 'S.1', 'S.1.a']);

// histórico por data de conclusão: 7 dias vazio, 15 dias pega H; 30 pega ambos
assert.deepEqual(ids(view('history', { ...DEFAULT_FILTERS, period: '7' })), []);
assert.deepEqual(ids(view('history', { ...DEFAULT_FILTERS, period: '15' })), ['H', 'H.1']);

// recolher / expandir
const col = new Set(), exp = new Set();
toggleNode('P', true, col, exp);
assert.deepEqual(ids(view('main', DEFAULT_FILTERS, col, exp)), ['P', 'S', 'S.1', 'S.1.a']);
toggleNode('P', false, col, exp);
assert.equal(ids(view('main', DEFAULT_FILTERS, col, exp)).length, 9);

console.log('tree.js: todos os testes passaram');

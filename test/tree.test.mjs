import assert from 'node:assert/strict';
import {
  buildForest, rootsFor, computeVisible, flatten, toggleNode, todayISO, addDays,
  DEFAULT_FILTERS, isFilterActive, isRowFilterActive, groupByProject, filterRootsByProject, NO_PROJECT, matches,
  dayDiff, endOfWeek, normalizeText, matchesText, summaryCounts, sortComparator, nextSort,
  sanitizeFilters, sanitizeSort, freshFilters, moveError, movePatch, projectKey, rootOf, hasOpenChildren,
} from '../js/tree.js';

const today = todayISO();
const t = (id, parent_id, extra = {}) => ({
  id, parent_id, title: id, priority: false, due_date: null, status: 'not_started',
  assignees: [], completed_at: null, blocking_status: null, created_at: id, ...extra,
});

const tasks = [
  t('P', null),                                                   // projeto
  t('P.1', 'P', { due_date: addDays(today, 3), assignees: ['ana@x.com', 'Carlos'] }),
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

// vários responsáveis: qualquer um deles bate; "sem responsável" pega lista vazia
assert.deepEqual(ids(view('main', { ...DEFAULT_FILTERS, assignee: 'Carlos' })), ['P', 'P.1']);
assert.deepEqual(ids(view('main', { ...DEFAULT_FILTERS, assignee: 'carlos' })), ['P', 'P.1']);   // sem diferenciar maiúsculas
assert.equal(matches(forest.byId.get('P.1'), { ...DEFAULT_FILTERS, assignee: '__none__' }, 'main', today), false);
assert.equal(matches(forest.byId.get('P.1.a'), { ...DEFAULT_FILTERS, assignee: '__none__' }, 'main', today), true);

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

// ---------- projetos ----------
const projects = [{ id: 'gab', name: 'Tarefas Gabriele' }, { id: 'let', name: 'Tarefas Leticia' }, { id: 'lau', name: 'Tarefas Laura' }];
const pf = buildForest([
  t('A', null, { project_id: 'let' }), t('A.1', 'A'),
  t('B', null, { project_id: 'gab' }),
  t('C', null),                                   // sem projeto
  t('D', null, { project_id: 'apagado' }),        // projeto que não existe mais
]);
const keys = gs => gs.map(g => `${g.key}:${g.roots.map(r => r.id).join(',')}`);

// ordem por nome; vazios só com includeEmpty; "Sem projeto" por último (inclui órfãos)
assert.deepEqual(keys(groupByProject(pf.roots, projects)), ['gab:B', 'let:A', `${NO_PROJECT}:C,D`]);
assert.deepEqual(keys(groupByProject(pf.roots, projects, { includeEmpty: true })),
  ['gab:B', 'lau:', 'let:A', `${NO_PROJECT}:C,D`]);

// ordem salva pelo usuário (arrastar e soltar); quem não tem posição vai depois, por nome
assert.deepEqual(keys(groupByProject(pf.roots, projects, { includeEmpty: true, order: ['let', 'lau'] })),
  ['let:A', 'lau:', 'gab:B', `${NO_PROJECT}:C,D`]);
assert.deepEqual(keys(groupByProject(pf.roots, projects, { includeEmpty: true, order: ['lau'] })),
  ['lau:', 'gab:B', 'let:A', `${NO_PROJECT}:C,D`]);
// "Sem projeto" também pode ser posicionado
assert.deepEqual(keys(groupByProject(pf.roots, projects, { includeEmpty: true, order: [NO_PROJECT, 'let'] })),
  [`${NO_PROJECT}:C,D`, 'let:A', 'gab:B', 'lau:']);
assert.deepEqual(keys(groupByProject(pf.roots, projects, { includeEmpty: true, order: ['lau', NO_PROJECT] })),
  ['lau:', `${NO_PROJECT}:C,D`, 'gab:B', 'let:A']);

// checkbox: mais de um projeto; árvore inteira acompanha a raiz
const sel = ['let', NO_PROJECT];
assert.deepEqual(filterRootsByProject(pf.roots, sel).map(r => r.id), ['A', 'C']);
assert.deepEqual(keys(groupByProject(filterRootsByProject(pf.roots, sel), projects, { selected: sel, includeEmpty: true })),
  ['let:A', `${NO_PROJECT}:C`]);

// filtro de projeto conta para "limpar filtros", mas não esconde filhas
assert.equal(isFilterActive({ ...DEFAULT_FILTERS, projects: ['gab'] }), true);
assert.equal(isRowFilterActive({ ...DEFAULT_FILTERS, projects: ['gab'] }), false);
assert.equal(isFilterActive(DEFAULT_FILTERS), false);

// ---------- datas relativas e semana ----------
assert.equal(dayDiff('2026-10-30', '2026-10-30'), 0);
assert.equal(dayDiff('2026-10-30', '2026-11-02'), 3);
assert.equal(dayDiff('2026-10-30', '2026-10-27'), -3);
assert.equal(dayDiff('2026-12-31', '2027-01-01'), 1);              // virada de ano
assert.equal(dayDiff('2024-02-28', '2024-03-01'), 2);              // ano bissexto
assert.equal(dayDiff('2026-02-14', '2026-02-23'), 9);              // período que já teve horário de verão
assert.equal(endOfWeek('2026-10-30'), '2026-11-01');               // sexta -> domingo
assert.equal(endOfWeek('2026-11-01'), '2026-11-01');               // domingo é o fim
assert.equal(endOfWeek('2026-10-26'), '2026-11-01');               // segunda

// ---------- busca por texto ----------
assert.equal(normalizeText('Reunião ÀÉÎÕÜ ç'), 'reuniao aeiou c');
const sForest = buildForest([
  t('R', null, { title: 'Reunião de equipe', notes: 'Levar o orçamento' }),
  t('R.1', 'R', { title: 'Preparar slides' }),
  t('X', null, { title: 'Outra coisa' }),
]);
const fq = q => ({ ...DEFAULT_FILTERS, q });
assert.equal(matchesText(sForest.byId.get('R'), 'reuniao'), true);
assert.equal(matchesText(sForest.byId.get('R'), 'ORÇAMENTO'), true);          // observação também conta
assert.equal(matchesText(sForest.byId.get('R'), 'equipe orcamento'), true);   // todas as palavras, em qualquer ordem
assert.equal(matchesText(sForest.byId.get('R'), 'equipe zebra'), false);
assert.equal(matchesText(sForest.byId.get('R'), '   '), true);
assert.equal(isRowFilterActive(fq('  ')), false);
assert.equal(isRowFilterActive(fq('slides')), true);
// filha bate: a mãe continua visível como caminho
const sv = computeVisible(sForest.roots, fq('slides'), 'main', today);
assert.deepEqual([...sv].sort(), ['R', 'R.1']);

// ---------- atalhos: minhas, atrasadas, hoje, esta semana, em andamento ----------
const T = '2026-10-28';             // quarta-feira fixa: o teste não depende do dia em que roda
const eow = endOfWeek(T);
const qForest = buildForest([
  t('Q', null, { assignees: ['Eu@x.com'] }),
  t('Q.late', 'Q', { status: 'overdue', due_date: addDays(T, -1) }),
  t('Q.today', 'Q', { due_date: T, assignees: ['eu@x.com'] }),
  t('Q.week', 'Q', { due_date: eow, status: 'in_progress' }),
  t('Q.next', 'Q', { due_date: addDays(eow, 1) }),
  t('Q.doneToday', 'Q', { due_date: T, status: 'done', completed_at: new Date().toISOString() }),
]);
const vis = (f, ctx) => [...computeVisible(qForest.roots, f, 'main', T, ctx)].sort();
assert.deepEqual(vis({ ...DEFAULT_FILTERS, quick: 'overdue' }), ['Q', 'Q.late']);
assert.deepEqual(vis({ ...DEFAULT_FILTERS, quick: 'today' }), ['Q', 'Q.today']);   // concluída de hoje não conta
assert.ok(vis({ ...DEFAULT_FILTERS, quick: 'week' }).includes('Q.week'));
assert.ok(!vis({ ...DEFAULT_FILTERS, quick: 'week' }).includes('Q.next'));
assert.ok(vis({ ...DEFAULT_FILTERS, quick: 'week' }).includes('Q.today'));          // hoje faz parte da semana
assert.deepEqual(vis({ ...DEFAULT_FILTERS, quick: 'in_progress' }), ['Q', 'Q.week']);
// "minhas": e-mail sem diferenciar maiúsculas; sem e-mail conhecido, nada bate
assert.deepEqual(vis({ ...DEFAULT_FILTERS, mine: true }, { me: 'EU@x.com' }), ['Q', 'Q.today']);
assert.deepEqual(vis({ ...DEFAULT_FILTERS, mine: true }, {}), []);
// combinam com os outros filtros (E)
assert.deepEqual(vis({ ...DEFAULT_FILTERS, mine: true, quick: 'today' }, { me: 'eu@x.com' }), ['Q', 'Q.today']);
assert.deepEqual(vis({ ...DEFAULT_FILTERS, mine: true, quick: 'overdue' }, { me: 'eu@x.com' }), []);
assert.equal(isRowFilterActive({ ...DEFAULT_FILTERS, mine: true }), true);
assert.equal(isRowFilterActive({ ...DEFAULT_FILTERS, quick: 'today' }), true);

// painel de resumo: conta todos os níveis
const sc = summaryCounts(qForest.roots, T);
assert.equal(sc.overdue, 1);
assert.equal(sc.today, 1);
assert.equal(sc.in_progress, 1);
assert.equal(eow, '2026-11-01');
assert.equal(sc.week, 2);   // Q.today e Q.week (Q.next fica para a semana que vem)
assert.deepEqual(summaryCounts([], T), { overdue: 0, today: 0, week: 0, in_progress: 0 });

// ---------- ordenação por coluna ----------
const oForest = buildForest([
  t('M', null, { title: 'mãe' }),
  t('b', 'M', { title: 'Beta', due_date: '2026-01-10', status: 'in_progress' }),
  t('a', 'M', { title: 'alfa', due_date: null, status: 'overdue', priority: true }),
  t('c', 'M', { title: 'Gama 10', due_date: '2026-01-05', status: 'done' }),
  t('d', 'M', { title: 'Gama 9', due_date: '2026-01-07', status: 'not_started' }),
  t('N', null, { title: 'Ana' }),
]);
const sorted = sort => ids(flatten(oForest.roots, {
  filterActive: false, visible: new Set(), collapsed: new Set(), expanded: new Set(), compare: sortComparator(sort),
}));
// sem ordenação: ordem padrão (prioridade, depois prazo)
assert.deepEqual(sorted(null), ['M', 'a', 'c', 'd', 'b', 'N']);
// título: sem diferenciar maiúsculas, números em ordem natural; raízes também ordenam; hierarquia mantida
assert.deepEqual(sorted({ key: 'title', dir: 'asc' }), ['N', 'M', 'a', 'b', 'd', 'c']);
assert.deepEqual(sorted({ key: 'title', dir: 'desc' }), ['M', 'c', 'd', 'b', 'a', 'N']);
// prazo: sem prazo sempre no fim
assert.deepEqual(sorted({ key: 'due_date', dir: 'asc' }), ['M', 'c', 'd', 'b', 'a', 'N']);
assert.deepEqual(sorted({ key: 'due_date', dir: 'desc' }), ['M', 'b', 'd', 'c', 'a', 'N']);
// status: atrasado, em andamento, não iniciado, concluído
assert.deepEqual(sorted({ key: 'status', dir: 'asc' }), ['M', 'a', 'b', 'd', 'c', 'N']);
// prioridade: crescente = prioritárias primeiro
assert.deepEqual(sorted({ key: 'priority', dir: 'asc' }).slice(0, 2), ['M', 'a']);
assert.equal(sorted({ key: 'priority', dir: 'desc' })[4], 'a');
assert.equal(sortComparator({ key: 'hack', dir: 'asc' }), null);
// clique no cabeçalho: crescente -> decrescente -> sem ordenação
assert.deepEqual(nextSort(null, 'title'), { key: 'title', dir: 'asc' });
assert.deepEqual(nextSort({ key: 'title', dir: 'asc' }, 'title'), { key: 'title', dir: 'desc' });
assert.equal(nextSort({ key: 'title', dir: 'desc' }, 'title'), null);
assert.deepEqual(nextSort({ key: 'title', dir: 'desc' }, 'status'), { key: 'status', dir: 'asc' });

// ---------- preferências lidas do navegador ----------
assert.deepEqual(sanitizeFilters(null, 'main'), freshFilters());
assert.deepEqual(sanitizeFilters('lixo', 'main'), freshFilters());
const sf = sanitizeFilters({ priority: 'yes', period: 'none', assignee: 'ana', projects: ['p1', 'p1', 5, NO_PROJECT], mine: true, quick: 'week', q: 'x', extra: 1 }, 'main');
assert.deepEqual(sf, { priority: 'yes', period: 'none', assignee: 'ana', projects: ['p1', NO_PROJECT], mine: true, quick: 'week', q: 'x' });
const sh = sanitizeFilters({ priority: 'talvez', period: 'none', quick: 'week', mine: 'sim' }, 'history');
assert.equal(sh.priority, 'all');
assert.equal(sh.period, 'all');     // "sem prazo" não existe no histórico
assert.equal(sh.quick, '');         // atalhos de prazo só na tela principal
assert.equal(sh.mine, false);
assert.equal(sanitizeFilters({ q: 'a'.repeat(500) }, 'main').q.length, 200);
assert.deepEqual(sanitizeSort({ key: 'due_date', dir: 'desc' }), { key: 'due_date', dir: 'desc' });
assert.equal(sanitizeSort({ key: 'due_date', dir: 'up' }), null);
assert.equal(sanitizeSort({ key: 'owner_id', dir: 'asc' }), null);
// freshFilters não compartilha o array de projetos
const f1 = freshFilters(); f1.projects.push('x');
assert.deepEqual(freshFilters().projects, []);

// ---------- mover tarefas ----------
const mForest = buildForest([
  t('A', null, { project_id: 'meu' }), t('A.1', 'A'), t('A.1.x', 'A.1'),
  t('B', null, { project_id: 'meu' }),
  t('C', null, { project_id: 'alheio' }), t('C.1', 'C'),   // projeto de outra pessoa em que sou editor
  t('V', null, { project_id: 'leitura' }),                 // só visualização
  t('L', null),                                            // sem projeto
]);
const n = id => mForest.byId.get(id);
const editable = new Set(['meu', 'alheio', NO_PROJECT]);
const ctx = {
  canEditNode: x => editable.has(projectKey(rootOf(x))),
  canEditProject: k => editable.has(k),
  ownsProject: k => k === 'meu' || k === NO_PROJECT,
};
// vira subtarefa de outra árvore do mesmo projeto
assert.equal(moveError(n('B'), { parent: n('A.1') }, ctx), null);
assert.deepEqual(movePatch({ parent: n('A.1') }), { parent_id: 'A.1' });
// ciclos: em si mesma ou numa descendente
assert.equal(moveError(n('A'), { parent: n('A') }, ctx), 'move.errCycle');
assert.equal(moveError(n('A'), { parent: n('A.1.x') }, ctx), 'move.errCycle');
// já está lá
assert.equal(moveError(n('A.1'), { parent: n('A') }, ctx), 'move.errSame');
assert.equal(moveError(n('A'), { project: 'meu' }, ctx), 'move.errSame');
// subtarefa vira tarefa principal (mesmo projeto ou outro)
assert.equal(moveError(n('A.1'), { project: 'meu' }, ctx), null);
assert.deepEqual(movePatch({ project: 'meu' }), { parent_id: null, project_id: 'meu' });
assert.deepEqual(movePatch({ project: NO_PROJECT }), { parent_id: null, project_id: null });
// só leitura: nem origem nem destino
assert.equal(moveError(n('V'), { project: 'meu' }, ctx), 'err.noPermission');
assert.equal(moveError(n('B'), { parent: n('V') }, ctx), 'err.noPermission');
assert.equal(moveError(n('B'), { project: 'leitura' }, ctx), 'err.noPermission');
// editor (não dono) não tira árvore do projeto alheio, nem por parent_id
assert.equal(moveError(n('C'), { project: 'meu' }, ctx), 'err.projectMove');
assert.equal(moveError(n('C'), { parent: n('L') }, ctx), 'err.projectMove');
assert.equal(moveError(n('C.1'), { project: NO_PROJECT }, ctx), 'err.projectMove');
// ...mas reorganiza dentro dele
assert.equal(moveError(n('C.1'), { project: 'alheio' }, ctx), null);
// sem projeto (minha) entra em projeto que edito
assert.equal(moveError(n('L'), { parent: n('C.1') }, ctx), null);
assert.equal(moveError(n('L'), { project: 'meu' }, ctx), null);

// "Concluído" bloqueado com filhas abertas
assert.equal(hasOpenChildren(n('A')), true);
assert.equal(hasOpenChildren(n('A.1.x')), false);
assert.equal(hasOpenChildren(forest.byId.get('H')), false);

console.log('tree.js: todos os testes passaram');

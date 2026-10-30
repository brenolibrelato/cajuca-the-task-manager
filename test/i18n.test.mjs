import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DICT, translateError, fmtRelative, getLang, setLang } from '../js/i18n.js';

// pt e en têm exatamente as mesmas chaves
const pt = Object.keys(DICT.pt).sort();
const en = Object.keys(DICT.en).sort();
assert.deepEqual(pt.filter(k => !(k in DICT.en)), [], 'chaves só em pt');
assert.deepEqual(en.filter(k => !(k in DICT.pt)), [], 'chaves só em en');

// nenhum texto vazio
for (const lang of ['pt', 'en']) {
  for (const [k, v] of Object.entries(DICT[lang])) assert.ok(v.trim(), `${lang}: "${k}" está vazio`);
}

// chaves usadas literalmente no código existem (as montadas em tempo de execução,
// como 'status.' + s, são cobertas pelo teste de prefixos abaixo)
const src = ['../js/app.js', '../index.html'].map(f => readFileSync(new URL(f, import.meta.url), 'utf8')).join('\n');
const used = [...src.matchAll(/\bt\('([\w.]+)'/g), ...src.matchAll(/data-i18n(?:-aria|-title|-placeholder)?="([\w.]+)"/g)].map(m => m[1]).filter(k => !k.endsWith('.'));   // 't("status." + s)' é montada na hora
assert.deepEqual([...new Set(used)].filter(k => !(k in DICT.pt)), [], 'chaves usadas no código e ausentes do dicionário');

// motivos devolvidos por moveError (tree.js) viram t(motivo) na tela
const treeSrc = readFileSync(new URL('../js/tree.js', import.meta.url), 'utf8');
const reasons = [...treeSrc.matchAll(/return '((?:move|err)\.[\w.]+)'/g)].map(m => m[1]);
assert.ok(reasons.length >= 4);
assert.deepEqual(reasons.filter(k => !(k in DICT.pt)), [], 'motivos de moveError sem tradução');

for (const [prefix, values] of Object.entries({
  'status.': ['not_started', 'in_progress', 'overdue', 'done'],
  'situation.': ['in_progress', 'waiting_others', 'stopped', 'other'],
  'theme.': ['auto', 'light', 'dark'],
  'quick.': ['overdue', 'today', 'week', 'in_progress'],
  'sum.': ['overdue', 'today', 'week', 'in_progress'],
  'pending.kind.': ['overdue', 'inactivity', 'reminder'],
})) {
  for (const v of values) assert.ok(prefix + v in DICT.pt, `falta ${prefix}${v}`);
}

// mensagens do banco viram texto traduzido
assert.equal(translateError('Não é possível concluir: esta tarefa ainda tem subtarefas abertas'), DICT.pt['err.openChildren']);
assert.equal(translateError('Sem permissão para alterar o projeto desta tarefa'), DICT.pt['err.projectMove']);
assert.equal(translateError('new row violates check constraint "chk_assignees_len"'), DICT.pt['err.assigneesLen']);
assert.equal(translateError(undefined), DICT.pt['err.generic']);
assert.equal(translateError('mensagem desconhecida'), 'mensagem desconhecida');
assert.equal(translateError('Sem permissão para alterar esta tarefa'), DICT.pt['err.noPermission']);

// "Parado" padronizado: nada de "pausa"/"paralisação" nos textos em português
for (const [k, v] of Object.entries(DICT.pt)) assert.ok(!/paus|paralis/i.test(v), `pt: "${k}" ainda fala em pausa`);

// prazos relativos (dias de calendário)
assert.equal(getLang(), 'pt');   // Node sem navigator: português
assert.equal(fmtRelative(0), 'hoje');
assert.equal(fmtRelative(1), 'amanhã');
assert.equal(fmtRelative(-1), 'ontem');
assert.equal(fmtRelative(3), 'em 3 dias');
assert.equal(fmtRelative(-3), 'há 3 dias');
try {
  globalThis.document = { documentElement: {} };   // setLang mexe no <html lang>
  setLang('en');
  assert.equal(fmtRelative(3), 'in 3 days');
  assert.equal(fmtRelative(-3), '3 days ago');
  assert.equal(fmtRelative(1), 'tomorrow');
} finally {
  setLang('pt');
  delete globalThis.document;
}

console.log('i18n.js: todos os testes passaram');

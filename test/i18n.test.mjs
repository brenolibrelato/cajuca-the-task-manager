import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DICT, translateError } from '../js/i18n.js';

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
const used = [...src.matchAll(/\bt\('([\w.]+)'/g), ...src.matchAll(/data-i18n(?:-aria)?="([\w.]+)"/g)].map(m => m[1]).filter(k => !k.endsWith('.'));   // 't("status." + s)' é montada na hora
assert.deepEqual([...new Set(used)].filter(k => !(k in DICT.pt)), [], 'chaves usadas no código e ausentes do dicionário');

for (const [prefix, values] of Object.entries({
  'status.': ['not_started', 'in_progress', 'overdue', 'done'],
  'situation.': ['in_progress', 'waiting_others', 'stopped', 'other'],
  'theme.': ['auto', 'light', 'dark'],
})) {
  for (const v of values) assert.ok(prefix + v in DICT.pt, `falta ${prefix}${v}`);
}

// mensagens do banco viram texto traduzido
assert.equal(translateError('Não é possível concluir: esta tarefa ainda tem subtarefas abertas'), DICT.pt['err.openChildren']);
assert.equal(translateError('Sem permissão para alterar o projeto desta tarefa'), DICT.pt['err.projectMove']);
assert.equal(translateError('new row violates check constraint "chk_assignees_len"'), DICT.pt['err.assigneesLen']);
assert.equal(translateError(undefined), DICT.pt['err.generic']);
assert.equal(translateError('mensagem desconhecida'), 'mensagem desconhecida');

console.log('i18n.js: todos os testes passaram');

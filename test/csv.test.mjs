import assert from 'node:assert/strict';
import { csvCell, toCSV } from '../js/csv.js';

// aspas sempre; aspas internas dobradas
assert.equal(csvCell('texto'), '"texto"');
assert.equal(csvCell('diz "oi"'), '"diz ""oi"""');
assert.equal(csvCell(null), '""');
assert.equal(csvCell(undefined), '""');
assert.equal(csvCell(3), '"3"');
assert.equal(csvCell('a;b\nc'), '"a;b\nc"');   // separador e quebra de linha ficam dentro das aspas

// injeção de fórmula: = + - @ tab CR ganham apóstrofo
assert.equal(csvCell('=HYPERLINK("http://x","clique")'), '"\'=HYPERLINK(""http://x"",""clique"")"');
assert.equal(csvCell('+1'), '"\'+1"');
assert.equal(csvCell('-2+3'), '"\'-2+3"');
assert.equal(csvCell('@SUM(A1)'), '"\'@SUM(A1)"');
assert.equal(csvCell('\tx'), '"\'\tx"');
assert.equal(csvCell('\rx'), '"\'\rx"');
assert.equal(csvCell('a=b'), '"a=b"');          // só o começo conta
assert.equal(csvCell(' =1'), '" =1"');

// arquivo: BOM UTF-8, ';' e CRLF
const out = toCSV([['Projeto', 'Título'], ['Ação', '=1+1']]);
assert.equal(out.charCodeAt(0), 0xFEFF);
assert.equal(out, '﻿"Projeto";"Título"\r\n"Ação";"\'=1+1"\r\n');
assert.equal(new TextEncoder().encode(out).slice(0, 3).join(), '239,187,191');

console.log('csv.js: todos os testes passaram');

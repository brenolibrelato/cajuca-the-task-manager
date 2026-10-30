// Exportação CSV (lógica pura, sem DOM): pensada para abrir direto no Excel em português.
//  * BOM UTF-8 no início: sem ele o Excel lê os acentos errado.
//  * Separador ';' (o Excel pt-BR usa ',' como separador decimal).
//  * Toda célula vai entre aspas; aspas internas viram "".
//  * Proteção contra injeção de fórmula (CSV injection): célula que começa com
//    = + - @ tab ou CR ganha um apóstrofo na frente, para o Excel tratar como texto.

const FORMULA_START = /^[=+\-@\t\r]/;

export function csvCell(value) {
  let s = value == null ? '' : String(value);
  if (FORMULA_START.test(s)) s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
}

// rows: lista de linhas, cada uma uma lista de valores
export function toCSV(rows, sep = ';') {
  return '﻿' + rows.map(r => r.map(csvCell).join(sep)).join('\r\n') + '\r\n';
}

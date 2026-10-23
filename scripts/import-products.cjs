#!/usr/bin/env node
// Uso: node scripts/import-products.cjs <informe.txt> [productos.js]
// Importa únicamente código y descripción del informe de ancho fijo.
// Las descripciones pueden estar truncadas en el original: no se completan.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { TextDecoder } = require('node:util');

function checkDigitMatches(ean) {
  let sum = 0;
  for (let index = ean.length - 2, weight = 3; index >= 0; index -= 1, weight = 4 - weight) {
    sum += Number(ean[index]) * weight;
  }
  return (10 - (sum % 10)) % 10 === Number(ean[ean.length - 1]);
}

function importReport(inputPath, outputPath) {
  const bytes = fs.readFileSync(inputPath);
  // ASCII es un subconjunto de UTF-8. Rechaza codificaciones ambiguas.
  const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (!source.includes('Codigo EAN') || !source.includes('Descripcion')) {
    throw new Error('No se encontró la cabecera del informe de productos.');
  }

  const products = new Map();
  const lengths = {};
  const checksum = { valid: 0, invalid: [], otherLengths: 0 };
  let rows = 0;
  let duplicates = 0;

  source.split(/\r?\n/).forEach((line, index) => {
    if (!/^\s*\d/.test(line)) return;
    const ean = line.slice(0, 18).trim();
    const descripcion = line.slice(18, 59).trim();
    const unit = line.slice(59, 62).trim();
    if (line.length !== 130 || !/^\d+$/.test(ean) || !descripcion || !/^[A-Z0-9]{2,3}$/.test(unit)) {
      throw new Error(`Fila de producto inesperada en la línea ${index + 1}.`);
    }
    rows += 1;
    lengths[ean.length] = (lengths[ean.length] || 0) + 1;

    // El dígito verificador es informativo; no excluye códigos del catálogo.
    if ([8, 12, 13, 14].includes(ean.length)) {
      if (checkDigitMatches(ean)) checksum.valid += 1;
      else checksum.invalid.push({ ean, line: index + 1 });
    } else {
      checksum.otherLengths += 1;
    }

    if (products.has(ean)) {
      if (products.get(ean).descripcion !== descripcion) {
        throw new Error(`El código ${ean} tiene descripciones distintas (línea ${index + 1}).`);
      }
      duplicates += 1;
      return;
    }
    products.set(ean, { ean, descripcion });
  });

  if (!products.size) throw new Error('El informe no contiene productos.');
  const catalog = Array.from(products.values());
  const output = [
    '// Generado con scripts/import-products.cjs; no editar manualmente.',
    '// Se conservan los códigos y las descripciones abreviadas del informe original.',
    'window.A4_PRODUCT_CATALOG = [',
    catalog.map((product) => `  ${JSON.stringify(product)}`).join(',\n'),
    '];',
    '',
  ].join('\n');
  fs.writeFileSync(outputPath, output, 'utf8');
  return {
    source: path.basename(inputPath),
    encoding: bytes.every((byte) => byte < 128) ? 'ASCII (UTF-8 compatible)' : 'UTF-8',
    rows,
    products: catalog.length,
    duplicates,
    lengths,
    checksum,
  };
}

if (require.main === module) {
  if (!process.argv[2]) {
    console.error('Uso: node scripts/import-products.cjs <informe.txt> [productos.js]');
    process.exitCode = 1;
  } else {
    try {
      const output = process.argv[3] || path.resolve(__dirname, '..', 'productos.js');
      console.log(JSON.stringify(importReport(process.argv[2], output), null, 2));
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}

module.exports = { importReport };

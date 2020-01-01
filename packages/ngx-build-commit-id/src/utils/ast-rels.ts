import { tsquery } from '@phenomnomnominal/tsquery';
import * as ts from 'typescript';

export function hasImport(importName: string, ast: ts.SourceFile) {
  return tsquery.query(ast, `ImportSpecifier:has(Identifier[name=${importName}])`).length === 0;
}
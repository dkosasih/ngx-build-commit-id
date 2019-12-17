import { BuilderContext, BuilderOutput, createBuilder } from '@angular-devkit/architect';
import { json, getSystemPath, normalize } from '@angular-devkit/core';
import { tsquery } from '@phenomnomnominal/tsquery';
import { of, Observable, bindNodeCallback } from 'rxjs';
import { map, tap, catchError } from 'rxjs/operators';
import { writeFile, writeFileSync, readFileSync } from 'fs';
import * as ts from 'typescript';
import { dedent } from 'ts-lint/lib/utils';
import { verify } from 'crypto';

const util = require('util');
const exec = util.promisify(require('child_process').exec);

export interface CommitBuilderSchema {
    // purposely left empty for future extension
}

function runBuilder(
    _schema: CommitBuilderSchema,
    context: BuilderContext
): Observable<BuilderOutput> {
    createVersionsFile(`${getSystemPath(normalize(context.workspaceRoot))}/src/environments/versions.ts`);
    
    const filename = `${getSystemPath(normalize(context.workspaceRoot))}/src/app/app.component.ts`;
    const transformedContent = modifyComponent(filename);
    
    const writeFileObservable = bindNodeCallback(writeFile);
    const logger = context.logger.createChild('CommitBuilder');
    
    return writeFileObservable(filename, transformedContent).pipe(
        map(() => ({ success: true })),
        tap(() => logger.info('app.component modified')),
        catchError(e => {
            logger.error('Failed to modify app.component', e);
            return of({ success: false });
        })
    );
}

const transformer  = <T extends ts.Node>(context: ts.TransformationContext) => {
    return (rootNode: T) => {
        // visit() function will visit all the descendants node (recursively)  
        function visit(node: ts.Node): ts.Node {
            node = ts.visitEachChild(node, visit, context);

            if (node.kind === ts.SyntaxKind.ClassDeclaration) {
                const oldClass = node as ts.ClassDeclaration;
                const consoleColorSetting = 'background-color: darkblue; color: white;';

                // return if already has the console log about version
                const versionLog = tsquery.query(node, `constructor:has(StringLiteral[value='${consoleColorSetting}'])`);
                if (versionLog.length > 0) {
                    return node;
                }

                // try to get old constructor and replace it - otherwise create new one for it
                const queryConstructor = tsquery.query(node, 'Constructor'); 
                const oldConstructor = queryConstructor.length > 0 ? queryConstructor[0] as ts.ConstructorDeclaration : null;

                const singleQuoteStringLiteral = ts.createStringLiteral(consoleColorSetting);
                (singleQuoteStringLiteral as any).singleQuote = true;

                const statement = ts.createExpressionStatement(
                    ts.createCall(
                        ts.createPropertyAccess(
                            ts.createIdentifier('console'),
                            'info'
                        ),
                        undefined,
                        [
                            ts.createTemplateExpression(
                                ts.createTemplateHead('%c Running revision: '),
                                [
                                    ts.createTemplateSpan(
                                        ts.createPropertyAccess(
                                            ts.createIdentifier('versions'),
                                            'revision'
                                        ),
                                        ts.createTemplateMiddle('; Branch: ')
                                    ),
                                    ts.createTemplateSpan(
                                        ts.createPropertyAccess(
                                            ts.createIdentifier('versions'),
                                            'branch'
                                        ),
                                        ts.createTemplateTail(' ')
                                    )
                                ]
                            ),
                            singleQuoteStringLiteral
                        ]
                    )
                );

                const newStatements = oldConstructor ? [statement, ...oldConstructor?.body.statements] : [statement];
                const bodyBlock = ts.createBlock(newStatements, true);
                const newConstructor = ts.createConstructor(
                    oldConstructor?.decorators,
                    oldConstructor?.modifiers,
                    oldConstructor?.parameters,
                    bodyBlock
                );

                const newClass = ts.createClassDeclaration(
                    oldClass.decorators,
                    oldClass.modifiers,
                    oldClass.name,
                    oldClass.typeParameters,
                    oldClass.heritageClauses,
                    [newConstructor, ...oldClass.members.filter(x=>x.kind !== ts.SyntaxKind.Constructor)]
                );
                return newClass;
            }

            return node;
        }
        
        return ts.visitNode(rootNode, visit)
    }
}  

function modifyComponent(path: string) {
    let ast = ts.createSourceFile(
        path, readFileSync(path).toString(), ts.ScriptTarget.ES2015, true, ts.ScriptKind.TS
    );

    if (tsquery.query(ast, 'ImportSpecifier:has(Identifier[name=versions])').length === 0) {
        ast = ts.createSourceFile(
            ast.fileName,
            'import { versions } from \'../environments/versions\';' + ast.text,
            ts.ScriptTarget.ES2015,
            true,
            ts.ScriptKind.TS
        )
    }

    const transformedAst = ts.transform<ts.SourceFile>(ast, [transformer]);
    const printer = ts.createPrinter();
    const astSourceString = printer.printFile(transformedAst.transformed[0]);

    return astSourceString;
}

async function createVersionsFile(path: string) {
    const revision = (await exec('git rev-parse --short HEAD')).stdout.toString().trim();
    const branch = (await exec('git rev-parse --abbrev-ref HEAD')).stdout.toString().trim();
  
    console.log(`version: '${process.env.npm_package_version}', revision: '${revision}', branch: '${branch}'`);
  
    const content = dedent`
        // This is an automatically generated file - and should be listed in .gitignore
        export const versions = {
          version: '${process.env.npm_package_version}',
          revision: '${revision}',
          branch: '${branch}'
        };`;
  
    writeFileSync(path, content, {encoding: 'utf8'});
  }

export default createBuilder<json.JsonObject & CommitBuilderSchema>(runBuilder);

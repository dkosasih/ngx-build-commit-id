import { BuilderContext, BuilderOutput, createBuilder } from '@angular-devkit/architect';
import { json, getSystemPath, normalize, JsonObject } from '@angular-devkit/core';
import { tsquery } from '@phenomnomnominal/tsquery';
import { of, Observable, bindNodeCallback, from } from 'rxjs';
import { map, tap, catchError, concatMap } from 'rxjs/operators';
import { writeFile, writeFileSync, readFileSync } from 'fs';
import * as ts from 'typescript';
import { dedent } from 'ts-lint/lib/utils';
import { hasImport } from './utils/ast-rels';

const util = require('util');
const exec = util.promisify(require('child_process').exec);

export interface CommitBuilderSchema extends JsonObject {
    environmentPath: string;
    componentPath: string;
}
  
function runBuilder(
    schema: CommitBuilderSchema,
    context: BuilderContext
): Observable<BuilderOutput> {    
    const versionFilePath = `${getSystemPath(normalize(context.workspaceRoot))}/${schema.environmentPath}/versions`;
    const componentPath = `${getSystemPath(normalize(context.workspaceRoot))}/${schema.componentPath}`;
    
    const transformedContent = modifyComponent(componentPath, findRelativePathToAFile(componentPath, versionFilePath));
    
    const writeFileObservable = bindNodeCallback(writeFile);
    const logger = context.logger.createChild('CommitBuilder');
    
    return from(createVersionsFile(
        versionFilePath
    )).pipe(
        tap(() => logger.info(`Creating versions file in ${getSystemPath(normalize(context.workspaceRoot))}/${schema.environmentPath}/versions.ts`)),
        concatMap(c => writeFileObservable(componentPath, transformedContent).pipe(
            map(() => ({ success: true })),
            tap(() => logger.info(`Amend revision log to ${componentPath}`))
        )),
        catchError(e => {
            logger.error('Failed to create build id', e);
            return of({ success: false });
        })
    );
}

function modifyComponent(path: string, relativeVersionFilePath: string) {
    let ast = ts.createSourceFile(
        path, readFileSync(path).toString(), ts.ScriptTarget.ES2015, true, ts.ScriptKind.TS
    );

    if (hasImport('versions', ast)) {
        ast = ts.createSourceFile(
            ast.fileName,
            `import { versions } from '${relativeVersionFilePath}'; ${ast.text}`,
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

function findRelativePathToAFile(filePath: string, fileToReference: string): string {
    let filePathArray = filePath.split(/[\\\/]/);
    let fileToReferenceArray = fileToReference.split(/[\\\/]/);

    const numberToSlice = findNumberOfLayerToSlice(filePathArray, fileToReferenceArray);

    filePathArray = filePathArray.slice(numberToSlice);
    fileToReferenceArray = fileToReferenceArray.slice(numberToSlice);
   
    if (filePathArray.length === 1) {
        return `./${fileToReferenceArray.join('/')}`
    } 

    let resultPath = '';
    filePathArray.forEach((val, i) => {
        resultPath += i < filePathArray.length - 1 ? '../' : '';
    });

    return resultPath +  fileToReferenceArray.join('/');     
}

function findNumberOfLayerToSlice(filePathArray: string[], fileToReferenceArray: string[]): number {
    let index: number;
    for (index = 0; index < filePathArray.length - 1; index++) {
        if (fileToReferenceArray.length >= index + 1 &&
            fileToReferenceArray[index] !== filePathArray[index]) {
            break;
        }
    }
    return index;
}

function transformer<T extends ts.Node>(context: ts.TransformationContext) {
    return (rootNode: T) => {
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
                    [newConstructor, ...oldClass.members.filter(x => x.kind !== ts.SyntaxKind.Constructor)]
                );
                return newClass;
            }

            return node;
        }
        
        return ts.visitNode(rootNode, visit)
    }
}  

async function createVersionsFile(path: string) {
    const revision = (await exec('git rev-parse --short HEAD')).stdout.toString().trim();
    const branch = (await exec('git rev-parse --abbrev-ref HEAD')).stdout.toString().trim();
  
    const content = dedent`
        // This is an automatically generated file - and should be listed in .gitignore
        export const versions = {
          version: '${process.env.npm_package_version}',
          revision: '${revision}',
          branch: '${branch}'
        };`;
  
    writeFileSync(path, content, { encoding: 'utf8' });
}

export default createBuilder<json.JsonObject & CommitBuilderSchema>(runBuilder);

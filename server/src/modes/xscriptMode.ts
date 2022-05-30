
import * as lsp from 'vscode-languageserver-protocol';
//import * as shared from '@volar/shared';

import { URI } from 'vscode-uri';
import * as path from 'path';
import * as upath from 'upath';

//import { LanguageService as TSLanguageService  } from '@volar/typescript-language-service';
import { HTMLDocumentRegions } from '../embeddedSupport';
import { LanguageModelCache } from '../languageModelCache';
import { LanguageMode, Diagnostic, Position, Workspace } from '../languageModes';

import type * as ts from 'typescript/lib/tsserverlibrary';
import { TextDocument } from 'vscode-languageserver-textdocument';

export function getXScriptMode(
	{ typescript: ts }: { typescript: typeof import('typescript/lib/tsserverlibrary'); },
	/*host: ts.LanguageServiceHost,*/
	tsLanguageService: ts.LanguageService,/*,
	documentRegions: LanguageModelCache<HTMLDocumentRegions>*/
	workspace: Workspace
): LanguageMode {
	/*function getTextDocument(uri: string) {
		const fileName = upath.toUnix(URI.parse(uri).fsPath);
		if (!tsLanguageService.getProgram()?.getSourceFile(fileName)) {
			return;
		}				
		
		const version = 0;//host.getScriptVersion(fileName);
		//const embedded = documentRegions.get(document).getEmbeddedDocument('css');
		//const scriptSnapshot = host.getScriptSnapshot(fileName);

		//if (scriptSnapshot) {
			//const scriptText = scriptSnapshot.getText(0, scriptSnapshot.getLength());
			const document:TextDocument = documentRegions.get(document);
			const scriptText = scriptSnapshot.getText(0, scriptSnapshot.getLength());
			const syntax = path.extname(uri).slice(1);
			let languageId = '';
			switch (syntax) {
				case 'js': 
					languageId = 'javascript'; 
					break;
				case 'ts': 
					languageId = 'typescript';
					break;
				case 'xscript': 
					languageId = 'xscript';
					break;
				case 'xadl': 
				case 'xfdl':
				case 'xjs':
					languageId = 'nexacro';
					break;
			}

			return TextDocument.create(uri, languageId, 0, scriptText);
		//}
	}*/

	return {
		getId() {
			return 'xscript';
		},
		async doValidation(document: TextDocument, settings = workspace.settings): Promise<Diagnostic[]> {
			
			const fileName = upath.toUnix(URI.parse(document.uri).fsPath);
			const program = tsLanguageService.getProgram();
			const sourceFile = program?.getSourceFile(fileName);
			if (!program || !sourceFile) return [];

			let diags: ts.Diagnostic[] = [];

			try {
				//...options.semantic ? program.getSemanticDiagnostics(sourceFile, cancellationToken) : [],
				//...options.syntactic ? program.getSyntacticDiagnostics(sourceFile, cancellationToken) : [],
				//...options.suggestion ? languageService.getSuggestionDiagnostics(fileName) : [],

				diags = diags.concat(program.getDeclarationDiagnostics(sourceFile));
			}
			catch { 
				console.log('catched');
			}
			
			//const embedded = documentRegions.get(document).getEmbeddedDocument('xscript');
			//const stylesheet = tsLanguageService.parseStylesheet(embedded);
			//return tsLanguageService.doValidation(embedded, stylesheet);
			return translateDiagnostics(document, diags);

			function notEmpty<T>(value: T | null | undefined): value is T {
				return value !== null && value !== undefined;
			}

			function translateDiagnostics(document: TextDocument, input: readonly ts.Diagnostic[]) {
				return input.map(diag => translateDiagnostic(diag, document)).filter(notEmpty);
			}
			function translateDiagnostic(diag: ts.Diagnostic, document: TextDocument): lsp.Diagnostic | undefined {
	
				if (diag.start === undefined) return;
				if (diag.length === undefined) return;
	
				const diagnostic: lsp.Diagnostic = {
					range: {
						start: document.positionAt(diag.start),
						end: document.positionAt(diag.start + diag.length),
					},
					severity: translateErrorType(diag.category),
					source: 'ts',
					code: diag.code,
					message: getMessageText(diag),
				};
	
				/*if (diag.relatedInformation) {
					diagnostic.relatedInformation = diag.relatedInformation
						.map(rErr => translateDiagnosticRelated(rErr))
						.filter(notEmpty);
				}*/
				if (diag.reportsUnnecessary) {
					if (diagnostic.tags === undefined) diagnostic.tags = [];
					diagnostic.tags.push(lsp.DiagnosticTag.Unnecessary);
				}
				if (diag.reportsDeprecated) {
					if (diagnostic.tags === undefined) diagnostic.tags = [];
					diagnostic.tags.push(lsp.DiagnosticTag.Deprecated);
				}
	
				return diagnostic;
			}
			/*function translateDiagnosticRelated(diag: ts.Diagnostic): lsp.DiagnosticRelatedInformation | undefined {
	
				if (diag.start === undefined) return;
				if (diag.length === undefined) return;
	
				let document: TextDocument | undefined;
				if (diag.file) {
					document = getTextDocument(URI.file(diag.file.fileName).toString());
				}
				if (!document) return;
	
				const diagnostic: lsp.DiagnosticRelatedInformation = {
					location: {
						uri: document.uri,
						range: {
							start: document.positionAt(diag.start),
							end: document.positionAt(diag.start + diag.length),
						},
					},
					message: getMessageText(diag),
				};
	
				return diagnostic;
			}*/
			function translateErrorType(input: ts.DiagnosticCategory): lsp.DiagnosticSeverity {
				switch (input) {
					case ts.DiagnosticCategory.Warning: return lsp.DiagnosticSeverity.Warning;
					case ts.DiagnosticCategory.Error: return lsp.DiagnosticSeverity.Error;
					case ts.DiagnosticCategory.Suggestion: return lsp.DiagnosticSeverity.Hint;
					case ts.DiagnosticCategory.Message: return lsp.DiagnosticSeverity.Information;
				}
				return lsp.DiagnosticSeverity.Error;
			}
		},
		onDocumentRemoved(_document: TextDocument) { /* nothing to do */ },
		dispose() { /* nothing to do */ }
	};
}

function getMessageText(diag: ts.Diagnostic | ts.DiagnosticMessageChain, level = 0) {
	let messageText = '  '.repeat(level);

	if (typeof diag.messageText === 'string') {
		messageText += diag.messageText;
	}
	else {
		messageText += diag.messageText.messageText;
		if (diag.messageText.next) {
			for (const info of diag.messageText.next) {
				messageText += '\n' + getMessageText(info, level + 1);
			}
		}
	}                       

	return messageText;
}
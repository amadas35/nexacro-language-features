/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { getCSSLanguageService } from 'vscode-css-languageservice';
import {
	DocumentContext, 
	getLanguageService as getHTMLLanguageService, 
	IHTMLDataProvider, 
	ClientCapabilities
} from 'vscode-html-languageservice';

import {
	SelectionRange,
	CompletionItem, CompletionList, Definition, Diagnostic, DocumentHighlight, DocumentLink, FoldingRange, FormattingOptions,
	Hover, Location, Position, Range, SignatureHelp, SymbolInformation, TextEdit,
	Color, ColorInformation, ColorPresentation, WorkspaceEdit,
	WorkspaceFolder
} from 'vscode-languageserver';

import { TextDocument } from 'vscode-languageserver-textdocument';
import { getDocumentRegions, HTMLDocumentRegions } from './embeddedSupport';
import { getHTMLMode } from './modes/htmlMode';
//import { getXScriptMode } from './modes/xscriptMode';
import { getJavaScriptMode } from './modes/javascriptMode';
import { FileSystemProvider } from './requests';

import { getLanguageModelCache, LanguageModelCache } from './languageModelCache';
import { getCSSMode } from './modes/cssMode';
import * as ts from 'typescript/lib/tsserverlibrary';

export {
	WorkspaceFolder, CompletionItem, CompletionList, CompletionItemKind, Definition, Diagnostic, DocumentHighlight, DocumentHighlightKind,
	DocumentLink, FoldingRange, FoldingRangeKind, FormattingOptions,
	Hover, Location, Position, Range, SignatureHelp, SymbolInformation, SymbolKind, TextEdit,
	Color, ColorInformation, ColorPresentation, WorkspaceEdit,
	SignatureInformation, ParameterInformation, DiagnosticSeverity,
	SelectionRange, TextDocumentIdentifier
} from 'vscode-languageserver';

export * from 'vscode-html-languageservice';

export { TextDocument } from 'vscode-languageserver-textdocument';

export interface Settings {
	css?: any;
	html?: any;
	nexacro?: any;
	javascript?: any;
	xscript?: any;
}

export interface Workspace {
	readonly settings: Settings;
	readonly folders: WorkspaceFolder[];
}

export interface SemanticTokenData {
	start: Position;
	length: number;
	typeIdx: number;
	modifierSet: number;
}

export interface LanguageMode {
	getId(): string;
	getSelectionRange?: (document: TextDocument, position: Position) => Promise<SelectionRange>;
	doValidation?: (document: TextDocument, settings?: Settings) => Promise<Diagnostic[]>;
	doComplete?: (document: TextDocument, position: Position, documentContext: DocumentContext, settings?: Settings) => Promise<CompletionList>;
	doResolve?: (document: TextDocument, item: CompletionItem) => Promise<CompletionItem>;
	doHover?: (document: TextDocument, position: Position, settings?: Settings) => Promise<Hover | null>;
	doSignatureHelp?: (document: TextDocument, position: Position) => Promise<SignatureHelp | null>;
	doRename?: (document: TextDocument, position: Position, newName: string) => Promise<WorkspaceEdit | null>;
	doLinkedEditing?: (document: TextDocument, position: Position) => Promise<Range[] | null>;
	findDocumentHighlight?: (document: TextDocument, position: Position) => Promise<DocumentHighlight[]>;
	findDocumentSymbols?: (document: TextDocument) => Promise<SymbolInformation[]>;
	findDocumentLinks?: (document: TextDocument, documentContext: DocumentContext) => Promise<DocumentLink[]>;
	findDefinition?: (document: TextDocument, position: Position) => Promise<Definition | null>;
	findReferences?: (document: TextDocument, position: Position) => Promise<Location[]>;
	format?: (document: TextDocument, range: Range, options: FormattingOptions, settings?: Settings) => Promise<TextEdit[]>;
	findDocumentColors?: (document: TextDocument) => Promise<ColorInformation[]>;
	getColorPresentations?: (document: TextDocument, color: Color, range: Range) => Promise<ColorPresentation[]>;
	doAutoInsert?: (document: TextDocument, position: Position, kind: 'autoClose' | 'autoQuote') => Promise<string | null>;
	findMatchingTagPosition?: (document: TextDocument, position: Position) => Promise<Position | null>;
	getFoldingRanges?: (document: TextDocument) => Promise<FoldingRange[]>;
	onDocumentRemoved(document: TextDocument): void;
	getSemanticTokens?(document: TextDocument): Promise<SemanticTokenData[]>;
	getSemanticTokenLegend?(): { types: string[]; modifiers: string[] };
	dispose(): void;
}

export interface LanguageModes {
	updateDataProviders(dataProviders: IHTMLDataProvider[]): void;
	getModeAtPosition(document: TextDocument, position: Position): LanguageMode | undefined;
	getModesInRange(document: TextDocument, range: Range): LanguageModeRange[];
	getAllModes(): LanguageMode[];
	getAllModesInDocument(document: TextDocument): LanguageMode[];
	getMode(languageId: string): LanguageMode | undefined;
	onDocumentRemoved(document: TextDocument): void;
	dispose(): void;
}

export interface LanguageModeRange extends Range {
	mode: LanguageMode | undefined;
	attributeValue?: boolean;
}

export function getLanguageModes( workspace: Workspace, clientCapabilities: ClientCapabilities, requestService: FileSystemProvider): LanguageModes {
	const htmlLanguageService = getHTMLLanguageService({ clientCapabilities, fileSystemProvider: requestService });
	const cssLanguageService = getCSSLanguageService({ clientCapabilities, fileSystemProvider: requestService });

	const documentRegions = getLanguageModelCache<HTMLDocumentRegions>(10, 60, document =>
		getDocumentRegions(htmlLanguageService, document)
	);

	let modelCaches: LanguageModelCache<any>[] = [];
	modelCaches.push(documentRegions);
	

	let modes = Object.create(null);
	modes['nexacro'] = getHTMLMode(htmlLanguageService, workspace);
	modes['css'] = getCSSMode(cssLanguageService, documentRegions, workspace);
	//modes['xscript'] = getXScriptMode({ typescript: ts }, tsLanguageService);
	modes['xscript'] 	= getJavaScriptMode(documentRegions, 'xscript', workspace);
	modes['javascript'] = getJavaScriptMode(documentRegions, 'javascript', workspace);
	modes['typescript'] = getJavaScriptMode(documentRegions, 'typescript', workspace);

	return {
		async updateDataProviders(dataProviders: IHTMLDataProvider[]): Promise<void> {
			htmlLanguageService.setDataProviders(true, dataProviders);
		},
		getModeAtPosition(
			document: TextDocument,
			position: Position
		): LanguageMode | undefined {
			const languageId = documentRegions.get(document).getLanguageAtPosition(position);
			if (languageId) {
				return modes[languageId];
			}
			return undefined;
		},
		getModesInRange(document: TextDocument, range: Range): LanguageModeRange[] {
			return documentRegions
				.get(document)
				.getLanguageRanges(range)
				.map(r => {
					return <LanguageModeRange>{
						start: r.start,
						end: r.end,
						mode: r.languageId && modes[r.languageId],
						attributeValue: r.attributeValue
					};
				});
		},
		getAllModesInDocument(document: TextDocument): LanguageMode[] {
			const result = [];
			for (const languageId of documentRegions.get(document).getLanguagesInDocument()) {
				const mode = modes[languageId];
				if (mode) {
					result.push(mode);
				}
			}
			return result;
		},
		getAllModes(): LanguageMode[] {
			const result = [];
			for (const languageId in modes) {
				const mode = modes[languageId];
				if (mode) {
					result.push(mode);
				}
			}
			return result;
		},
		getMode(languageId: string): LanguageMode {
			return modes[languageId];
		},
		onDocumentRemoved(document: TextDocument) {
			modelCaches.forEach(mc => mc.onDocumentRemoved(document));
			for (const mode in modes) {
				modes[mode].onDocumentRemoved(document);
			}
		},
		dispose(): void {
			modelCaches.forEach(mc => mc.dispose());
			modelCaches = [];
			for (const mode in modes) {
				modes[mode].dispose();
			}
			modes = {};
		}
	};
}

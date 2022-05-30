/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import {
	CompletionList,
	ClientCapabilities,
	ConfigurationRequest,
	ConfigurationParams,
	ColorPresentationRequest,
	createConnection,
	Diagnostic,
	DidChangeWorkspaceFoldersNotification,
	Disposable,
	DocumentColorRequest, 
	DocumentFormattingRequest,
	DocumentRangeFormattingRequest,
	InitializeParams,
	InitializeResult,
	NotificationType,
	ProposedFeatures,
	RequestType,
	RequestType0,
	ServerCapabilities,
	TextDocuments,
	TextDocumentSyncKind
} from 'vscode-languageserver/node';

import { pushAll } from './utils/arrays';
import { getDocumentContext } from './utils/documentContext';
import { URI } from 'vscode-uri';
import { formatError, runSafe } from './utils/runner';

import { getLanguageModes, LanguageModes, Position, Settings, WorkspaceFolder, 
	ColorInformation, Range, DocumentLink, SymbolInformation, TextDocumentIdentifier 
} from './languageModes';
import { TextDocument } from 'vscode-languageserver-textdocument';

import * as path from 'upath';
import * as ts from 'typescript/lib/tsserverlibrary';

import { fetchHTMLDataProviders } from './customData';
import { SemanticTokenProvider, newSemanticTokenProvider } from './modes/semanticTokens';
import { FileSystemProvider, getFileSystemProvider } from './requests';
import { getNodeFileFS } from './nodeFs';

namespace CustomDataChangedNotification {
	export const type: NotificationType<string[]> = new NotificationType('nexacro/customDataChanged');
}

namespace CustomDataContent {
	export const type: RequestType<string, string, any> = new RequestType('nexacro/customDataContent');
}

interface AutoInsertParams {
	/**
	 * The auto insert kind
	 */
	kind: 'autoQuote' | 'autoClose';
	/**
	 * The text document.
	 */
	textDocument: TextDocumentIdentifier;
	/**
	 * The position inside the text document.
	 */
	position: Position;
}

namespace AutoInsertRequest {
	export const type: RequestType<AutoInsertParams, string, any> = new RequestType('nexacro/autoInsert');
}

// experimental: semantic tokens
interface SemanticTokenParams {
	textDocument: TextDocumentIdentifier;
	ranges?: Range[];
}
namespace SemanticTokenRequest {
	export const type: RequestType<SemanticTokenParams, number[] | null, any> = new RequestType('nexacro/semanticTokens');
}
namespace SemanticTokenLegendRequest {
	export const type: RequestType0<{ types: string[]; modifiers: string[] } | null, any> = new RequestType0('nexacro/semanticTokenLegend');
}

export interface RuntimeEnvironment {
	fileFs?: FileSystemProvider;
	configureHttpRequests?(proxy: string | undefined, strictSSL: boolean): void;
	readonly timer: {
		setImmediate(callback: (...args: any[]) => void, ...args: any[]): Disposable;
		setTimeout(callback: (...args: any[]) => void, ms: number, ...args: any[]): Disposable;
	};
}

export interface CustomDataRequestService {
	getContent(uri: string): Promise<string>;
}

// Create a connection for the server. The connection uses Node's IPC as a transport.
// Also include all preview / proposed LSP features.
const connection = createConnection(ProposedFeatures.all);

console.log = connection.console.log.bind(connection.console);
console.error = connection.console.error.bind(connection.console);

process.on('unhandledRejection', (e: any) => {
	connection.console.error(formatError(`Unhandled exception`, e));
});

// Create a simple text document manager. The text document manager
// supports full document sync only
const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

let languageModes: LanguageModes;

let globalSettings: Settings = { html: { validate: true}, nexacro: { validate: true}, xscript: { validate: true}, javascript: { validate: true} };
let documentSettings: { [key: string]: Thenable<Settings> } = {};

let clientCapabilities: ClientCapabilities;
let workspaceFolders: WorkspaceFolder[] = [];

let clientSnippetSupport = false;
let dynamicFormatterRegistration = false;
let scopedSettingsSupport = false;
let workspaceFoldersSupport = false;
let foldingRangeLimit = Number.MAX_VALUE;
let formatterMaxNumberOfEdits = Number.MAX_VALUE;

const customDataRequestService: CustomDataRequestService = {
	getContent(uri: string) {
		return connection.sendRequest(CustomDataContent.type, uri);
	}
};

function loadTypescript(serverPath:string) : typeof import('typescript/lib/tsserverlibrary') {
	return require(path.toUnix(serverPath));
}

const runtime: RuntimeEnvironment = {
	timer: {
		setImmediate(callback: (...args: any[]) => void, ...args: any[]): Disposable {
			const handle = setImmediate(callback, ...args);
			return { dispose: () => clearImmediate(handle) };
		},
		setTimeout(callback: (...args: any[]) => void, ms: number, ...args: any[]): Disposable {
			const handle = setTimeout(callback, ms, ...args);
			return { dispose: () => clearTimeout(handle) };
		}
	},
	fileFs: getNodeFileFS()
};

function getDocumentSettings(textDocument: TextDocument, needsDocumentSettings: () => boolean): Thenable<Settings | undefined> {
	if (scopedSettingsSupport && needsDocumentSettings()) {
		let promise = documentSettings[textDocument.uri];
		if (!promise) {
			const scopeUri = textDocument.uri;
			const configRequestParam: ConfigurationParams = { items: [{ scopeUri, section: 'css' }, { scopeUri, section: 'html' }, { scopeUri, section: 'nexacro' }, { scopeUri, section: 'javascript' }, { scopeUri, section: 'xscript' }] };
			promise = connection.sendRequest(ConfigurationRequest.type, configRequestParam).then(s => ({ css: s[0], html: s[1], nexacro: s[2], javascript: s[3], xscript: s[4] }));
			documentSettings[textDocument.uri] = promise;
		}
		return promise;
	}
	return Promise.resolve(undefined);
}

connection.onInitialize((_params: InitializeParams) => {

	const initializationOptions = _params.initializationOptions;

	workspaceFolders = (<any>_params).workspaceFolders;
	if (!Array.isArray(workspaceFolders)) {
		workspaceFolders = [];
		if (_params.rootPath) {
			workspaceFolders.push({ name: '', uri: URI.file(_params.rootPath).toString() });
		}
	}

	const handledSchemas = initializationOptions?.handledSchemas as string[] ?? ['file'];

	const fileSystemProvider = getFileSystemProvider(handledSchemas, connection, runtime);

	const workspace = {
		get settings() { return globalSettings; },
		get folders() { return workspaceFolders; }
	};
	
	clientCapabilities = _params.capabilities;

	/*const result: InitializeResult = {
		capabilities: {
			textDocumentSync: TextDocumentSyncKind.Full,
			// Tell the client that the server supports code completion
			completionProvider: {
				resolveProvider: true
			}
		}
	};*/

	languageModes = getLanguageModes(workspace, clientCapabilities, fileSystemProvider);

	documents.onDidClose(e => {
		languageModes.onDocumentRemoved(e.document);
		//delete documentSettings[e.document.uri];
	});
	connection.onShutdown(() => {
		connection.console.log(`onShutdown`);
		languageModes.dispose();
	});

	function getClientCapability<T>(name: string, def: T) {
		const keys = name.split('.');
		let c: any = clientCapabilities;
		for (let i = 0; c && i < keys.length; i++) {
			if (!Object.prototype.hasOwnProperty.call(c, keys[i])) {
				return def;
			}
			c = c[keys[i]];
		}
		return c;
	}

	clientSnippetSupport = getClientCapability('textDocument.completion.completionItem.snippetSupport', false);
	dynamicFormatterRegistration = getClientCapability('textDocument.rangeFormatting.dynamicRegistration', false) && (typeof initializationOptions?.provideFormatter !== 'boolean');
	scopedSettingsSupport = getClientCapability('workspace.configuration', false);
	workspaceFoldersSupport = getClientCapability('workspace.workspaceFolders', false);
	foldingRangeLimit = getClientCapability('textDocument.foldingRange.rangeLimit', Number.MAX_VALUE);
	formatterMaxNumberOfEdits = _params.initializationOptions?.customCapabilities?.rangeFormatting?.editLimit || Number.MAX_VALUE;
	const capabilities: ServerCapabilities = {
		textDocumentSync: TextDocumentSyncKind.Incremental,
		completionProvider: clientSnippetSupport ? { resolveProvider: true, triggerCharacters: ['.', ':', '<', '"', '=', '/'] } : undefined,
		hoverProvider: true,
		documentHighlightProvider: true,
		documentRangeFormattingProvider: _params.initializationOptions?.provideFormatter === true,
		documentFormattingProvider: _params.initializationOptions?.provideFormatter === true,
		documentLinkProvider: { resolveProvider: false },
		documentSymbolProvider: true,
		definitionProvider: true,
		signatureHelpProvider: { triggerCharacters: ['('] },
		referencesProvider: true,
		colorProvider: {},
		foldingRangeProvider: true,
		selectionRangeProvider: true,
		renameProvider: true,
		linkedEditingRangeProvider: true
	};
	return { capabilities };

	//return result;
});

connection.onInitialized(() => {
	if (workspaceFoldersSupport) {
		connection.client.register(DidChangeWorkspaceFoldersNotification.type);

		connection.onNotification(DidChangeWorkspaceFoldersNotification.type, e => {
			const toAdd = e.event.added;
			const toRemove = e.event.removed;
			const updatedFolders = [];
			if (workspaceFolders) {
				for (const folder of workspaceFolders) {
					if (!toRemove.some(r => r.uri === folder.uri) && !toAdd.some(r => r.uri === folder.uri)) {
						updatedFolders.push(folder);
					}
				}
			}
			workspaceFolders = updatedFolders.concat(toAdd);
			documents.all().forEach(triggerValidation);
		});
	}
});

let formatterRegistrations: Thenable<Disposable>[] | null = null;

// The settings have changed. Is send on server activation as well.
connection.onDidChangeConfiguration((change) => {
	globalSettings = change.settings;
	documentSettings = {}; // reset all document settings
	documents.all().forEach(triggerValidation);

	// dynamically enable & disable the formatter
	if (dynamicFormatterRegistration) {
		const enableFormatter = globalSettings && globalSettings.html && globalSettings.html.format && globalSettings.html.format.enable;
		if (enableFormatter) {
			if (!formatterRegistrations) {
				const documentSelector = [{ language: 'nexacro' }];
				formatterRegistrations = [
					connection.client.register(DocumentRangeFormattingRequest.type, { documentSelector }),
					connection.client.register(DocumentFormattingRequest.type, { documentSelector })
				];
			}
		} else if (formatterRegistrations) {
			formatterRegistrations.forEach(p => p.then(r => r.dispose()));
			formatterRegistrations = null;
		}
	}
});

const pendingValidationRequests: { [uri: string]: Disposable } = {};
const validationDelayMs = 500;

// The content of a text document has changed. This event is emitted
// when the text document first opened or when its content has changed.
documents.onDidChangeContent(change => {
	triggerValidation(change.document);
});

documents.onDidClose(event => {
	cleanPendingValidation(event.document);
	connection.sendDiagnostics({ uri: event.document.uri, diagnostics: [] });
});

function cleanPendingValidation(textDocument: TextDocument): void {
	const request = pendingValidationRequests[textDocument.uri];
	if (request) {
		request.dispose();
		delete pendingValidationRequests[textDocument.uri];
	}
}

function triggerValidation(textDocument: TextDocument): void {
	cleanPendingValidation(textDocument);
	pendingValidationRequests[textDocument.uri] = runtime.timer.setTimeout(() => {
		delete pendingValidationRequests[textDocument.uri];
		validateTextDocument(textDocument);
	}, validationDelayMs);
}

function isValidationEnabled(languageId: string, settings: Settings = globalSettings) {
	const validationSettings = settings && (settings.html && settings.html.validate || settings.nexacro && settings.nexacro.validate);
	if (validationSettings) {
		return languageId === 'css' && validationSettings.styles !== false || (languageId === 'javascript' || languageId === 'xscript') && validationSettings.scripts !== false;
	}
	return true;
}

async function validateTextDocument(textDocument: TextDocument) {
	try {
		const version = textDocument.version;
		const diagnostics: Diagnostic[] = [];
		if (textDocument.languageId === 'nexacro') {
			const modes = languageModes.getAllModesInDocument(textDocument);
			const settings = await getDocumentSettings(textDocument, () => modes.some(m => !!m.doValidation));
			const latestTextDocument = documents.get(textDocument.uri);
			if (latestTextDocument && latestTextDocument.version === version) { // check no new version has come in after in after the async op
				for (const mode of modes) {
					if (mode.doValidation && isValidationEnabled(mode.getId(), settings)) {
						pushAll(diagnostics, await mode.doValidation(latestTextDocument, settings));
					}
				}
				connection.sendDiagnostics({ uri: latestTextDocument.uri, diagnostics });
			}
		}
	} catch (e) {
		connection.console.error(`Error while validating ${textDocument.uri}`);
		connection.console.error(String(e));
	}
}

connection.onCompletion(async (textDocumentPosition, token) => {
	return runSafe(runtime, async () => {
		const document = documents.get(textDocumentPosition.textDocument.uri);
		if (!document) {
			return null;
		}
		const mode = languageModes.getModeAtPosition(document, textDocumentPosition.position);
		if (!mode || !mode.doComplete) {
			return { isIncomplete: true, items: [] };
		}
		const doComplete = mode.doComplete;

		const settings = await getDocumentSettings(document, () => doComplete.length > 2);
		const documentContext = getDocumentContext(document.uri, workspaceFolders);
		return doComplete(document, textDocumentPosition.position, documentContext, settings);

	}, null, `Error while computing completions for ${textDocumentPosition.textDocument.uri}`, token);
});

connection.onCompletionResolve((item, token) => {
	return runSafe(runtime, async () => {
		const data = item.data;
		if (data && data.languageId && data.uri) {
			const mode = languageModes.getMode(data.languageId);
			const document = documents.get(data.uri);
			if (mode && mode.doResolve && document) {
				return mode.doResolve(document, item);
			}
		}
		return item;
	}, item, `Error while resolving completion proposal`, token);
});

connection.onHover((textDocumentPosition, token) => {
	return runSafe(runtime, async () => {
		const document = documents.get(textDocumentPosition.textDocument.uri);
		if (document) {
			const mode = languageModes.getModeAtPosition(document, textDocumentPosition.position);
			const doHover = mode?.doHover;
			if (doHover) {
				const settings = await getDocumentSettings(document, () => doHover.length > 2);
				return doHover(document, textDocumentPosition.position, settings);
			}
		}
		return null;
	}, null, `Error while computing hover for ${textDocumentPosition.textDocument.uri}`, token);
});

connection.onDocumentHighlight((documentHighlightParams, token) => {
	return runSafe(runtime, async () => {
		const document = documents.get(documentHighlightParams.textDocument.uri);
		if (document) {
			const mode = languageModes.getModeAtPosition(document, documentHighlightParams.position);
			if (mode && mode.findDocumentHighlight) {
				return mode.findDocumentHighlight(document, documentHighlightParams.position);
			}
		}
		return [];
	}, [], `Error while computing document highlights for ${documentHighlightParams.textDocument.uri}`, token);
});

connection.onDefinition((definitionParams, token) => {
	return runSafe(runtime, async () => {
		const document = documents.get(definitionParams.textDocument.uri);
		if (document) {
			const mode = languageModes.getModeAtPosition(document, definitionParams.position);
			if (mode && mode.findDefinition) {
				return mode.findDefinition(document, definitionParams.position);
			}
		}
		return [];
	}, null, `Error while computing definitions for ${definitionParams.textDocument.uri}`, token);
});

connection.onReferences((referenceParams, token) => {
	return runSafe(runtime, async () => {
		const document = documents.get(referenceParams.textDocument.uri);
		if (document) {
			const mode = languageModes.getModeAtPosition(document, referenceParams.position);
			if (mode && mode.findReferences) {
				return mode.findReferences(document, referenceParams.position);
			}
		}
		return [];
	}, [], `Error while computing references for ${referenceParams.textDocument.uri}`, token);
});

connection.onSignatureHelp((signatureHelpParms, token) => {
	return runSafe(runtime, async () => {
		const document = documents.get(signatureHelpParms.textDocument.uri);
		if (document) {
			const mode = languageModes.getModeAtPosition(document, signatureHelpParms.position);
			if (mode && mode.doSignatureHelp) {
				return mode.doSignatureHelp(document, signatureHelpParms.position);
			}
		}
		return null;
	}, null, `Error while computing signature help for ${signatureHelpParms.textDocument.uri}`, token);
});

connection.onDocumentLinks((documentLinkParam, token) => {
	return runSafe(runtime, async () => {
		const document = documents.get(documentLinkParam.textDocument.uri);
		const links: DocumentLink[] = [];
		if (document) {
			const documentContext = getDocumentContext(document.uri, workspaceFolders);
			for (const m of languageModes.getAllModesInDocument(document)) {
				if (m.findDocumentLinks) {
					pushAll(links, await m.findDocumentLinks(document, documentContext));
				}
			}
		}
		return links;
	}, [], `Error while document links for ${documentLinkParam.textDocument.uri}`, token);
});

connection.onDocumentSymbol((documentSymbolParms, token) => {
	return runSafe(runtime, async () => {
		const document = documents.get(documentSymbolParms.textDocument.uri);
		const symbols: SymbolInformation[] = [];
		if (document) {
			for (const m of languageModes.getAllModesInDocument(document)) {
				if (m.findDocumentSymbols) {
					pushAll(symbols, await m.findDocumentSymbols(document));
				}
			}
		}
		return symbols;
	}, [], `Error while computing document symbols for ${documentSymbolParms.textDocument.uri}`, token);
});

connection.onRequest(DocumentColorRequest.type, (params, token) => {
	return runSafe(runtime, async () => {
		const infos: ColorInformation[] = [];
		const document = documents.get(params.textDocument.uri);
		if (document) {
			for (const m of languageModes.getAllModesInDocument(document)) {
				if (m.findDocumentColors) {
					pushAll(infos, await m.findDocumentColors(document));
				}
			}
		}
		return infos;
	}, [], `Error while computing document colors for ${params.textDocument.uri}`, token);
});

connection.onRequest(ColorPresentationRequest.type, (params, token) => {
	return runSafe(runtime, async () => {
		const document = documents.get(params.textDocument.uri);
		if (document) {
			const mode = languageModes.getModeAtPosition(document, params.range.start);
			if (mode && mode.getColorPresentations) {
				return mode.getColorPresentations(document, params.color, params.range);
			}
		}
		return [];
	}, [], `Error while computing color presentations for ${params.textDocument.uri}`, token);
});

connection.onRequest(AutoInsertRequest.type, (params, token) => {
	return runSafe(runtime, async () => {
		const document = documents.get(params.textDocument.uri);
		if (document) {
			const pos = params.position;
			if (pos.character > 0) {
				const mode = languageModes.getModeAtPosition(document, Position.create(pos.line, pos.character - 1));
				if (mode && mode.doAutoInsert) {
					return mode.doAutoInsert(document, pos, params.kind);
				}
			}
		}
		return null;
	}, null, `Error while computing auto insert actions for ${params.textDocument.uri}`, token);
});

connection.onRenameRequest((params, token) => {
	return runSafe(runtime, async () => {
		const document = documents.get(params.textDocument.uri);
		const position: Position = params.position;

		if (document) {
			const mode = languageModes.getModeAtPosition(document, params.position);

			if (mode && mode.doRename) {
				return mode.doRename(document, position, params.newName);
			}
		}
		return null;
	}, null, `Error while computing rename for ${params.textDocument.uri}`, token);
});

let semanticTokensProvider: SemanticTokenProvider | undefined;
function getSemanticTokenProvider() {
	if (!semanticTokensProvider) {
		semanticTokensProvider = newSemanticTokenProvider(languageModes);
	}
	return semanticTokensProvider;
}

connection.onRequest(SemanticTokenRequest.type, (params, token) => {
	return runSafe(runtime, async () => {
		const document = documents.get(params.textDocument.uri);
		if (document) {
			return getSemanticTokenProvider().getSemanticTokens(document, params.ranges);
		}
		return null;
	}, null, `Error while computing semantic tokens for ${params.textDocument.uri}`, token);
});

connection.onRequest(SemanticTokenLegendRequest.type, token => {
	return runSafe(runtime, async () => {
		return getSemanticTokenProvider().legend;
	}, null, `Error while computing semantic tokens legend`, token);
});

connection.onNotification(CustomDataChangedNotification.type, dataPaths => {
	fetchHTMLDataProviders(dataPaths, customDataRequestService).then(dataProviders => {
		languageModes.updateDataProviders(dataProviders);
	});
});

// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);

// Listen on the connection
connection.listen();

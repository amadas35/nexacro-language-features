/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { join, basename, dirname, sep } from 'path';
import { readFileSync } from 'fs';

const contents: { [name: string]: string } = {};

const serverFolder = basename(__dirname) === 'dist' ? dirname(__dirname) : dirname(dirname(__dirname));
const TYPESCRIPT_LIB_SOURCE = join(serverFolder, 'node_modules/typescript/lib');
const NEXACRO_TYPES_ROOT = join(serverFolder, 'nexacro-types');

export function loadLibrary(name: string) {
	let content = contents[name];
	if (typeof content !== 'string') {
		let libPath;

		if (name.split(/[/\\]/).indexOf('@types') > -1) {
			libPath = join(serverFolder, name); // from source
		}
		else if (name.startsWith('nexacro')) {
			libPath = join(NEXACRO_TYPES_ROOT, name); 
		}
		else if (name.startsWith('lib.')) {
			libPath = join(TYPESCRIPT_LIB_SOURCE, name); 
		}
		else {
			libPath = join(serverFolder, name); 
		}

		try {
			content = readFileSync(libPath).toString();
		} catch (e: any) {
			console.log(`Unable to load library ${name} at ${libPath}: ${e.message}`);
			content = '';
		}

		contents[name] = content;
	}
	return content;
}

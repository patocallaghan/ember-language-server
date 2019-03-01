import {
  CompletionItem,
  TextDocumentPositionParams
} from 'vscode-languageserver';

import Server from '../server';
import ASTPath from '../glimmer-utils';
import { toPosition } from '../estree-utils';
import { filter } from 'fuzzaldrin';

const { preprocess } = require('@glimmer/syntax');
const { uniqBy } = require('lodash');
const memoize = require('memoizee');
import {
  emberBlockItems,
  emberMustacheItems,
  emberSubExpressionItems
} from './ember-helpers';
import { templateContextLookup } from './template-context-provider';
import { getExtension } from '../utils/file-extension';
import { log } from '../utils/logger';
import {
  isLinkToTarget,
  isMustachePath,
  isBlockPath,
  isSubExpressionPath
} from '../utils/ast-helpers';
import {
  listComponents,
  listMUComponents,
  listPodsComponents,
  listHelpers,
  listRoutes,
  mGetProjectAddonsInfo,
  isTemplatePath
} from '../utils/layout-helpers';

const mTemplateContextLookup = memoize(templateContextLookup, {
  length: 3,
  maxAge: 60000
}); // 1 second
const mListComponents = memoize(listComponents, { length: 1, maxAge: 60000 }); // 1 second
const mListMUComponents = memoize(listMUComponents, {
  length: 1,
  maxAge: 60000
}); // 1 second
const mListPodsComponents = memoize(listPodsComponents, {
  length: 1,
  maxAge: 60000
}); // 1 second
const mListHelpers = memoize(listHelpers, { length: 1, maxAge: 60000 }); // 1 second

const mListRoutes = memoize(listRoutes, { length: 1, maxAge: 60000 });

function mListMURouteLevelComponents(projectRoot: string, fileURI: string) {
  // /**/routes/**/-components/**/*.{js,ts,hbs}
  // we need to get current nesting level and resolve related components
  // only if we have -components under current fileURI template path
  if (!projectRoot || !fileURI) {
    return [];
  }
  return [];
}

const PLACEHOLDER = 'ELSCompletionDummy';
export default class TemplateCompletionProvider {
  constructor(private server: Server) {}
  getAllAngleBracketComponents(root: string, uri: string) {
    return uniqBy(
      []
        .concat(
          mListMUComponents(root),
          mListComponents(root),
          mListPodsComponents(root),
          mListMURouteLevelComponents(root, uri),
          mGetProjectAddonsInfo(root).filter(({detail}: {detail: string}) => {
            return detail === 'component';
          })
        )
        .filter((item: any) => {
          return !item.label.includes('/');
        })
        .map((item: any) => {
          item.label = item.label
            .split('-')
            .reduce((result: string, name: string) => {
              return result + name.charAt(0).toUpperCase() + name.substr(1);
            }, '');
          return item;
        }),
      'label'
    );
  }
  isLooksLikeAngleBracketAutocomplete(firstTextPart: string) {
    if (
      firstTextPart.indexOf('<') !== -1 &&
      firstTextPart.lastIndexOf('>') < firstTextPart.lastIndexOf('<')
    ) {
      return true;
    } else {
      return false;
    }
  }
  provideCompletions(params: TextDocumentPositionParams): CompletionItem[] {
    log('provideCompletions');
    const uri = params.textDocument.uri;

    if (getExtension(params.textDocument) !== '.hbs') {
      return [];
    }
    const project = this.server.projectRoots.projectForUri(uri);
    if (!project) {
      return [];
    }
    const { root } = project;
    let document = this.server.documents.get(uri);
    if (!document) {
      return [];
    }
    let offset = document.offsetAt(params.position);
    log('offset', offset);
    let originalText = document.getText();
    log('originalText', originalText);
    let text =
      originalText.slice(0, offset) +
      PLACEHOLDER +
      originalText.slice(offset);
    let ast: any = {};
    log('originalText', originalText);
    const angleComponents = this.getAllAngleBracketComponents(root, uri);

    // looks like this is an angle-bracked component
    const firstTextPart = originalText.slice(0, offset);
    if (this.isLooksLikeAngleBracketAutocomplete(firstTextPart)) {
      let tmp: any = firstTextPart.split('<').pop();
      return filter(angleComponents, tmp, {
        key: 'label',
        maxResults: 40
      });
    }

    try {
      log('textFor AST', text);
      ast = preprocess(text);
    } catch (e) {
      log('unable to get ast', text);
      return angleComponents;
    }
    let focusPath = ASTPath.toPosition(ast, toPosition(params.position));
    if (!focusPath) {
      log(ast, params.position);
      log('focusPath - exit');
      return [];
    }
    log('go', focusPath);
    let completions: CompletionItem[] = [];
    log('focusPath', focusPath);
    try {
      if (isMustachePath(focusPath)) {
        log('isMustachePath');
        let candidates: any = [
          ...mTemplateContextLookup(root, uri, originalText),
          ...mListComponents(root),
          ...mListMUComponents(root),
          ...mListPodsComponents(root),
          ...mListHelpers(root),
          ...mGetProjectAddonsInfo(root).filter(({detail}: {detail: string}) => {
            return detail === 'component' || detail === 'helper';
          })
        ];
        completions.push(...uniqBy(candidates, 'label'));
        completions.push(...emberMustacheItems);
      } else if (isBlockPath(focusPath)) {
        log('isBlockPath');
        let candidates = [
          ...mTemplateContextLookup(root, uri, originalText),
          ...mListComponents(root),
          ...mListMUComponents(root),
          ...mListPodsComponents(root),
          ...mGetProjectAddonsInfo(root).filter(({detail}: {detail: string}) => {
            return detail === 'component';
          })
        ];
        completions.push(...uniqBy(candidates, 'label'));
        completions.push(...emberBlockItems);
      } else if (isSubExpressionPath(focusPath)) {
        log('isSubExpressionPath');
        let candidates = [
          ...mTemplateContextLookup(root, uri, originalText),
          ...mListHelpers(root),
          ...mGetProjectAddonsInfo(root).filter(({detail}: {detail: string}) => {
            return detail === 'helper';
          })
        ];
        completions.push(...uniqBy(candidates, 'label'));
        completions.push(...emberSubExpressionItems);
      } else if (isLinkToTarget(focusPath)) {
        log('isLinkToTarget');
        completions.push(...mListRoutes(root));
      }
    } catch (e) {
      log('error', e);
    }

    // const normalizedResults = _.uniqueBy(completions, 'label');
    log('normalizedResults', completions);
    // log('getTextPrefix(focusPath)', getTextPrefix(focusPath));
    return filter(completions, getTextPrefix(focusPath), {
      key: 'label',
      maxResults: 40
    });
  }
}

function getTextPrefix({ node: { original = '' } }: ASTPath): string {
  return original.replace(PLACEHOLDER, '');
}

import { Diagnostic, Files } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { getExtension } from './utils/file-extension';
import { log, logDebugInfo } from './utils/logger';
import { Worker } from 'worker_threads';
import Server from './server';
import { Project } from './project';
import { getRequireSupport } from './utils/layout-helpers';
import { extensionsToLint } from './linter-thread';

type FindUp = (name: string, opts: { cwd: string; type: string }) => Promise<string | undefined>;

export interface TemplateLinterError {
  fatal?: boolean;
  moduleId: string;
  rule?: string;
  filePath: string;
  severity: number;
  message: string;
  isFixable?: boolean;
  line?: number;
  column?: number;
  source?: string;
}

type WorkerMessage = {
  id: string;
  error: null | string;
  diagnostics: Diagnostic[];
};

export default class TemplateLinter {
  private _linterCache = new Map<Project, string>();
  private _isEnabled = true;
  private _findUp: FindUp;
  private worker: Worker;

  constructor(private server: Server) {
    if (this.server.options.type === 'worker') {
      this.disable();
    }
  }

  private workerQueue: {
    id: string;
    resolve: (value: Diagnostic[]) => void;
    reject: (reason: string) => void;
    tId: number;
  }[] = [];

  initWorker() {
    if (this.worker) {
      this.workerQueue = [];
    }

    this.worker = new Worker('./linter-thread.ts');
    this.worker.on('message', (message: WorkerMessage) => {
      const q = this.workerQueue.find((q) => q.id === message.id);

      if (q) {
        this.workerQueue = this.workerQueue.filter((q) => q.id !== message.id);
        clearTimeout(q.tId);

        if (message.error !== null) {
          q.reject(message.error);
        } else {
          q.resolve(message.diagnostics);
        }
      }
    });
    this.worker.on('error', () => {
      this.initWorker();
    });
    this.worker.on('exit', () => {
      this.initWorker();
    });
  }

  disable() {
    this._isEnabled = false;
  }

  enable() {
    this._isEnabled = true;
  }

  get isEnabled() {
    return this._isEnabled;
  }

  private getProjectForDocument(textDocument: TextDocument) {
    const ext = getExtension(textDocument);

    if (ext !== null && !extensionsToLint.includes(ext)) {
      return;
    }

    return this.server.projectRoots.projectForUri(textDocument.uri);
  }

  async lint(textDocument: TextDocument): Promise<Diagnostic[] | undefined> {
    if (this._isEnabled === false) {
      return;
    }

    const project = this.getProjectForDocument(textDocument);

    if (!project) {
      return;
    }

    const p: Promise<Diagnostic[]> = new Promise((resolve, reject) => {
      const id = `${project.name}-${textDocument.uri}-${textDocument.version}`;
      const ref = { id, resolve, reject, tId: -1 };

      this.workerQueue.push(ref);

      ref.tId = setTimeout(() => {
        this.workerQueue = this.workerQueue.filter((q) => q !== ref);
      }, 10000) as unknown as number;

      this.worker.postMessage({
        id,
        source: textDocument.getText(),
        filePath: textDocument.uri,
        moduleId: project.name,
      });
    });

    try {
      const diagnostics: Diagnostic[] = await p;

      return diagnostics;
    } catch (e) {
      logDebugInfo(e);

      return [];
    }
  }
  async getFindUp(): Promise<FindUp> {
    if (!this._findUp) {
      const { findUp } = await eval(`import('find-up')`);

      this._findUp = findUp;
    }

    return this._findUp;
  }
  private async templateLintConfig(cwd: string): Promise<string | undefined> {
    const findUp = await this.getFindUp();

    return findUp('.template-lintrc.js', { cwd, type: 'file' });
  }
  private async projectNodeModules(cwd: string): Promise<string | undefined> {
    const findUp = await this.getFindUp();

    return findUp('node_modules', { cwd, type: 'directory' });
  }
  // eslint-disable-next-line @typescript-eslint/explicit-function-return-type
  public async linterForProject(project: Project) {
    return await this.getLinter(project);
  }
  // eslint-disable-next-line @typescript-eslint/explicit-function-return-type
  private async getLinter(project: Project): Promise<string | undefined> {
    if (this._linterCache.has(project)) {
      return this._linterCache.get(project);
    }

    try {
      // don't resolve template-lint (due to resolution error) if no linter config found;
      if (!(await this.templateLintConfig(project.root))) {
        return;
      }

      if (!getRequireSupport()) {
        return;
      }

      const nodePath = await this.projectNodeModules(project.root);

      if (!nodePath || !(await this.server.fs.exists(nodePath))) {
        return;
      }

      const linterPath = await (Files.resolveModulePath(project.root, 'ember-template-lint', nodePath, () => {
        /* intentially empty default callback */
      }) as Promise<string>);

      if (!linterPath) {
        return;
      }

      this._linterCache.set(project, linterPath);

      return linterPath;
    } catch (error) {
      log('Module ember-template-lint not found. ' + error.toString());
    }
  }
}
